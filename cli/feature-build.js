import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_AGENT_COMMAND,
  buildAgentInvocation,
  buildSpawnSpec,
  normalizeAgentCommand,
  runProcess
} from './bug-sweep.js';
import {
  assertNativeSkillAvailable,
  buildNativeSkillCall,
  resolveNativeSkillAgent
} from './native-skills.js';

// The feature workflow has two implementation paths after the spec is approved:
// one shot (sdd-developer) or task-by-task TDD (spec-to-task -> feature-tdd).
// The studio asks the human which one, then runs the same skills the workflow
// file names. The skill files themselves are never modified.
export const FEATURE_PIPELINES = [
  {
    id: 'direct',
    label: 'Direct implementation',
    skill: 'sdd-developer',
    hint: 'One agent run: implement the spec, review and fix, then verify each story.'
  },
  {
    id: 'tdd',
    label: 'Task-by-task TDD',
    skill: 'feature-tdd',
    hint: 'Split the spec into tasks first, then implement each task with Chicago TDD.'
  }
];

const DEFAULT_BUILD_TIMEOUT_SECONDS = 3600;

export function resolveFeaturePipeline(value) {
  const pipeline = FEATURE_PIPELINES.find((entry) => entry.id === String(value ?? 'direct').trim());

  if (!pipeline) {
    const error = new Error(`Unknown pipeline "${value}". Use "direct" or "tdd".`);
    error.statusCode = 400;
    throw error;
  }

  return pipeline;
}

// Everything the build needs is derived from the spec the interview wrote.
export function describeFeatureBuild({ specPath, cwd = process.cwd() } = {}) {
  const absolute = path.resolve(cwd, String(specPath ?? ''));

  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    const error = new Error('This feature has no spec file yet. Finish the interview first.');
    error.statusCode = 400;
    throw error;
  }

  const directory = path.dirname(absolute);
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  const featurePath = path.join(directory, 'feature.md');
  const featureRelative = path.relative(cwd, featurePath).split(path.sep).join('/');

  return { specPath: absolute, specRelative: relative, featurePath, featureRelative, directory };
}

// The ordered skill invocations for one build. `--no-verify` is the documented
// way both pipelines skip E2E verification, so the checkbox maps to that flag.
export function buildFeatureSteps({ pipeline, specRelative, featureRelative, verify = true }) {
  const resolved = resolveFeaturePipeline(pipeline);
  const verifyFlag = verify ? [] : ['--no-verify'];

  if (resolved.id === 'tdd') {
    return [
      { skill: 'spec-to-task', args: [specRelative], produces: featureRelative },
      { skill: 'feature-tdd', args: [featureRelative, ...verifyFlag] }
    ];
  }

  return [{ skill: 'sdd-developer', args: [specRelative, ...verifyFlag] }];
}

export function buildStepPrompt(step, { verify = true, agentPreset } = {}) {
  const argument = step.args.join(' ');
  const tail = verify
    ? 'Run the E2E verification phase it describes.'
    : 'Skip the E2E verification phase; it is not wanted for this build.';
  const skillCall = buildNativeSkillCall(step.skill, agentPreset, { arguments: argument });

  if (step.skill === 'spec-to-task') {
    return [
      skillCall,
      '',
      `Write \`${step.produces}\` next to the spec, following the skill exactly.`,
      'Do not commit, push, or open a pull request. Print the task breakdown when it is done.'
    ].join('\n');
  }

  return [
    skillCall,
    '',
    `Follow that skill exactly in this repository. ${tail}`,
    'Do not commit, push, or open a pull request. Print the final report when the pipeline is done.'
  ].join('\n');
}

async function changedFiles(cwd) {
  try {
    const result = await runProcess('git', ['status', '--porcelain'], { cwd, timeoutMs: 30000 });

    if (result.code !== 0) {
      return [];
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Run the chosen pipeline one skill at a time, so the UI can show which step is
// running and a failure points at the step that caused it.
export async function runFeatureBuild(request = {}, dependencies = {}) {
  const cwd = dependencies.cwd ?? process.cwd();
  const emit = dependencies.emit ?? (() => {});
  const spawnImpl = dependencies.spawnImpl ?? runProcess;
  const pipeline = resolveFeaturePipeline(request.pipeline);
  const verify = request.verify !== false;
  const described = describeFeatureBuild({ specPath: request.specPath, cwd });
  const steps = buildFeatureSteps({
    pipeline: pipeline.id,
    specRelative: described.specRelative,
    featureRelative: described.featureRelative,
    verify
  });
  const command = normalizeAgentCommand(request.agentCmd ?? DEFAULT_AGENT_COMMAND);
  const agentPreset = resolveNativeSkillAgent(request.agentPreset, command);
  for (const step of steps) assertNativeSkillAvailable(cwd, agentPreset, step.skill);
  const timeoutSeconds = Number(dependencies.timeoutSeconds) > 0
    ? Number(dependencies.timeoutSeconds)
    : DEFAULT_BUILD_TIMEOUT_SECONDS;

  if (dependencies.signal?.aborted) {
    const error = new Error('The build was cancelled.');
    error.cancelled = true;
    throw error;
  }

  emit({
    type: 'build-started',
    pipeline: pipeline.id,
    verify,
    spec: described.specRelative,
    steps: steps.map((step) => ({ skill: step.skill, args: step.args }))
  });

  const results = [];
  let featureSnapshot = fs.existsSync(described.featurePath)
    ? fs.statSync(described.featurePath).mtimeMs
    : 0;

  for (const [index, step] of steps.entries()) {
    emit({ type: 'build-step', index, skill: step.skill, status: 'running' });

    const prompt = buildStepPrompt(step, { verify, agentPreset });
    const invocation = buildAgentInvocation(command, { prompt });
    const spec = buildSpawnSpec(invocation);

    let result;

    try {
      result = await spawnImpl(spec.command, spec.args, {
        cwd,
        signal: dependencies.signal,
        timeoutMs: timeoutSeconds * 1000,
        env: { ...process.env, SDD_BUILD_PIPELINE: pipeline.id, SDD_BUILD_STEP: step.skill },
        onStdout: (chunk) => emit({ type: 'output', stream: 'stdout', step: index, chunk }),
        onStderr: (chunk) => emit({ type: 'output', stream: 'stderr', step: index, chunk })
      });
    } catch (error) {
      if (dependencies.signal?.aborted) {
        const cancelled = new Error('The build was cancelled.');
        cancelled.cancelled = true;
        throw cancelled;
      }

      throw new Error(`The agent could not be started: ${error.message}`);
    }

    if (result.aborted || dependencies.signal?.aborted) {
      const error = new Error('The build was cancelled.');
      error.cancelled = true;
      throw error;
    }

    if (result.timedOut) {
      throw new Error(`${step.skill} did not finish within ${timeoutSeconds} seconds.`);
    }

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');

      throw new Error(`${step.skill} failed (exit ${result.code}).${detail ? ` ${detail}` : ''}`);
    }

    if (step.produces) {
      const exists = fs.existsSync(described.featurePath);
      const mtime = exists ? fs.statSync(described.featurePath).mtimeMs : 0;

      if (!exists) {
        throw new Error(`${step.skill} finished without writing ${step.produces}.`);
      }

      featureSnapshot = mtime;
    }

    emit({ type: 'build-step', index, skill: step.skill, status: 'done' });
    results.push({ skill: step.skill, args: step.args });
  }

  const changed = await changedFiles(cwd);

  emit({ type: 'build-done', changed: changed.length });

  return {
    pipeline: pipeline.id,
    verify,
    specPath: described.specPath,
    featurePath: described.featurePath,
    steps: results,
    verified: verify,
    featureWritten: Boolean(featureSnapshot),
    changedFiles: changed
  };
}
