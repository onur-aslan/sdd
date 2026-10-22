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
  buildTurnPrompt,
  detectAgentEngine,
  findSessionArtifact,
  mergePermissionDecision,
  parseAgentReply,
  permissionHookSettings,
  readSessionSkill,
  refExists,
  resolveSessionFlow,
  runInterviewSession,
  snapshotArtifacts,
  stripAnsi,
  validateBrief,
  validateSessionSkillArguments
} from '../cli/agent-session.js';
import { DEFAULT_AGENT_COMMAND, normalizeAgentCommand } from '../cli/bug-sweep.js';

function installFixtureSkill(root, agent, flow) {
  const directories = {
    claude: '.claude/skills',
    cursor: '.cursor/skills',
    codex: '.agents/skills',
    opencode: '.opencode/skills'
  };
  const target = path.join(root, directories[agent], resolveSessionFlow(flow).skillName, 'SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(resolveSessionFlow(flow).skillPath, target);
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

test('the enhancement contract gates implementation on plan approval and invokes the native skill', () => {
  const instructions = buildSessionInstructions('enhancement', { agentPreset: 'claude', skillText: '# Enhancement\n\nStep 1: interview.' });

  assert.match(instructions, /one question at a time/i);
  // The plan is a checkpoint: nothing changes before the human approves it.
  assert.match(instructions, /Do not modify, create, or delete any file before the human approves the plan/);
  assert.match(instructions, /Phase 2: implement and verify/);
  assert.match(instructions, /explicitly approves/);
  assert.doesNotMatch(instructions, /Bound the implementation-and-verification loop to \d+ attempts/);
  assert.match(instructions, /Do not commit\. Do not push/);
  assert.doesNotMatch(instructions, /Stop at the plan/);
  assert.match(instructions, /## What the plan must contain/);
  assert.match(instructions, /## What the final report must contain/);
  assert.match(instructions, /\/enhancement/);
  assert.doesNotMatch(instructions, /Step 1: interview\./);
  // The studio no longer turns prose into buttons, so the contract must not
  // prescribe an option shape or a question fence.
  assert.doesNotMatch(instructions, /one-click|interview` block|Recommended:/);

  // Diagrams prefer Mermaid, with ASCII reserved for what Mermaid cannot draw.
  assert.match(instructions, /## Diagrams/);
  assert.match(instructions, /draw it with Mermaid in a fenced/);
  assert.match(instructions, /Mermaid cannot draw a screen/);
  assert.match(instructions, /Do not draw the same thing twice/);

  const feature = buildSessionInstructions('feature', { agentPreset: 'cursor', skillText: 'x' });

  assert.match(feature, /Stop at the spec/);
  // The spec file is the structural end of a feature interview.
  assert.match(feature, /docs\/sdd\/features\/<feature-name>\/spec\.md/);
  assert.match(feature, /Do not create or\s+modify anything else/);
  assert.doesNotMatch(feature, /Do not modify, create, or delete any file/);
});

test('Codex session instructions explicitly invoke the native skill without overriding its limits', () => {
  const instructions = buildSessionInstructions('enhancement', {
    agentPreset: 'codex',
    skillText: '# Should not be embedded'
  });

  assert.match(instructions, /^Use the \$enhancement skill\./);
  assert.doesNotMatch(instructions, /Studio arguments:.*max_turns|Bound the implementation-and-verification loop/);
  assert.doesNotMatch(instructions, /Should not be embedded/);
});

test('every supported preset uses its own native skill call, with no embedded-skill fallback', () => {
  assert.match(buildSessionInstructions('enhancement', { agentPreset: 'claude' }), /^\/enhancement/);
  assert.match(buildSessionInstructions('enhancement', { agentPreset: 'cursor' }), /^\/enhancement/);
  assert.match(buildSessionInstructions('enhancement', { agentPreset: 'codex' }), /^Use the \$enhancement skill/);
  assert.match(buildSessionInstructions('enhancement', { agentPreset: 'opencode' }), /native skill tool/);
  assert.throws(() => buildSessionInstructions('enhancement'), /native skill-capable agent/);
  assert.throws(() => buildSessionInstructions('enhancement', { agentPreset: 'custom', skillText: '# silently embedded' }), /native skill-capable agent/);
});

test('the opening message carries the request, and turn prompts replay the transcript', () => {
  const opening = buildSessionOpening('enhancement', '  Add a command palette.  ', { agentPreset: 'claude' });

  assert.match(opening, /^\/enhancement/);
  assert.match(opening, /Add a command palette\./);
  assert.match(opening, /first single question/);

  const prompt = buildTurnPrompt('feature', {
    brief: 'Add saved searches.',
    agentPreset: 'cursor',
    turns: [
      { role: 'assistant', text: 'Which storage?' },
      { role: 'user', text: 'Local disk.' }
    ]
  });

  assert.match(prompt, /Add saved searches\./);
  assert.match(prompt, /Which storage\?/);
  assert.match(prompt, /Local disk\./);
  assert.match(prompt, /Continue:/);

  // After a plan is approved, the next replay prompt names the phase that starts.
  const enhancement = buildTurnPrompt('enhancement', {
    brief: 'Add a command palette.',
    agentPreset: 'cursor',
    turns: [
      { role: 'assistant', text: '# Plan\n\nUse local disk.' },
      { role: 'user', text: 'Approved. Implement it.' }
    ]
  });

  assert.match(enhancement, /If it approves the plan, implement and verify it now/);
  assert.match(enhancement, /final report/);
});

test('the engine follows the executable, and the live command asks before writing', () => {
  const claude = normalizeAgentCommand(DEFAULT_AGENT_COMMAND);

  assert.equal(detectAgentEngine(claude, 'claude'), 'live');
  assert.equal(detectAgentEngine(normalizeAgentCommand('["cursor-agent","-p"]'), 'cursor'), 'turn');
  assert.equal(detectAgentEngine(normalizeAgentCommand('["claude","-p"]'), 'custom'), 'live');

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

test('the flows stay separate and cover every skill', () => {
  assert.deepEqual(Object.keys(SESSION_FLOWS).sort(), ['enhancement', 'feature', 'merge']);
});

test('the merge contract protects the target and ends at the integration branch', () => {
  const instructions = buildSessionInstructions('merge', { agentPreset: 'claude' });

  assert.match(instructions, /Never\s+check out, modify, or delete the target branch/);
  assert.match(instructions, /Never push, force-push/);
  assert.match(instructions, /session ends when that/);
  assert.match(instructions, /## What the final merge report must contain/);
  assert.match(instructions, /\/merge/);
  assert.doesNotMatch(instructions, /## What the plan must contain/);

  const opening = buildSessionOpening('merge', 'Merge "feat/x" into "main".', { agentPreset: 'claude' });

  assert.match(opening, /^\/merge/);
  assert.match(opening, /preflight checks/);
  assert.doesNotMatch(opening, /first single question/);

  const turn = buildTurnPrompt('merge', {
    brief: 'Merge "feat/x" into "main".',
    agentPreset: 'codex',
    turns: [
      { role: 'assistant', text: 'Resolve auth.ts by keeping both guards?' },
      { role: 'user', text: 'Yes, keep both.' }
    ]
  });

  assert.match(turn, /build the merge on the/);
  assert.match(turn, /session ends when the integration branch exists/);
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
  installFixtureSkill(root, 'claude', 'merge');

  let questions = 0;

  const summary = await runInterviewSession(
    {
      flow: 'merge',
      brief: 'Merge "feat" into "main".',
      agentPreset: 'claude',
      agentCmd: DEFAULT_AGENT_COMMAND,
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

test('a live session asks, waits, then finishes at the plan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-live-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'claude', 'enhancement');

  const asked = [];
  const outputs = [];
  let replies = 0;

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'claude', agentCmd: DEFAULT_AGENT_COMMAND },
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
  assert.ok(fs.existsSync(path.join(root, '.bug-fix', '.gitignore')));
});

test('a live session implements after the plan is approved and ends at the report', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-implement-'));
  const asked = [];

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'claude', 'enhancement');

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'claude', agentCmd: DEFAULT_AGENT_COMMAND },
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

test('a live session answers a permission request through the studio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-perm-'));
  const dir = path.join(root, '.bug-fix', 'enhancements', 'perm-1');
  const decisions = [];
  const spawnAgent = fakeLiveSpawn(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'claude', 'enhancement');

  const summary = await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'claude', agentCmd: DEFAULT_AGENT_COMMAND },
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

test('a turn-based session replays the transcript and ends at the written spec', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-turn-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'cursor', 'feature');

  const prompts = [];
  const asked = [];

  const summary = await runInterviewSession(
    { flow: 'feature', brief: 'Add saved searches.', agentPreset: 'cursor', agentCmd: '["cursor-agent","-p"]' },
    {
      cwd: root,
      id: 'turn-1',
      spawnImpl: async (command, args, options) => {
        prompts.push(fs.readFileSync(path.join(root, '.bug-fix', 'features', 'turn-1', 'prompt.md'), 'utf8'));

        let text;

        if (prompts.length === 1) {
          text = 'Where do saved searches live?';
        } else {
          // deep-spec writes the spec only when the interview is over.
          const specDir = path.join(root, 'docs', 'sdd', 'features', 'saved-searches');

          fs.mkdirSync(specDir, { recursive: true });
          fs.writeFileSync(path.join(specDir, 'spec.md'), '# Spec\n\nSaved searches live in the sidebar.\n', 'utf8');
          text = '# Spec written.';
        }

        options.onStdout(text);

        return { code: 0, stdout: text, stderr: '' };
      },
      emit: () => {},
      waitForAnswer: async (question) => {
        asked.push(question.text);
        return { answer: 'In the sidebar.' };
      }
    }
  );

  assert.deepEqual(asked, ['Where do saved searches live?']);
  assert.equal(summary.engine, 'turn');
  // The written spec is the preview, not the one-line confirmation.
  assert.match(summary.output, /Saved searches live in the sidebar/);
  assert.match(summary.artifact, /spec\.md$/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Add saved searches\./);
  assert.match(prompts[1], /In the sidebar\./);
});

test('a cancelled session reports a cancellation instead of a failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-cancel-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'claude', 'enhancement');

  await assert.rejects(
    runInterviewSession(
      { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'claude', agentCmd: DEFAULT_AGENT_COMMAND },
      {
        cwd: root,
        id: 'cancel-1',
        spawnProcess: fakeLiveSpawn(() => '```interview\nStill going?\n```'),
        terminate: (child) => child.kill?.(),
        emit: () => {},
        waitForAnswer: async () => ({ cancelled: true })
      }
    ),
    (error) => error.cancelled === true
  );
});

test('structured agent output is read as text, not echoed as JSON', () => {
  const stdout = [
    JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Where are saved searches stored?' } }),
    JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'read' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Pick one.' } }),
    JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })
  ].join('\n');

  const parsed = parseAgentReply(stdout);

  assert.equal(parsed.structured, true);
  assert.equal(parsed.error, '');
  assert.equal(parsed.text, 'Where are saved searches stored?\n\nPick one.');
});

test('Codex JSON output exposes assistant messages and hides tool results', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat secret.txt', aggregated_output: 'SECRET_FILE_CONTENT' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I read the file. What should happen next?' } })
  ].join('\n');
  const parsed = parseAgentReply(stdout);

  assert.equal(parsed.structured, true);
  assert.equal(parsed.text, 'I read the file. What should happen next?');
  assert.doesNotMatch(parsed.text, /SECRET_FILE_CONTENT/);
});

test('a structured error event fails the turn instead of becoming the reply', () => {
  const parsed = parseAgentReply(JSON.stringify({
    type: 'error',
    error: {
      name: 'APIError',
      data: { message: "model 'llama3.2:3b' not found" }
    }
  }));

  assert.equal(parsed.text, '');
  assert.match(parsed.error, /llama3\.2:3b' not found/);

  // OpenCode's abort shape has no top-level `type` at all.
  const aborted = parseAgentReply(JSON.stringify({
    error: { type: 'aborted', message: 'Tool execution interrupted' },
    content: []
  }));

  assert.equal(aborted.structured, true);
  assert.match(aborted.error, /Tool execution interrupted/);

  assert.equal(stripAnsi('\u001b[0m> build \u00b7 qwen\u001b[0m\r\nPONG'), '> build \u00b7 qwen\nPONG');
});

test('a turn-based session displays only assistant text from structured output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-json-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'opencode', 'enhancement');

  const stdout = [
    JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'read', output: 'SECRET_FILE_CONTENT' } }),
    JSON.stringify({ type: 'text', part: { type: 'text', text: 'Which layout?' } }),
    JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })
  ].join('\n');
  let asked = '';
  const events = [];
  const stderr = '\u001b[0m> build \u00b7 llama\u001b[0m\n';

  await runInterviewSession(
    { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'opencode', agentCmd: '["opencode","run"]' },
    {
      cwd: root,
      id: 'json-1',
      spawnImpl: async (command, args, options) => {
        options.onStdout(stdout);
        options.onStderr(stderr);
        return { code: 0, stdout, stderr };
      },
      emit: (event) => events.push(event),
      waitForAnswer: async (question) => {
        asked = question.text;

        return { done: true };
      }
    }
  );

  assert.equal(asked, 'Which layout?');
  const shown = events.filter((event) => event.type === 'output').map((event) => event.chunk).join('');
  assert.equal(shown, 'Which layout?');
  assert.doesNotMatch(shown, /SECRET_FILE_CONTENT|llama/);
});

test('a turn-based session reports a non-zero agent exit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-fail-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  installFixtureSkill(root, 'cursor', 'enhancement');

  await assert.rejects(
    runInterviewSession(
      { flow: 'enhancement', brief: 'Add a command palette.', agentPreset: 'cursor', agentCmd: '["cursor-agent","-p"]' },
      {
        cwd: root,
        id: 'fail-1',
        spawnImpl: async () => ({ code: 2, stdout: '', stderr: 'boom' }),
        emit: () => {},
        waitForAnswer: async () => ({ answer: 'nope' })
      }
    ),
    /exited with code 2/
  );
});
