import fs from 'node:fs';
import path from 'node:path';

import { runProcess } from './bug-sweep.js';
import { buildNativeSkillCall } from './native-skills.js';

// The feature workflow has two implementation paths after the spec is approved:
// one shot (sdd-developer) or task-by-task TDD (spec-to-task -> feature-tdd).
// Both run in the same live Claude process that wrote the spec.
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

export function resolveFeaturePipeline(value) {
  const pipeline = FEATURE_PIPELINES.find((entry) => entry.id === String(value ?? 'direct').trim());

  if (!pipeline) {
    const error = new Error(`Unknown pipeline "${value}". Use "direct" or "tdd".`);
    error.statusCode = 400;
    throw error;
  }

  return pipeline;
}

// Everything the build needs is derived from the spec the interview wrote in
// the session worktree.
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

// One step is one user turn in the same live session. The skill owns the work
// and the report; the Studio owns publishing and the session lifecycle.
export function buildStepPrompt(step) {
  return buildNativeSkillCall(step.skill, { arguments: step.args.join(' ') });
}

export async function changedFiles(cwd) {
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
