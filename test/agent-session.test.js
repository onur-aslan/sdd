import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
  permissionHookSettings,
  readSessionSkill,
  resolveSessionFlow,
  runInterviewSession,
  snapshotArtifacts,
  validateBrief
} from '../cli/agent-session.js';
import { DEFAULT_AGENT_COMMAND, normalizeAgentCommand } from '../cli/bug-sweep.js';

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

test('each flow resolves to its own skill and final artifact', () => {
  assert.equal(resolveSessionFlow('enhancement').finalLabel, 'plan');
  assert.equal(resolveSessionFlow('feature').finalLabel, 'spec');
  assert.equal(resolveSessionFlow('enhancement').skillPath.endsWith(path.join('enhancement', 'SKILL.md')), true);
  assert.equal(resolveSessionFlow('feature').skillPath.endsWith(path.join('deep-spec', 'SKILL.md')), true);
  assert.throws(() => resolveSessionFlow('deploy'), /Unknown session flow/);
  assert.ok(readSessionSkill('enhancement').length > 100);
  assert.ok(readSessionSkill('feature').length > 100);
});

test('the session contract asks one question at a time and includes the skill', () => {
  const instructions = buildSessionInstructions('enhancement', { skillText: '# Enhancement\n\nStep 1: interview.' });

  assert.match(instructions, /one question at a time/i);
  assert.match(instructions, /Do not modify, create, or delete any file/);
  assert.match(instructions, /Stop at the plan/);
  assert.match(instructions, /Step 1: interview\./);
  // The studio no longer turns prose into buttons, so the contract must not
  // prescribe an option shape or a question fence.
  assert.doesNotMatch(instructions, /one-click|interview` block|Recommended:/);

  // Diagrams prefer Mermaid, with ASCII reserved for what Mermaid cannot draw.
  assert.match(instructions, /## Diagrams/);
  assert.match(instructions, /draw it with Mermaid in a fenced/);
  assert.match(instructions, /Mermaid cannot draw a screen/);
  assert.match(instructions, /Do not draw the same thing twice/);

  const feature = buildSessionInstructions('feature', { skillText: 'x' });

  assert.match(feature, /Stop at the spec/);
  // The spec file is the structural end of a feature interview.
  assert.match(feature, /docs\/sdd\/features\/<feature-name>\/spec\.md/);
  assert.match(feature, /Do not create or\s+modify anything else/);
  assert.doesNotMatch(feature, /Do not modify, create, or delete any file/);
});

test('the opening message carries the request, and turn prompts replay the transcript', () => {
  const opening = buildSessionOpening('enhancement', '  Add a command palette.  ');

  assert.match(opening, /Add a command palette\./);
  assert.match(opening, /first single question/);

  const prompt = buildTurnPrompt('feature', {
    brief: 'Add saved searches.',
    turns: [
      { role: 'assistant', text: 'Which storage?' },
      { role: 'user', text: 'Local disk.' }
    ]
  });

  assert.match(prompt, /Add saved searches\./);
  assert.match(prompt, /Which storage\?/);
  assert.match(prompt, /Local disk\./);
  assert.match(prompt, /Continue:/);
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

test('the flows stay separate and cover both skills', () => {
  assert.deepEqual(Object.keys(SESSION_FLOWS).sort(), ['enhancement', 'feature']);
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

        // The plan has no artifact: the human closes the interview.
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

test('a live session answers a permission request through the studio', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-perm-'));
  const dir = path.join(root, '.bug-fix', 'enhancements', 'perm-1');
  const decisions = [];
  const spawnAgent = fakeLiveSpawn(() => '# Plan\n\nLocal disk.');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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

test('a turn-based session reports a non-zero agent exit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-session-fail-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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
