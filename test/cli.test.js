import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { targets, resolveTargetPath } from '../cli/targets.js';
import { getSkillGroups } from '../cli/skills.js';
import { installSelectedSkills } from '../cli/install.js';
import { buildWorkflowContent, writeWorkflow } from '../cli/workflows.js';
import { run } from '../cli/index.js';

test('supported targets include Claude Code and Cursor', () => {
  assert.ok(targets.claude);
  assert.ok(targets.cursor);
  assert.equal(targets.claude.skillDirectory, '.claude/skills');
});

test('skill groups cover core frontend backend and utility', () => {
  const groups = getSkillGroups();
  assert.deepEqual(Object.keys(groups).sort(), ['backend', 'core', 'frontend', 'utility']);
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
  const logPath = path.join(fakeBin, 'claude-log.txt');
  const originalPath = process.env.PATH;

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

  try {
    const claudeResult = await installSelectedSkills({
      targetId: 'claude',
      plugins: ['core', 'frontend'],
      scope: 'project',
      cwd: tempRoot,
      version: '1.0.2'
    });

    assert.ok(fs.existsSync(path.join(tempRoot, '.claude', 'skills', 'deep-spec', 'SKILL.md')));
    assert.equal(claudeResult.installedCount, 11);
    assert.ok(!fs.existsSync(path.join(tempRoot, '.mcp.json')));

    const projectArgs = fs.readFileSync(logPath, 'utf8').trim();
    assert.match(projectArgs, /mcp/);
    assert.match(projectArgs, /add/);
    assert.match(projectArgs, /--scope/);
    assert.match(projectArgs, /project/);
    assert.match(projectArgs, /playwright/);

    await installSelectedSkills({
      targetId: 'claude',
      plugins: ['frontend'],
      scope: 'user',
      cwd: tempRoot,
      version: '1.0.2'
    });

    const userArgs = fs.readFileSync(logPath, 'utf8').trim();
    assert.match(userArgs, /--scope/);
    assert.match(userArgs, /user/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.CLAUDE_LOG;
  }

  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-codex-'));
  await installSelectedSkills({
    targetId: 'codex',
    plugins: ['frontend'],
    scope: 'project',
    cwd: codexRoot,
    version: '1.0.2'
  });

  const codexConfig = fs.readFileSync(path.join(codexRoot, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.playwright\]/);
  assert.match(codexConfig, /command = "npx"/);
  assert.match(codexConfig, /args = \["@playwright\/mcp"\]/);

  const opencodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-opencode-'));
  await installSelectedSkills({
    targetId: 'opencode',
    plugins: ['frontend'],
    scope: 'project',
    cwd: opencodeRoot,
    version: '1.0.2'
  });

  const opencodeConfig = JSON.parse(fs.readFileSync(path.join(opencodeRoot, 'opencode.json'), 'utf8'));
  assert.ok(opencodeConfig.mcp.playwright);
  assert.equal(opencodeConfig.mcp.playwright.type, 'local');
  assert.deepEqual(opencodeConfig.mcp.playwright.command, ['npx', '-y', '@playwright/mcp']);
  assert.equal(opencodeConfig.mcp.playwright.enabled, true);
});

test('reinstalling skills overwrites existing copies by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-reinstall-'));

  await installSelectedSkills({
    targetId: 'claude',
    plugins: ['core'],
    scope: 'project',
    cwd: tempRoot,
    version: '1.0.2'
  });

  await installSelectedSkills({
    targetId: 'claude',
    plugins: ['core'],
    scope: 'project',
    cwd: tempRoot,
    version: '1.0.2'
  });

  const deepSpecPath = path.join(tempRoot, '.claude', 'skills', 'deep-spec', 'SKILL.md');
  assert.ok(fs.existsSync(deepSpecPath));
});

test('duplicate Claude MCP server entries are treated as a successful no-op', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-duplicate-mcp-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-claude-duplicate-'));
  const originalPath = process.env.PATH;

  if (process.platform === 'win32') {
    const cmdPath = path.join(fakeBin, 'claude.cmd');
    fs.writeFileSync(cmdPath, '@echo off\r\nif "%1"=="mcp" if "%2"=="add" echo MCP server playwright already exists in user config 1>&2\r\nexit /b 1\r\n');
  } else {
    const cmdPath = path.join(fakeBin, 'claude');
    fs.writeFileSync(cmdPath, "#!/bin/sh\nprintf '%s\n' 'MCP server playwright already exists in user config' >&2\nexit 1\n");
    fs.chmodSync(cmdPath, 0o755);
  }

  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;

  try {
    await assert.doesNotReject(() => installSelectedSkills({
      targetId: 'claude',
      plugins: ['frontend'],
      scope: 'user',
      cwd: tempRoot,
      version: '1.0.2'
    }));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('help output includes install and version commands', async () => {
  const output = await run(['--help']);
  assert.match(output, /Usage:/);
  assert.match(output, /install/);
  assert.match(output, /workflow/);
  assert.match(output, /--version/);
});

test('workflow generation writes the selected template to docs/workflow.md', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-workflow-'));

  const result = writeWorkflow({ type: 'feature', scope: 'backend', cwd: tempRoot });

  assert.equal(result.path, path.join(tempRoot, 'docs', 'workflow.md'));

  const content = fs.readFileSync(result.path, 'utf8');
  assert.match(content, /Feature Development \(Backend\)/);
  assert.match(content, /Generated by sdd workflow/);
  assert.match(content, /\/sdd:deep-spec/);
});

test('workflow scope "both" combines backend and frontend templates', () => {
  const content = buildWorkflowContent('bug-fix', 'both');

  assert.match(content, /Bug Fix \(Backend\)/);
  assert.match(content, /Bug Fix \(Frontend\)/);
});

test('unknown workflow selections are rejected', () => {
  assert.throws(() => buildWorkflowContent('nope', 'backend'), /Unknown workflow type/);
  assert.throws(() => buildWorkflowContent('feature', 'nope'), /Unknown workflow scope/);
});
