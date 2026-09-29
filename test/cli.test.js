import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { targets } from '../cli/targets.js';
import { getSkillGroups } from '../cli/skills.js';
import { installSelectedSkills } from '../cli/install.js';
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

test('install flattens skills directly under the target skill directory and adds Playwright MCP config for each target format', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-install-'));
  const claudeResult = await installSelectedSkills({
    targetId: 'claude',
    plugins: ['core', 'frontend'],
    scope: 'project',
    cwd: tempRoot,
    version: '1.0.2'
  });

  assert.ok(fs.existsSync(path.join(tempRoot, '.claude', 'skills', 'deep-spec', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(tempRoot, '.mcp.json')));
  assert.equal(claudeResult.installedCount, 15);

  const claudeConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, '.mcp.json'), 'utf8'));
  assert.ok(claudeConfig.playwright);
  assert.equal(claudeConfig.playwright.command, 'npx');
  assert.deepEqual(claudeConfig.playwright.args, ['@playwright/mcp']);

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
  assert.equal(opencodeConfig.mcp.playwright.command, 'npx');
});

test('help output includes install and version commands', async () => {
  const output = await run(['--help']);
  assert.match(output, /Usage:/);
  assert.match(output, /install/);
  assert.match(output, /--version/);
});
