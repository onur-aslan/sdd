import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_PIPELINES,
  buildFeatureSteps,
  buildStepPrompt,
  changedFiles,
  describeFeatureBuild,
  resolveFeaturePipeline
} from '../cli/feature-build.js';
import { runInterviewSession } from '../cli/agent-session.js';

function makeFeature(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-feature-build-'));
  const dir = path.join(root, 'docs', 'sdd', 'features', 'saved-searches');

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
  for (const skill of ['deep-spec', 'sdd-developer', 'spec-to-task', 'feature-tdd']) {
    const skillFile = path.join(root, '.claude', 'skills', skill, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `---\nname: ${skill}\ndescription: Test fixture skill.\n---\n`, 'utf8');
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'studio@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Studio Bot'], { cwd: root });

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return { root, dir, specPath: path.join(dir, 'spec.md') };
}

function fakeLiveSpawn(reply) {
  return () => {
    const child = new EventEmitter();

    child.pid = 4242;
    child.killed = false;
    child.exitCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.emit('close', 0);
      return true;
    };

    let buffer = '';
    let turn = 0;

    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString();

      let index;

      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();

        buffer = buffer.slice(index + 1);

        if (!line) {
          continue;
        }

        turn += 1;

        const text = reply(turn);

        child.stdout.write(`${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] }
        })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: text
        })}\n`);
      }
    });

    return child;
  };
}

test('the feature workflow has exactly the two documented pipelines', () => {
  assert.deepEqual(FEATURE_PIPELINES.map((entry) => entry.id), ['direct', 'tdd']);
  assert.equal(resolveFeaturePipeline('tdd').skill, 'feature-tdd');
  assert.throws(() => resolveFeaturePipeline('other'), /Unknown pipeline/);
});

test('the pipeline maps the E2E checkbox to --no-verify', () => {
  const direct = buildFeatureSteps({
    pipeline: 'direct',
    specRelative: 'docs/sdd/features/x/spec.md',
    featureRelative: 'docs/sdd/features/x/feature.md',
    verify: true
  });

  assert.deepEqual(direct, [
    { skill: 'sdd-developer', args: ['docs/sdd/features/x/spec.md'] }
  ]);

  const tdd = buildFeatureSteps({
    pipeline: 'tdd',
    specRelative: 'docs/sdd/features/x/spec.md',
    featureRelative: 'docs/sdd/features/x/feature.md',
    verify: false
  });

  assert.deepEqual(tdd, [
    { skill: 'spec-to-task', args: ['docs/sdd/features/x/spec.md'], produces: 'docs/sdd/features/x/feature.md' },
    { skill: 'feature-tdd', args: ['docs/sdd/features/x/feature.md', '--no-verify'] }
  ]);
});

test('the step prompt is the native skill call with its arguments', () => {
  const prompt = buildStepPrompt({ skill: 'sdd-developer', args: ['docs/sdd/features/x/spec.md'] });

  assert.equal(prompt, '/sdd-developer docs/sdd/features/x/spec.md');
  assert.doesNotMatch(prompt, /--no-verify/);

  const skipped = buildStepPrompt({ skill: 'feature-tdd', args: ['feature.md', '--no-verify'] });

  assert.equal(skipped, '/feature-tdd feature.md --no-verify');
});

test('describeFeatureBuild derives the spec and feature paths', (t) => {
  const { root, specPath } = makeFeature(t);
  const described = describeFeatureBuild({ specPath, cwd: root });

  assert.equal(described.specPath, specPath);
  assert.equal(described.specRelative, 'docs/sdd/features/saved-searches/spec.md');
  assert.equal(described.featureRelative, 'docs/sdd/features/saved-searches/feature.md');
});

test('describeFeatureBuild rejects a missing spec next to the session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-feature-build-missing-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => describeFeatureBuild({ specPath: path.join(root, 'nope', 'spec.md'), cwd: root }),
    /no spec file yet/
  );
});

test('changedFiles reports what the build left in the worktree', async (t) => {
  const { root } = makeFeature(t);

  fs.writeFileSync(path.join(root, 'implemented.txt'), 'ok', 'utf8');

  const changed = await changedFiles(root);

  assert.ok(changed.some((line) => line.includes('implemented.txt')));
});

test('a TDD build runs its steps in the same live session that wrote the spec', async (t) => {
  const { root, dir, specPath } = makeFeature(t);
  const prompts = [];
  const events = [];

  const summary = await runInterviewSession(
    { flow: 'feature', brief: 'Add saved searches.' },
    {
      cwd: root,
      id: 'feature-build-live-1',
      spawnProcess: fakeLiveSpawn((turn) => {
        if (turn === 1) {
          fs.writeFileSync(specPath, '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
          return '# Spec written.';
        }

        if (turn === 2) {
          prompts.push('spec-to-task');
          fs.writeFileSync(path.join(dir, 'feature.md'), '# Tasks\n', 'utf8');
          return 'Tasks written.';
        }

        prompts.push('feature-tdd');
        return '# Report\n\nImplemented every task.';
      }),
      terminate: (child) => child.kill?.(),
      emit: (event) => events.push(event),
      waitForBuild: async () => ({ pipeline: 'tdd', verify: false }),
      waitForAnswer: async () => {
        throw new Error('A feature build must not ask for an interview answer.');
      }
    }
  );

  assert.deepEqual(prompts, ['spec-to-task', 'feature-tdd']);
  assert.deepEqual(summary.build.steps.map((step) => step.skill), ['spec-to-task', 'feature-tdd']);
  assert.equal(summary.build.verify, false);
  assert.equal(summary.build.verified, false);
  assert.equal(events.find((event) => event.type === 'build-started').pipeline, 'tdd');
  assert.deepEqual(
    events.filter((event) => event.type === 'build-step' && event.status === 'done').map((event) => event.skill),
    ['spec-to-task', 'feature-tdd']
  );
  assert.ok(events.some((event) => event.type === 'build-done'));
  assert.ok(summary.turns.some((turn) => turn.role === 'marker' && /build done/.test(turn.text)));
});

test('a TDD build stops when spec-to-task writes no feature.md', async (t) => {
  const { root, specPath } = makeFeature(t);

  await assert.rejects(
    runInterviewSession(
      { flow: 'feature', brief: 'Add saved searches.' },
      {
        cwd: root,
        id: 'feature-build-live-missing-1',
        spawnProcess: fakeLiveSpawn((turn) => {
          if (turn === 1) {
            fs.writeFileSync(specPath, '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
          }

          return '# Done.';
        }),
        terminate: (child) => child.kill?.(),
        emit: () => {},
        waitForBuild: async () => ({ pipeline: 'tdd', verify: true }),
        waitForAnswer: async () => ({ done: true })
      }
    ),
    /without writing docs\/sdd\/features\/saved-searches\/feature\.md/
  );
});
