import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { targets, resolveTargetPath } from '../cli/targets.js';
import { getSkillGroups, getSkillsForGroup } from '../cli/skills.js';
import { installSelectedSkills } from '../cli/install.js';
import { uninstallSkills } from '../cli/uninstall.js';
import { buildWorkflowContent, getWorkflowTypes, writeWorkflow } from '../cli/workflows.js';
import { run } from '../cli/index.js';

function createSkillDirectory(skillsRoot, skillName) {
  fs.mkdirSync(path.join(skillsRoot, skillName), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, skillName, 'SKILL.md'), `# ${skillName}\n`, 'utf8');
}

test('supported targets are Claude Code, Cursor, Codex, and OpenCode', () => {
  assert.deepEqual(Object.keys(targets).sort(), ['claude', 'codex', 'cursor', 'opencode']);
  assert.equal(targets.claude.skillDirectory, '.claude/skills');
  assert.equal(targets.codex.skillDirectory, '.agents/skills');
  assert.throws(() => resolveTargetPath('windsurf', 'project', process.cwd()), /Unknown installation target/);
});

test('skill groups cover sdd and vibecoding only', () => {
  const groups = getSkillGroups();
  assert.deepEqual(Object.keys(groups).sort(), ['sdd', 'vibecoding']);
});

test('OpenCode uses the global config directory for user-scoped installs', () => {
  const resolved = resolveTargetPath('opencode', 'user', process.cwd());

  assert.equal(resolved.skillDirectory, path.join('.config', 'opencode', 'skills'));
  assert.equal(resolved.mcpConfigPath, path.join(os.homedir(), '.config', 'opencode', 'opencode.json'));
  assert.equal(resolved.installRoot, path.join(os.homedir(), '.config', 'opencode', 'skills'));
});

test('install uses the Claude CLI for MCP setup instead of editing config files directly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-install-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-bin-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-home-'));
  const logPath = path.join(fakeBin, 'claude-log.txt');
  const originalPath = process.env.PATH;
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;

  if (process.platform === 'win32') {
    const cmdPath = path.join(fakeBin, 'claude.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\n> "%CLAUDE_LOG%" echo %*\r\n`);
    process.env.CLAUDE_LOG = logPath;
  } else {
    const cmdPath = path.join(fakeBin, 'claude');
    fs.writeFileSync(cmdPath, "#!/bin/sh\nprintf '%s\n' \"$@\" > \"$CLAUDE_LOG\"\n");
    fs.chmodSync(cmdPath, 0o755);
    process.env.CLAUDE_LOG = logPath;
  }

  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  // A user-scoped install resolves against the home directory, so isolate it.
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  try {
    const claudeResult = await installSelectedSkills({
      targetId: 'claude',
      plugins: ['sdd'],
      scope: 'project',
      cwd: tempRoot,
      version: '1.0.2'
    });

    assert.ok(fs.existsSync(path.join(tempRoot, '.claude', 'skills', 'deep-spec', 'SKILL.md')));
    const expectedCount = getSkillsForGroup('sdd').length;
    assert.equal(claudeResult.installedCount, expectedCount);
    assert.ok(!fs.existsSync(path.join(tempRoot, '.mcp.json')));

    const projectArgs = fs.readFileSync(logPath, 'utf8').trim();
    assert.match(projectArgs, /mcp/);
    assert.match(projectArgs, /add/);
    assert.match(projectArgs, /--scope/);
    assert.match(projectArgs, /project/);
    assert.match(projectArgs, /playwright/);

    await installSelectedSkills({
      targetId: 'claude',
      plugins: ['sdd'],
      scope: 'user',
      cwd: tempRoot,
      version: '1.0.2'
    });

    const userArgs = fs.readFileSync(logPath, 'utf8').trim();
    assert.match(userArgs, /--scope/);
    assert.match(userArgs, /user/);
    assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'deep-spec', 'SKILL.md')), 'the user install belongs in the isolated home');
  } finally {
    process.env.PATH = originalPath;
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
    delete process.env.CLAUDE_LOG;
  }

  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-codex-'));
  await installSelectedSkills({
    targetId: 'codex',
    plugins: ['sdd'],
    scope: 'project',
    cwd: codexRoot,
    version: '1.0.2'
  });

  const codexConfig = fs.readFileSync(path.join(codexRoot, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.playwright\]/);
  assert.match(codexConfig, /command = "npx"/);
  assert.match(codexConfig, /args = \["-y", "@playwright\/mcp"\]/);

  assert.ok(fs.existsSync(path.join(codexRoot, '.agents', 'skills', 'deep-spec', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(codexRoot, '.codex', 'skills')));

  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-opencode-'));
  await installSelectedSkills({
    targetId: 'opencode',
    plugins: ['sdd'],
    scope: 'project',
    cwd: opencodeRoot,
    version: '1.0.2'
  });

  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(opencodeRoot, 'opencode.json'), 'utf8'));
  assert.deepEqual(opencodeConfig.mcp.playwright, {
    type: 'local',
    command: ['npx', '-y', '@playwright/mcp'],
    enabled: true
  });
  assert.equal(opencodeConfig.mcp.servers, undefined);
});

test('vibecoding install does not configure the Playwright MCP server', async () => {
  const vibecodingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-vibecoding-'));

  await installSelectedSkills({
    targetId: 'opencode',
    plugins: ['vibecoding'],
    scope: 'project',
    cwd: vibecodingRoot,
    version: '1.0.2'
  });

  assert.ok(fs.existsSync(path.join(vibecodingRoot, '.opencode', 'skills', 'ask-first', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(vibecodingRoot, '.opencode', 'skills', 'git-cleanup-playwright-artifacts', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(vibecodingRoot, 'opencode.json')));
});

test('Cursor installs configure the Playwright MCP server', async () => {
  const cursorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cursor-'));

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: cursorRoot,
    version: '1.0.2'
  });

  const cursorConfig = JSON.parse(fs.readFileSync(path.join(cursorRoot, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursorConfig.mcpServers.playwright, { command: 'npx', args: ['-y', '@playwright/mcp'] });
});

test('existing MCP servers are preserved when the Playwright entry is written', async () => {
  const cursorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cursor-merge-'));
  fs.mkdirSync(path.join(cursorRoot, '.cursor'), { recursive: true });
  fs.writeFileSync(
    path.join(cursorRoot, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { existing: { command: 'node', args: ['server.js'] } } }, null, 2),
    'utf8'
  );

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: cursorRoot,
    version: '1.0.2'
  });

  const cursorConfig = JSON.parse(fs.readFileSync(path.join(cursorRoot, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursorConfig.mcpServers.existing, { command: 'node', args: ['server.js'] });
  assert.ok(cursorConfig.mcpServers.playwright);

  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-codex-merge-'));
  fs.mkdirSync(path.join(codexRoot, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(codexRoot, '.codex', 'config.toml'),
    '[mcp_servers.existing]\r\ncommand = "node"\r\nargs = ["server.js"]\r\n',
    'utf8'
  );

  await installSelectedSkills({
    targetId: 'codex',
    plugins: ['sdd'],
    scope: 'project',
    cwd: codexRoot,
    version: '1.0.2'
  });

  await installSelectedSkills({
    targetId: 'codex',
    plugins: ['sdd'],
    scope: 'project',
    cwd: codexRoot,
    version: '1.0.2'
  });

  const codexConfig = fs.readFileSync(path.join(codexRoot, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.existing\]/);
  assert.match(codexConfig, /args = \["server\.js"\]/);
  assert.equal(codexConfig.match(/\[mcp_servers\.playwright\]/g).length, 1);
  assert.ok(!/(^|[^\r])\n/.test(codexConfig), 'config.toml must keep the CRLF line endings it had');

  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-opencode-merge-'));
  fs.writeFileSync(
    path.join(opencodeRoot, 'opencode.json'),
    JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
      mcp: {
        servers: { existing: { type: 'remote', url: 'https://mcp.example.com/mcp' } }
      }
    }, null, 2),
    'utf8'
  );

  await installSelectedSkills({
    targetId: 'opencode',
    plugins: ['sdd'],
    scope: 'project',
    cwd: opencodeRoot,
    version: '1.0.2'
  });

  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(opencodeRoot, 'opencode.json'), 'utf8'));
  assert.equal(opencodeConfig.model, 'anthropic/claude-sonnet-4-5');
  assert.deepEqual(opencodeConfig.mcp.servers.existing, { type: 'remote', url: 'https://mcp.example.com/mcp' });
  assert.deepEqual(opencodeConfig.mcp.playwright, {
    type: 'local',
    command: ['npx', '-y', '@playwright/mcp'],
    enabled: true
  });
});

test('an unparseable MCP config file is left untouched', async () => {
  const cursorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cursor-broken-'));
  const originalWarn = console.warn;
  const warnings = [];
  const brokenConfig = '{\n  // keep my comment\n  "mcpServers": {\n  }\n';

  fs.mkdirSync(path.join(cursorRoot, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(cursorRoot, '.cursor', 'mcp.json'), brokenConfig, 'utf8');
  console.warn = (message) => warnings.push(message);

  try {
    await installSelectedSkills({
      targetId: 'cursor',
      plugins: ['sdd'],
      scope: 'project',
      cwd: cursorRoot,
      version: '4.0.0'
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fs.readFileSync(path.join(cursorRoot, '.cursor', 'mcp.json'), 'utf8'), brokenConfig);
  assert.ok(fs.existsSync(path.join(cursorRoot, '.cursor', 'skills', 'deep-spec', 'SKILL.md')));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is not valid JSON/);
});

test('reinstalling skills overwrites existing copies by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-reinstall-'));

  await installSelectedSkills({
    targetId: 'claude',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '1.0.2'
  });

  await installSelectedSkills({
    targetId: 'claude',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '1.0.2'
  });

  const deepSpecPath = path.join(tempRoot, '.claude', 'skills', 'deep-spec', 'SKILL.md');
  assert.ok(fs.existsSync(deepSpecPath));
});

test('an upgrade removes the skills a pre-4.0.0 install left behind', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-upgrade-'));
  const skillsRoot = path.join(tempRoot, '.cursor', 'skills');
  // A pre-4.0.0 install: the removed skills, one skill that survives, and one that is not ours.
  const legacySkills = ['deep-spec', 'feature-developer', 'implementer', 'init-feature', 'my-own-skill'];

  for (const skillName of legacySkills) {
    fs.mkdirSync(path.join(skillsRoot, skillName), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skillName, 'SKILL.md'), `# ${skillName}\n`, 'utf8');
  }

  fs.writeFileSync(
    path.join(tempRoot, '.cursor', 'sdd.json'),
    JSON.stringify({ version: '3.1.1', plugins: ['sdd', 'vibecoding'], installedAt: '2026-01-01T00:00:00.000Z' }, null, 2),
    'utf8'
  );

  const result = await installSelectedSkills({
    targetId: 'cursor',
    plugins: Object.keys(getSkillGroups()),
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  assert.deepEqual(result.removedSkills, ['feature-developer', 'implementer', 'init-feature']);

  for (const removedSkill of ['feature-developer', 'implementer', 'init-feature']) {
    assert.ok(!fs.existsSync(path.join(skillsRoot, removedSkill)), `${removedSkill} must be pruned`);
  }

  assert.ok(fs.existsSync(path.join(skillsRoot, 'load-project-features', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skillsRoot, 'my-own-skill', 'SKILL.md')), 'skills that are not SDD skills must survive');

  const metadata = JSON.parse(fs.readFileSync(path.join(tempRoot, '.cursor', 'sdd.json'), 'utf8'));
  const expectedSkills = [...getSkillsForGroup('sdd'), ...getSkillsForGroup('vibecoding')].sort();
  assert.equal(metadata.version, '4.0.0');
  assert.deepEqual(metadata.skills, expectedSkills);
});

test('a shrinking plugin selection removes the skills of the deselected plugins', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-shrink-'));
  const skillsRoot = path.join(tempRoot, '.cursor', 'skills');
  const originalCwd = process.cwd();
  const vibecodingSkills = getSkillsForGroup('vibecoding');

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: Object.keys(getSkillGroups()),
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  assert.ok(fs.existsSync(path.join(skillsRoot, 'ask-first', 'SKILL.md')));

  const result = await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  assert.deepEqual(result.removedSkills, vibecodingSkills);
  assert.ok(!fs.existsSync(path.join(skillsRoot, 'ask-first')));
  assert.ok(fs.existsSync(path.join(skillsRoot, 'deep-spec', 'SKILL.md')));

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: Object.keys(getSkillGroups()),
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  try {
    process.chdir(tempRoot);
    // The default selection is sdd only, so the vibecoding skills have to go again.
    const output = await run(['install', '--non-interactive', '--target', 'cursor']);
    assert.match(output, new RegExp(`Removed ${vibecodingSkills.length} skill\\(s\\)`));
    assert.match(output, /ask-first/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('cleanup never follows a path out of the install root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cleanup-safety-'));
  const cursorRoot = path.join(tempRoot, '.cursor');

  fs.mkdirSync(path.join(cursorRoot, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(cursorRoot, 'outside', 'keep.txt'), 'keep\n', 'utf8');
  fs.writeFileSync(
    path.join(cursorRoot, 'sdd.json'),
    JSON.stringify({
      version: '4.0.0',
      plugins: ['sdd'],
      skills: ['../outside', '.', '..', 'absent-skill'],
      installedAt: '2026-01-01T00:00:00.000Z'
    }, null, 2),
    'utf8'
  );

  const result = await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  assert.deepEqual(result.removedSkills, []);
  assert.ok(fs.existsSync(path.join(cursorRoot, 'outside', 'keep.txt')));
  assert.ok(fs.existsSync(path.join(cursorRoot, 'skills', 'deep-spec', 'SKILL.md')));
});

test('a pre-4.0.0 Codex skill directory is reported and left alone', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-codex-legacy-'));
  const legacySkill = path.join(tempRoot, '.codex', 'skills', 'deep-spec', 'SKILL.md');
  const originalWarn = console.warn;
  const warnings = [];

  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacySkill, '# deep-spec\n', 'utf8');
  console.warn = (message) => warnings.push(message);

  try {
    // Without the old metadata file the directory is not proven to be ours, so stay quiet.
    await installSelectedSkills({
      targetId: 'codex',
      plugins: ['sdd'],
      scope: 'project',
      cwd: tempRoot,
      version: '4.0.0'
    });

    assert.deepEqual(warnings, []);

    fs.writeFileSync(
      path.join(tempRoot, '.codex', 'sdd.json'),
      JSON.stringify({ version: '3.1.1', plugins: ['sdd'], installedAt: '2026-01-01T00:00:00.000Z' }, null, 2),
      'utf8'
    );

    await installSelectedSkills({
      targetId: 'codex',
      plugins: ['sdd'],
      scope: 'project',
      cwd: tempRoot,
      version: '4.0.0'
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pre-4\.0\.0/);
  assert.match(warnings[0], /\.codex/);
  assert.ok(fs.existsSync(legacySkill), 'the stale directory is reported, never deleted');
  assert.ok(fs.existsSync(path.join(tempRoot, '.agents', 'skills', 'deep-spec', 'SKILL.md')));
});

test('uninstall removes the recorded skills, the metadata file, and the Playwright MCP server', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-'));
  const skillsRoot = path.join(tempRoot, '.cursor', 'skills');

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: Object.keys(getSkillGroups()),
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  createSkillDirectory(skillsRoot, 'my-own-skill');

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot });

  assert.equal(result.foundInstallation, true);
  assert.deepEqual(result.removedSkills, [...getSkillsForGroup('sdd'), ...getSkillsForGroup('vibecoding')].sort());
  assert.equal(result.targets[0].removedMetadata, true);
  assert.equal(result.targets[0].mcp, 'removed');
  assert.ok(!fs.existsSync(path.join(tempRoot, '.cursor', 'sdd.json')));
  assert.ok(!fs.existsSync(path.join(tempRoot, '.cursor', 'mcp.json')), 'a config file that only held our server is dropped');
  assert.ok(!fs.existsSync(path.join(skillsRoot, 'deep-spec')));
  assert.ok(fs.existsSync(path.join(skillsRoot, 'my-own-skill', 'SKILL.md')));
});

test('uninstall keeps MCP servers and skills it does not own', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-keep-'));
  const cursorRoot = path.join(tempRoot, '.cursor');
  const skillsRoot = path.join(cursorRoot, 'skills');

  fs.mkdirSync(cursorRoot, { recursive: true });
  fs.writeFileSync(path.join(cursorRoot, 'mcp.json'), JSON.stringify({
    mcpServers: {
      existing: { command: 'node', args: ['server.js'] },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] }
    }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(cursorRoot, 'sdd.json'), JSON.stringify({
    version: '4.0.0',
    plugins: ['sdd'],
    skills: ['deep-spec', 'sdd-review'],
    installedAt: '2026-01-01T00:00:00.000Z'
  }, null, 2), 'utf8');
  createSkillDirectory(skillsRoot, 'deep-spec');
  createSkillDirectory(skillsRoot, 'sdd-review');
  // An SDD skill the record does not mention, e.g. a copy skills.sh left behind.
  createSkillDirectory(skillsRoot, 'ask-first');
  createSkillDirectory(skillsRoot, 'other-tool-skill');

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot });

  assert.deepEqual(result.removedSkills, ['ask-first', 'deep-spec', 'sdd-review']);
  const config = JSON.parse(fs.readFileSync(path.join(cursorRoot, 'mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers, { existing: { command: 'node', args: ['server.js'] } });
  assert.ok(fs.existsSync(path.join(skillsRoot, 'other-tool-skill', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(skillsRoot, 'deep-spec')));
});

test('uninstall removes a pre-4.0.0 installation whose metadata only lists plugin ids', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-legacy-'));
  const cursorRoot = path.join(tempRoot, '.cursor');
  const skillsRoot = path.join(cursorRoot, 'skills');

  for (const skillName of ['deep-spec', 'feature-developer', 'handoff', 'my-own-skill']) {
    createSkillDirectory(skillsRoot, skillName);
  }

  fs.writeFileSync(path.join(cursorRoot, 'sdd.json'), JSON.stringify({
    version: '3.1.1',
    plugins: ['core', 'frontend'],
    installedAt: '2026-01-01T00:00:00.000Z'
  }, null, 2), 'utf8');

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot });

  assert.deepEqual(result.removedSkills, ['deep-spec', 'feature-developer', 'handoff']);
  assert.deepEqual(fs.readdirSync(skillsRoot), ['my-own-skill']);
  assert.ok(!fs.existsSync(path.join(cursorRoot, 'sdd.json')));
});

test('uninstall clears a pre-4.0.0 Codex directory without touching unrecorded skills', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-codex-'));
  const legacySkillsRoot = path.join(tempRoot, '.codex', 'skills');

  createSkillDirectory(legacySkillsRoot, 'implementer');
  createSkillDirectory(legacySkillsRoot, 'handoff-resume');
  createSkillDirectory(legacySkillsRoot, 'not-ours');
  createSkillDirectory(path.join(tempRoot, '.agents', 'skills'), 'deep-spec');
  fs.writeFileSync(path.join(tempRoot, '.codex', 'sdd.json'), JSON.stringify({
    version: '3.1.1',
    plugins: ['core'],
    installedAt: '2026-01-01T00:00:00.000Z'
  }, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(tempRoot, '.codex', 'config.toml'),
    '[mcp_servers.playwright]\r\ncommand = "npx"\r\nargs = ["-y", "@playwright/mcp"]\r\n\r\n[mcp_servers.existing]\r\ncommand = "node"\r\nargs = ["server.js"]\r\n',
    'utf8'
  );

  const result = await uninstallSkills({ targetIds: ['codex'], scope: 'project', cwd: tempRoot });

  assert.deepEqual(result.removedSkills, []);
  assert.deepEqual(result.targets[0].legacyCodexSkills, ['handoff-resume', 'implementer']);
  assert.deepEqual(fs.readdirSync(legacySkillsRoot), ['not-ours']);
  assert.ok(!fs.existsSync(path.join(tempRoot, '.codex', 'sdd.json')));
  assert.ok(fs.existsSync(path.join(tempRoot, '.agents', 'skills', 'deep-spec', 'SKILL.md')), 'an unrecorded directory is never touched');

  const codexConfig = fs.readFileSync(path.join(tempRoot, '.codex', 'config.toml'), 'utf8');
  assert.ok(!codexConfig.includes('[mcp_servers.playwright]'));
  assert.match(codexConfig, /\[mcp_servers\.existing\]/);
  assert.ok(!/(^|[^\r])\n/.test(codexConfig), 'config.toml must keep the CRLF line endings it had');
});

test('uninstall --dry-run reports the cleanup without changing anything', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-dry-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-dry-home-'));
  const originalCwd = process.cwd();
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  const expectedSkills = getSkillsForGroup('sdd').length + getSkillsForGroup('vibecoding').length;

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: Object.keys(getSkillGroups()),
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot, dryRun: true });

  assert.equal(result.removedSkills.length, expectedSkills);
  assert.equal(result.targets[0].mcp, 'would-remove');
  assert.ok(fs.existsSync(path.join(tempRoot, '.cursor', 'sdd.json')), 'the metadata file survives a dry run');
  assert.ok(fs.existsSync(path.join(tempRoot, '.cursor', 'skills', 'deep-spec', 'SKILL.md')));

  try {
    process.chdir(tempRoot);
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    const output = await run(['uninstall', '--target', 'cursor', '--dry-run']);
    assert.match(output, /Dry run: nothing was removed\./);
  } finally {
    process.chdir(originalCwd);
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }

  assert.ok(fs.existsSync(path.join(tempRoot, '.cursor', 'skills', 'deep-spec', 'SKILL.md')));
});

test('uninstall --keep-mcp leaves the Playwright server registered', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-keepmcp-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-keepmcp-home-'));
  const originalCwd = process.cwd();
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot, removeMcp: false });

  assert.equal(result.targets[0].mcp, 'kept');
  assert.ok(!fs.existsSync(path.join(tempRoot, '.cursor', 'skills', 'deep-spec')));

  const config = JSON.parse(fs.readFileSync(path.join(tempRoot, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(config.mcpServers.playwright);

  await installSelectedSkills({
    targetId: 'cursor',
    plugins: ['sdd'],
    scope: 'project',
    cwd: tempRoot,
    version: '4.0.0'
  });

  try {
    process.chdir(tempRoot);
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    const output = await run(['uninstall', '--target', 'cursor', '--keep-mcp']);
    assert.match(output, /The Playwright MCP server was kept/);
  } finally {
    process.chdir(originalCwd);
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});

test('uninstall handles the Claude MCP cleanup, missing CLI included', async () => {
  const originalPath = process.env.PATH;
  const originalWarn = console.warn;
  const warnings = [];

  const writeClaudeStub = (binDirectory, windowsBody, posixBody) => {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDirectory, 'claude.cmd'), windowsBody);
    } else {
      const cmdPath = path.join(binDirectory, 'claude');
      fs.writeFileSync(cmdPath, posixBody);
      fs.chmodSync(cmdPath, 0o755);
    }

    process.env.PATH = `${binDirectory}${path.delimiter}${originalPath}`;
  };

  const writeClaudeInstall = (root, mcpConfig) => {
    createSkillDirectory(path.join(root, '.claude', 'skills'), 'deep-spec');
    fs.writeFileSync(path.join(root, '.claude', 'sdd.json'), JSON.stringify({
      version: '4.0.0',
      plugins: ['sdd'],
      skills: ['deep-spec'],
      installedAt: '2026-01-01T00:00:00.000Z'
    }, null, 2), 'utf8');

    if (mcpConfig !== undefined) {
      fs.writeFileSync(path.join(root, '.mcp.json'), mcpConfig, 'utf8');
    }
  };

  console.warn = (message) => warnings.push(message);

  try {
    // The CLI is installed and reports there is no server to remove.
    const absentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-claude-absent-'));
    const absentBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-absent-'));

    writeClaudeStub(
      absentBin,
      '@echo off\r\necho No MCP server named playwright was found 1>&2\r\nexit /b 1\r\n',
      "#!/bin/sh\nprintf '%s\n' 'No MCP server named playwright was found' >&2\nexit 1\n"
    );
    writeClaudeInstall(absentRoot);

    const absentResult = await uninstallSkills({ targetIds: ['claude'], scope: 'project', cwd: absentRoot });

    assert.equal(absentResult.targets[0].mcp, 'absent');
    assert.deepEqual(absentResult.removedSkills, ['deep-spec']);

    // A missing CLI falls back to editing .mcp.json directly.
    const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-claude-fallback-'));
    const fallbackBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-missing-cleanup-'));

    writeClaudeStub(
      fallbackBin,
      "@echo off\r\necho 'claude' is not recognized as an internal or external command 1>&2\r\nexit /b 1\r\n",
      '#!/bin/sh\necho "claude: command not found" >&2\nexit 1\n'
    );
    writeClaudeInstall(fallbackRoot, JSON.stringify({
      mcpServers: {
        existing: { command: 'node', args: ['server.js'] },
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] }
      }
    }, null, 2));

    const fallbackResult = await uninstallSkills({ targetIds: ['claude'], scope: 'project', cwd: fallbackRoot });

    assert.equal(fallbackResult.targets[0].mcp, 'removed');
    assert.ok(warnings.some((message) => /Claude CLI was not found/.test(message)));

    const fallbackConfig = JSON.parse(fs.readFileSync(path.join(fallbackRoot, '.mcp.json'), 'utf8'));
    assert.deepEqual(fallbackConfig.mcpServers, { existing: { command: 'node', args: ['server.js'] } });

    // An MCP config that cannot be parsed is reported and left untouched.
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-claude-broken-'));
    const brokenConfig = '{\n  // keep my comment\n  "mcpServers": {\n  }\n';

    writeClaudeInstall(brokenRoot, brokenConfig);

    const brokenResult = await uninstallSkills({ targetIds: ['claude'], scope: 'project', cwd: brokenRoot });

    assert.equal(brokenResult.targets[0].mcp, 'skipped');
    assert.deepEqual(brokenResult.removedSkills, ['deep-spec']);
    assert.equal(fs.readFileSync(path.join(brokenRoot, '.mcp.json'), 'utf8'), brokenConfig);
    assert.ok(warnings.some((message) => /is not valid JSON/.test(message)));
  } finally {
    process.env.PATH = originalPath;
    console.warn = originalWarn;
  }
});

test('uninstall reports the absence of an installation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-none-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-uninstall-none-home-'));
  const originalCwd = process.cwd();
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;

  createSkillDirectory(path.join(tempRoot, '.cursor', 'skills'), 'deep-spec');

  const result = await uninstallSkills({ targetIds: ['cursor'], scope: 'project', cwd: tempRoot });

  assert.equal(result.foundInstallation, false);
  assert.ok(fs.existsSync(path.join(tempRoot, '.cursor', 'skills', 'deep-spec', 'SKILL.md')), 'a directory without a record is never touched');

  try {
    process.chdir(tempRoot);
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    const output = await run(['uninstall', '--target', 'cursor']);
    assert.match(output, /No SDD installation was found/);
  } finally {
    process.chdir(originalCwd);
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});

test('duplicate Claude MCP server entries are treated as a successful no-op', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-duplicate-mcp-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-duplicate-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-duplicate-home-'));
  const originalPath = process.env.PATH;
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;

  if (process.platform === 'win32') {
    const cmdPath = path.join(fakeBin, 'claude.cmd');
    fs.writeFileSync(cmdPath, '@echo off\r\nif "%1"=="mcp" if "%2"=="add" echo MCP server playwright already exists in user config 1>&2\r\nexit /b 1\r\n');
  } else {
    const cmdPath = path.join(fakeBin, 'claude');
    fs.writeFileSync(cmdPath, "#!/bin/sh\nprintf '%s\n' 'MCP server playwright already exists in user config' >&2\nexit 1\n");
    fs.chmodSync(cmdPath, 0o755);
  }

  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  // A user-scoped install resolves against the home directory, so isolate it.
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  try {
    await assert.doesNotReject(() => installSelectedSkills({
      targetId: 'claude',
      plugins: ['sdd'],
      scope: 'user',
      cwd: tempRoot,
      version: '1.0.2'
    }));

    assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'deep-spec', 'SKILL.md')), 'the user install belongs in the isolated home');
  } finally {
    process.env.PATH = originalPath;
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});

test('help output includes install, uninstall, and version commands', async () => {
  const output = await run(['--help']);
  assert.match(output, /Usage:/);
  assert.match(output, /install/);
  assert.match(output, /uninstall/);
  assert.match(output, /workflow/);
  assert.match(output, /--type <feature\|bug-fix\|enhancement>/);
  assert.match(output, /--target <claude\|cursor\|codex\|opencode>/);
  assert.match(output, /--non-interactive/);
  assert.match(output, /--keep-mcp/);
  assert.match(output, /--dry-run/);
  assert.doesNotMatch(output, /--scope/);
  assert.match(output, /--version/);
});

test('install and uninstall reject a --target flag without a value', async () => {
  await assert.rejects(
    () => run(['install', '--non-interactive', '--target']),
    /Missing value for --target/
  );

  await assert.rejects(
    () => run(['uninstall', '--target']),
    /Missing value for --target/
  );
});

test('list reports the installation state of every supported target', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-list-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-list-home-'));
  const originalCwd = process.cwd();
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  const sddSkillCount = getSkillsForGroup('sdd').length;

  try {
    process.chdir(tempRoot);
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;

    const emptyOutput = await run(['list']);
    assert.match(emptyOutput, /Claude Code: not installed/);
    assert.match(emptyOutput, /Cursor: not installed/);
    assert.match(emptyOutput, /Codex: not installed/);
    assert.match(emptyOutput, /OpenCode: not installed/);

    await installSelectedSkills({
      targetId: 'cursor',
      plugins: ['sdd'],
      scope: 'project',
      cwd: tempRoot,
      version: '4.0.0'
    });

    const output = await run(['list']);
    assert.match(output, new RegExp(`Cursor: project: sdd \\(${sddSkillCount}/${sddSkillCount} skills\\)`));
    assert.match(output, /Claude Code: not installed/);
    assert.match(output, /OpenCode: not installed/);
  } finally {
    process.chdir(originalCwd);
    process.env.USERPROFILE = originalUserProfile;
    process.env.HOME = originalHome;
  }
});

test('a missing Claude CLI falls back to writing .mcp.json instead of failing', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-fallback-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-missing-'));
  const originalPath = process.env.PATH;
  const originalWarn = console.warn;
  const warnings = [];

  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(fakeBin, 'claude.cmd'),
      "@echo off\r\necho 'claude' is not recognized as an internal or external command 1>&2\r\nexit /b 1\r\n"
    );
  } else {
    const cmdPath = path.join(fakeBin, 'claude');
    fs.writeFileSync(cmdPath, '#!/bin/sh\necho "claude: command not found" >&2\nexit 1\n');
    fs.chmodSync(cmdPath, 0o755);
  }

  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  console.warn = (message) => warnings.push(message);

  try {
    await installSelectedSkills({
      targetId: 'claude',
      plugins: ['sdd'],
      scope: 'project',
      cwd: tempRoot,
      version: '4.0.0'
    });
  } finally {
    process.env.PATH = originalPath;
    console.warn = originalWarn;
  }

  const fallbackConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, '.mcp.json'), 'utf8'));
  assert.deepEqual(fallbackConfig.mcpServers.playwright, { command: 'npx', args: ['-y', '@playwright/mcp'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Claude CLI was not found/);
});

test('workflow generation writes the selected template to docs/workflow.md', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-workflow-'));

  const result = writeWorkflow({ type: 'feature', cwd: tempRoot });

  assert.equal(result.path, path.join(tempRoot, 'docs', 'workflow.md'));

  const content = fs.readFileSync(result.path, 'utf8');
  assert.match(content, /Feature Development/);
  assert.match(content, /Generated by sdd workflow/);
  assert.match(content, /\/deep-spec/);
});

test('workflow templates are domain-agnostic and use the surviving skills', () => {
  const featureContent = buildWorkflowContent('feature');
  const bugFixContent = buildWorkflowContent('bug-fix');
  const enhancementContent = buildWorkflowContent('enhancement');

  assert.match(featureContent, /\/sdd-developer/);
  assert.match(featureContent, /\/spec-to-task/);
  assert.doesNotMatch(featureContent, /\/implementer/);
  assert.doesNotMatch(featureContent, /\/feature-implementer/);
  assert.doesNotMatch(featureContent, /\/feature-web-developer/);
  assert.doesNotMatch(featureContent, /\/verify-with-curl/);
  assert.doesNotMatch(featureContent, /\/verify-with-playwright-mcp/);
  assert.doesNotMatch(featureContent, /\/sdd-review/);
  assert.doesNotMatch(featureContent, /\/spec-test-writer/);

  assert.match(bugFixContent, /Bug Fix/);
  assert.match(bugFixContent, /\/bug-fix/);

  assert.match(enhancementContent, /Enhancement/);
  assert.match(enhancementContent, /\/enhancement/);
});

test('workflow types cover feature, bug-fix, and enhancement', () => {
  const types = getWorkflowTypes().map((entry) => entry.id);
  assert.deepEqual(types, ['feature', 'bug-fix', 'enhancement']);
});

test('unknown workflow selections are rejected', () => {
  assert.throws(() => buildWorkflowContent('nope'), /Unknown workflow type/);
  assert.throws(() => buildWorkflowContent('feature-web'), /Unknown workflow type/);
});
