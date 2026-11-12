import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_FLOWS,
  buildLiveCommand,
  buildSessionInstructions,
  buildSessionOpening,
  findSessionArtifact,
  mergePermissionDecision,
  permissionHookSettings,
  readSessionSkill,
  refExists,
  resolveSessionFlow,
  runInterviewSession,
  snapshotArtifacts,
  validateBrief,
  validateSessionSkillArguments
} from '../cli/agent-session.js';
import { normalizeAgentCommand } from '../cli/bug-sweep.js';

function installFixtureSkill(root, flow) {
  const target = path.join(root, '.claude', 'skills', resolveSessionFlow(flow).skillName, 'SKILL.md');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(resolveSessionFlow(flow).skillPath, target);
}

function installSkills(root, names) {
  for (const name of names) {
    const file = path.join(root, '.claude', 'skills', name, 'SKILL.md');

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: Test fixture skill.\n---\n`, 'utf8');
  }
}

test('findSessionArtifact ignores flows without an artifact and specs that predate the session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-artifact-'));
  const feature = resolveSessionFlow('feature');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(findSessionArtifact(root, resolveSessionFlow('enhancement'), new Map()), null);
  assert.equal(findSessionArtifact(root, feature, new Map()), null);

  const specDir = path.join(root, 'docs', 'sdd', 'features', 'saved-searches');
  const spec = path.join(specDir, 'spec.md');

  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(spec, '# Spec\n', 'utf8');

  // This is the snapshot taken when the session starts.
  const before = snapshotArtifacts(root, feature);

  assert.ok(before.get(spec) > 0);
  // A spec that was already there must not end the new session.
  assert.equal(findSessionArtifact(root, feature, before), null);

  // Rewriting that spec during the session does count.
  fs.writeFileSync(spec, '# Spec\n\nNew.\n', 'utf8');
  fs.utimesSync(spec, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000));

  assert.equal(findSessionArtifact(root, feature, before), spec);

  // So does a brand-new feature directory.
  const other = path.join(root, 'docs', 'sdd', 'features', 'other', 'spec.md');

  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '# Other\n', 'utf8');

  assert.equal(findSessionArtifact(root, feature, before), other);
});

test('validateBrief trims and rejects empty or oversized briefs', () => {
  assert.equal(validateBrief('  Add a palette.  '), 'Add a palette.');
  assert.throws(() => validateBrief('   '), /Describe what you want to change/);
  assert.throws(() => validateBrief('x'.repeat(4001)), /4000 characters or fewer/);
});

test('Studio leaves skill execution limits to the selected agent and rejects Studio overrides', () => {
  assert.deepEqual(validateSessionSkillArguments('enhancement'), {});
  assert.throws(() => validateSessionSkillArguments('enhancement', { max_turns: 7 }), /Unsupported enhancement argument/);
  assert.throws(() => validateSessionSkillArguments('enhancement', { unknown: true }), /Unsupported enhancement argument/);
  assert.throws(() => validateSessionSkillArguments('enhancement', '5'), /must be an object/);
});

test('each flow resolves to its own skill and final artifact', () => {
  assert.equal(resolveSessionFlow('enhancement').planLabel, 'plan');
  assert.equal(resolveSessionFlow('enhancement').finalLabel, 'report');
  assert.equal(resolveSessionFlow('feature').finalLabel, 'spec');
  assert.equal(resolveSessionFlow('merge').mode, 'merge');
  assert.equal(resolveSessionFlow('merge').finalLabel, 'merge report');
  assert.equal(resolveSessionFlow('enhancement').skillPath.endsWith(path.join('enhancement', 'SKILL.md')), true);
  assert.equal(resolveSessionFlow('feature').skillPath.endsWith(path.join('deep-spec', 'SKILL.md')), true);
  assert.equal(
    resolveSessionFlow('merge').skillPath.endsWith(path.join('vibecoding', 'skills', 'merge', 'SKILL.md')),
    true
  );
  assert.throws(() => resolveSessionFlow('deploy'), /Unknown session flow/);
  assert.ok(readSessionSkill('enhancement').length > 100);
  assert.ok(readSessionSkill('feature').length > 100);
  assert.ok(readSessionSkill('merge').length > 100);
});

test('every flow sends its request straight to the native Claude skill with no second contract', () => {
  const calls = {
    enhancement: '/enhancement',
    feature: '/deep-spec',
    specIssue: '/deep-spec',
    merge: '/merge'
  };

  for (const [flow, call] of Object.entries(calls)) {
    assert.equal(buildSessionInstructions(flow), call);
    assert.equal(buildSessionOpening(flow, '  Do the thing.  '), `${call}\n\nDo the thing.`);
    assert.doesNotMatch(
      buildSessionOpening(flow, 'Do the thing.'),
      /What the final|## Rules for this session|## How this session works|## Diagrams|Open Questions|first single question/
    );
  }

  // The skill files, not the studio wrapper, own the workflow and its rules.
  assert.match(readSessionSkill('enhancement'), /Wait for the user's explicit confirmation of the plan/);
  assert.match(readSessionSkill('merge'), /Never push and never touch the target branch/);
  assert.match(readSessionSkill('feature'), /Read \[spec-format\.md\]/);
});

test('the spec-issue flow forwards the request to deep-spec without a second contract', () => {
  // The skill owns the interview and its spec-format.md output rules, so the
  // flow must not add a competing outline.
  assert.equal(buildSessionInstructions('specIssue'), '/deep-spec');
  assert.equal(buildSessionOpening('specIssue', '  Add saved searches.  '), '/deep-spec\n\nAdd saved searches.');

  const opening = buildSessionOpening('specIssue', 'Add saved searches.');

  assert.doesNotMatch(opening, /What the final spec must contain/);
  assert.doesNotMatch(opening, /Markdown feature spec/);
  assert.doesNotMatch(opening, /Open Questions/);

  // The Feature tab now forwards to the same skill without a competing outline.
  assert.equal(buildSessionInstructions('feature'), '/deep-spec');
});

test('the flows stay separate and cover every skill', () => {
  assert.deepEqual(Object.keys(SESSION_FLOWS).sort(), ['enhancement', 'feature', 'merge', 'specIssue']);
  assert.equal(SESSION_FLOWS.specIssue.skillName, 'deep-spec');
  assert.equal(SESSION_FLOWS.feature.skillName, 'deep-spec');
});

test('the merge skill owns the target protection and the integration branch', () => {
  const skill = readSessionSkill('merge');

  assert.match(skill, /target branch itself is never modified/i);
  assert.match(skill, /Never push/);
  assert.match(skill, /merge\/<source>-into-<target>/);

  assert.equal(buildSessionInstructions('merge'), '/merge');
  assert.equal(
    buildSessionOpening('merge', 'Merge "feat/x" into "main".'),
    '/merge\n\nMerge "feat/x" into "main".'
  );
});

test('the merge guard allows edits and safe git but refuses the target and a push', () => {
  const target = 'main';
  const decide = (tool, detail) => mergePermissionDecision({ tool, detail }, { target });

  assert.equal(decide('Edit', 'src/app.js').behavior, 'allow');
  assert.equal(decide('Write', 'src/app.js').behavior, 'allow');
  assert.equal(decide('Bash', 'git status --porcelain').behavior, 'allow');
  assert.equal(decide('Bash', 'git add src/app.js').behavior, 'allow');
  assert.equal(decide('Bash', 'git commit -m "resolve"').behavior, 'allow');
  assert.equal(decide('Bash', 'git checkout -b merge/feat-into-main main').behavior, 'allow');
  assert.equal(decide('Bash', 'git switch -c merge/feat-into-main main').behavior, 'allow');
  assert.equal(decide('Bash', 'git push origin main').behavior, 'deny');
  assert.equal(decide('Bash', 'git checkout main').behavior, 'deny');
  assert.equal(decide('Bash', 'git switch main').behavior, 'deny');
  assert.equal(decide('Bash', 'git branch -D main').behavior, 'deny');
  assert.equal(decide('Bash', 'git branch -f main HEAD').behavior, 'deny');
  assert.equal(decide('Bash', 'git reset --hard HEAD').behavior, 'deny');
  assert.equal(decide('Bash', 'git commit --amend -m "x"').behavior, 'deny');
  // Unknown commands, other tools, and compound commands go to the human.
  assert.equal(decide('Bash', 'npm install left-pad'), null);
  assert.equal(decide('Bash', 'git status && git push'), null);
  assert.equal(decide('Read', 'src/app.js'), null);
});

test('the live command allows reads, pre-approves nothing else, and carries the model and effort', () => {
  const claude = normalizeAgentCommand('["claude","-p"]');
  const live = buildLiveCommand(claude);

  assert.deepEqual(live.args.slice(0, 7), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'
  ]);
  // Reads are pre-approved; nothing is hard-denied, because a denied tool can
  // never become a PermissionRequest the human could answer.
  assert.ok(live.args.includes('--allowedTools'));
  assert.equal(live.args.includes('--disallowedTools'), false);

  // Flags the user already set are not duplicated.
  const custom = buildLiveCommand(normalizeAgentCommand('["claude","-p","--output-format","stream-json"]'));

  assert.equal(custom.args.filter((arg) => arg === '--output-format').length, 1);

  const selected = buildLiveCommand(claude, { model: 'claude-sonnet-4-5', effort: 'high' });

  assert.deepEqual(selected.args.slice(-4), ['--model', 'claude-sonnet-4-5', '--effort', 'high']);

  // Default means "do not send the flag".
  const defaults = buildLiveCommand(claude, { model: 'Default', effort: 'default' });

  assert.equal(defaults.args.includes('--model'), false);
  assert.equal(defaults.args.includes('--effort'), false);

  const hooked = buildLiveCommand(claude, { settings: '{"hooks":{}}' });

  assert.deepEqual(hooked.args.slice(-2), ['--settings', '{"hooks":{}}']);

  const ownSettings = buildLiveCommand(
    normalizeAgentCommand('["claude","-p","--settings","{}"]'),
    { settings: '{"hooks":{}}' }
  );

  assert.equal(ownSettings.args.filter((arg) => arg === '--settings').length, 1);
});

test('the permission hook settings point at the shipped hook script', () => {
  const settings = JSON.parse(permissionHookSettings(path.join(os.tmpdir(), 'session')));

  const hook = settings.hooks.PermissionRequest[0].hooks[0];

  assert.equal(hook.type, 'command');
  assert.match(hook.command, /session-hook\.js/);
  assert.match(hook.command, /permission\.json/);
  assert.equal(hook.timeout, 60);
});

// A stand-in for Claude Code in stream-json mode: it answers each user message
// with one assistant message and the result that closes the turn.
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

test('a live merge session ends when the integration branch exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-merge-'));
  const ref = 'merge/feat-into-main';

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'merge@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Merge Bot'], { cwd: root });
  fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n', 'utf8');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  installFixtureSkill(root, 'merge');

  let questions = 0;

  const summary = await runInterviewSession(
    {
      flow: 'merge',
      brief: 'Merge "feat" into "main".',
      merge: { source: 'feat', target: 'main', ref, baseSha: '' }
    },
    {
      cwd: root,
      id: 'merge-live-1',
      spawnProcess: fakeLiveSpawn(() => {
        // The branch is the structural end of the session, not a phrase.
        spawnSync('git', ['branch', ref], { cwd: root });

        return '# Merge report\n\nClean merge; the integration branch is ready.';
      }),
      terminate: (child) => child.kill?.(),
      emit: () => {},
      waitForAnswer: async () => {
        questions += 1;
        return { cancelled: true };
      }
    }
  );

  assert.equal(questions, 0);
  assert.equal(summary.ref, ref);
  assert.equal(refExists(root, ref), true);
  assert.match(summary.output, /Clean merge/);
});

test('a live session asks, waits, then finishes at the plan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-live-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  const asked = [];
  const outputs = [];
  let replies = 0;

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.' },
    {
      cwd: root,
      id: 'live-1',
      spawnProcess: fakeLiveSpawn((turn) => (
        turn === 1
          ? 'Local disk or a database?'
          : '# Plan\n\nLocal disk.'
      )),
      terminate: (child) => child.kill?.(),
      emit: (event) => {
        if (event.type === 'output') {
          outputs.push(event.chunk);
        }
      },
      waitForAnswer: async (question) => {
        asked.push(question.text);
        replies += 1;

        // The human may stop at the plan even though the flow can continue.
        return replies === 1 ? { answer: 'Local disk.' } : { done: true };
      }
    }
  );

  assert.equal(asked.length, 2);
  assert.equal(asked[0], 'Local disk or a database?');
  assert.match(asked[1], /# Plan/);
  assert.equal(summary.engine, 'live');
  assert.match(summary.output, /# Plan/);
  assert.match(outputs.join(''), /# Plan/);
  assert.ok(fs.existsSync(path.join(root, '.sdd', 'sessions', 'enhancement', 'live-1', 'session.md')));
});

test('a live session implements after the plan is approved and ends at the report', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-implement-'));
  const asked = [];

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.' },
    {
      cwd: root,
      id: 'implement-1',
      spawnProcess: fakeLiveSpawn((turn) => {
        if (turn === 1) {
          return 'Local disk or a database?';
        }

        if (turn === 2) {
          return '# Plan\n\nUse local disk.';
        }

        return '# Report\n\nAdded palette.js and verified it.';
      }),
      terminate: (child) => child.kill?.(),
      emit: () => {},
      waitForAnswer: async (question) => {
        asked.push(question.text);

        if (asked.length === 1) {
          return { answer: 'Local disk.' };
        }

        if (asked.length === 2) {
          return { answer: 'Approved. Implement it.' };
        }

        return { done: true };
      }
    }
  );

  assert.equal(asked.length, 3);
  assert.match(asked[1], /# Plan/);
  assert.match(asked[2], /# Report/);
  assert.equal(summary.output, '# Report\n\nAdded palette.js and verified it.');
});

test('a live session starts the claude child with the selected model, effort, and Claude environment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-select-'));
  let spawned = null;
  const spawn = fakeLiveSpawn(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.' },
    {
      cwd: root,
      id: 'select-1',
      spawnProcess: (command, args, options) => {
        spawned = { command, args, options };
        return spawn(command, args, options);
      },
      model: 'nim-model',
      effort: 'high',
      agentEnv: { ANTHROPIC_MODEL: 'nim-model', ANTHROPIC_BASE_URL: 'https://proxy.example' },
      terminate: (child) => child.kill?.(),
      emit: () => {},
      waitForAnswer: async () => ({ done: true })
    }
  );

  assert.ok(spawned.args.includes('--model'));
  assert.ok(spawned.args.includes('nim-model'));
  assert.ok(spawned.args.includes('--effort'));
  assert.ok(spawned.args.includes('high'));
  assert.equal(spawned.options.env.ANTHROPIC_MODEL, 'nim-model');
  assert.equal(spawned.options.env.ANTHROPIC_BASE_URL, 'https://proxy.example');
  assert.equal(spawned.options.env.SDD_SESSION_ID, 'select-1');
  assert.equal(spawned.options.env.SDD_SESSION_FLOW, 'enhancement');
});

test('a feature session writes the spec and runs the chosen build in the same process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-build-'));
  const specRelative = path.join('docs', 'sdd', 'features', 'saved-searches', 'spec.md');
  const featureRelative = path.join('docs', 'sdd', 'features', 'saved-searches', 'feature.md');
  const events = [];

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'feature');
  installSkills(root, ['sdd-developer', 'spec-to-task', 'feature-tdd']);

  const summary = await runInterviewSession(
    { flow: 'feature', brief: 'Add saved searches.' },
    {
      cwd: root,
      id: 'build-1',
      spawnProcess: fakeLiveSpawn((turn) => {
        if (turn === 1) {
          fs.mkdirSync(path.dirname(path.join(root, specRelative)), { recursive: true });
          fs.writeFileSync(path.join(root, specRelative), '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
          return '# Spec written.';
        }

        if (turn === 2) {
          assert.match(fs.readFileSync(path.join(root, specRelative), 'utf8'), /Saved searches/);
          fs.writeFileSync(path.join(root, featureRelative), '# Tasks\n', 'utf8');
          return 'Tasks written.';
        }

        return '# Report\n\nImplemented and verified.';
      }),
      terminate: (child) => child.kill?.(),
      emit: (event) => events.push(event),
      waitForBuild: async (request) => {
        assert.match(request.spec, /spec\.md$/);
        return { pipeline: 'tdd', verify: false };
      },
      waitForAnswer: async () => {
        throw new Error('A feature build must not ask for an interview answer.');
      }
    }
  );

  const types = events.map((event) => event.type);

  assert.ok(types.includes('build-ready'));
  assert.ok(types.includes('build-started'));
  assert.ok(types.includes('build-done'));
  assert.deepEqual(
    events.filter((event) => event.type === 'build-step' && event.status === 'done').map((event) => event.skill),
    ['spec-to-task', 'feature-tdd']
  );
  assert.deepEqual(summary.build.steps.map((step) => step.skill), ['spec-to-task', 'feature-tdd']);
  assert.equal(summary.build.verify, false);
  assert.equal(summary.build.verified, false);
  assert.match(summary.output, /# Spec/);
});

test('a live session answers a permission request through the studio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-perm-'));
  const dir = path.join(root, '.sdd', 'sessions', 'enhancement', 'perm-1');
  const decisions = [];
  const spawnAgent = fakeLiveSpawn(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.' },
    {
      cwd: root,
      id: 'perm-1',
      spawnProcess: (command, args, options) => {
        // The real hook writes this when Claude asks; stand in for it.
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'permission.json'),
          JSON.stringify({ id: 'p1', tool: 'Bash', detail: 'npm install left-pad' }),
          'utf8'
        );

        return spawnAgent(command, args, options);
      },
      waitForPermission: async (request) => {
        decisions.push(request);

        return { behavior: 'allow' };
      },
      terminate: (child) => child.kill?.(),
      emit: () => {},
      waitForAnswer: async () => {
        const deadline = Date.now() + 3000;

        while (decisions.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        return { done: true };
      }
    }
  );

  assert.equal(summary.engine, 'live');
  assert.equal(decisions[0].tool, 'Bash');
  assert.equal(decisions[0].detail, 'npm install left-pad');

  const answerFile = path.join(dir, 'permission.json.answer');
  const deadline = Date.now() + 2000;

  while (!fs.existsSync(answerFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(JSON.parse(fs.readFileSync(answerFile, 'utf8')).behavior, 'allow');
});

test('a cancelled session reports a cancellation instead of a failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-cancel-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  await assert.rejects(
    runInterviewSession(
      { flow: 'enhancement', brief: 'Add a command palette.' },
      {
        cwd: root,
        id: 'cancel-1',
        spawnProcess: fakeLiveSpawn(() => 'Still going?'),
        terminate: (child) => child.kill?.(),
        emit: () => {},
        waitForAnswer: async () => ({ cancelled: true })
      }
    ),
    (error) => error.cancelled === true
  );
});

test('an unexpected exit fails the session instead of parking it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-exit-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'enhancement');

  await assert.rejects(
    runInterviewSession(
      { flow: 'enhancement', brief: 'Add a command palette.' },
      {
        cwd: root,
        id: 'exit-1',
        spawnProcess: () => {
          const child = new EventEmitter();

          child.pid = 4343;
          child.killed = false;
          child.exitCode = null;
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => true;

          setTimeout(() => {
            child.stderr.write('provider authentication failed\n');
            child.emit('close', 2);
          }, 20);

          return child;
        },
        terminate: (child) => child.kill?.(),
        emit: () => {},
        waitForAnswer: async () => ({ done: true })
      }
    ),
    /closed the session .*provider authentication failed/
  );
});
