import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_PIPELINES,
  buildFeatureSteps,
  buildStepPrompt,
  describeFeatureBuild,
  resolveFeaturePipeline,
  runFeatureBuild
} from '../cli/feature-build.js';

function makeFeature(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-feature-build-'));
  const dir = path.join(root, 'docs', 'sdd', 'features', 'saved-searches');

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return { root, dir, specPath: path.join(dir, 'spec.md') };
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

test('the step prompt names the skill and tells the agent to stop before commit', () => {
  const prompt = buildStepPrompt({ skill: 'sdd-developer', args: ['docs/sdd/features/x/spec.md'] }, { verify: true });

  assert.match(prompt, /`sdd-developer`/);
  assert.match(prompt, /docs\/sdd\/features\/x\/spec\.md/);
  assert.match(prompt, /Do not commit/);
  assert.doesNotMatch(prompt, /--no-verify/);

  const skipped = buildStepPrompt({ skill: 'feature-tdd', args: ['feature.md', '--no-verify'] }, { verify: false });

  assert.match(skipped, /Skip the E2E verification/);
});

test('a direct build runs one skill step and reports the changed files', async (t) => {
  const { root, specPath } = makeFeature(t);
  const events = [];
  const prompts = [];

  const summary = await runFeatureBuild(
    { pipeline: 'direct', specPath, verify: true, agentCmd: '["fake-agent"]' },
    {
      cwd: root,
      spawnImpl: async (command, args) => {
        prompts.push(args.at(-1));
        fs.writeFileSync(path.join(root, 'implemented.txt'), 'ok', 'utf8');

        return { code: 0, stdout: 'done', stderr: '' };
      },
      emit: (event) => events.push(event)
    }
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /sdd-developer/);
  assert.equal(summary.pipeline, 'direct');
  assert.equal(summary.verify, true);
  assert.deepEqual(summary.steps.map((step) => step.skill), ['sdd-developer']);
  assert.ok(summary.changedFiles.some((line) => line.includes('implemented.txt')));
  assert.ok(events.some((event) => event.type === 'build-started'));
  assert.ok(events.some((event) => event.type === 'build-step' && event.status === 'done'));
  assert.ok(events.some((event) => event.type === 'build-done'));
});

test('a TDD build runs spec-to-task before feature-tdd and requires feature.md', async (t) => {
  const { root, dir, specPath } = makeFeature(t);
  const prompts = [];

  const summary = await runFeatureBuild(
    { pipeline: 'tdd', specPath, verify: false, agentCmd: '["fake-agent"]' },
    {
      cwd: root,
      spawnImpl: async (command, args) => {
        const prompt = args.at(-1);

        prompts.push(prompt);

        if (/spec-to-task/.test(prompt)) {
          fs.writeFileSync(path.join(dir, 'feature.md'), '# Tasks\n', 'utf8');
        }

        return { code: 0, stdout: 'ok', stderr: '' };
      },
      emit: () => {}
    }
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /spec-to-task/);
  assert.match(prompts[1], /feature-tdd/);
  assert.match(prompts[1], /docs\/sdd\/features\/saved-searches\/feature\.md --no-verify/);
  assert.deepEqual(summary.steps.map((step) => step.skill), ['spec-to-task', 'feature-tdd']);
  assert.equal(summary.verify, false);
  assert.equal(summary.featureWritten, true);
});

test('a TDD build stops when spec-to-task writes no feature.md', async (t) => {
  const { root, specPath } = makeFeature(t);

  await assert.rejects(
    runFeatureBuild(
      { pipeline: 'tdd', specPath, verify: true, agentCmd: '["fake-agent"]' },
      {
        cwd: root,
        spawnImpl: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        emit: () => {}
      }
    ),
    /without writing docs\/sdd\/features\/saved-searches\/feature\.md/
  );
});

test('a failed step names the skill that failed', async (t) => {
  const { root, specPath } = makeFeature(t);

  await assert.rejects(
    runFeatureBuild(
      { pipeline: 'direct', specPath, verify: true, agentCmd: '["fake-agent"]' },
      {
        cwd: root,
        spawnImpl: async () => ({ code: 2, stdout: '', stderr: 'baseline checks failed' }),
        emit: () => {}
      }
    ),
    /sdd-developer failed \(exit 2\).*baseline checks failed/
  );
});

test('describeFeatureBuild rejects a missing spec next to the session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-feature-build-missing-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => describeFeatureBuild({ specPath: path.join(root, 'nope', 'spec.md'), cwd: root }),
    /no spec file yet/
  );
});
