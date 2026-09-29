import fs from 'node:fs';
import path from 'node:path';
import { getPackageSkillsRoot, getSkillGroups, getSkillsForGroup } from './skills.js';
import { resolveTargetPath } from './targets.js';

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeMetadata(metadataPath, targetId, plugins, version) {
  const metadata = {
    version,
    plugins,
    installedAt: new Date().toISOString()
  };

  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function writeMcpConfig(target, selectedPlugins, scope = 'project', cwd = process.cwd()) {
  if (!selectedPlugins.includes('frontend')) {
    return;
  }

  if (target.id === 'claude') {
    const { spawnSync } = await import('node:child_process');
    const commandArgs = ['mcp', 'add', '--scope', scope, '--transport', 'stdio', 'playwright', '--', 'npx', '-y', '@playwright/mcp'];

    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'claude', ...commandArgs], { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env })
      : spawnSync('claude', commandArgs, { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env });

    const combinedOutput = [result.stdout?.toString() || '', result.stderr?.toString() || ''].join('\n');

    if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'EINVAL')) {
      return;
    }

    if (result.error) {
      throw new Error(`Claude MCP setup failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const duplicateMatch = /already exists/i.test(combinedOutput);
      if (duplicateMatch) {
        return;
      }
      throw new Error(`Claude MCP setup exited with code ${result.status}.`);
    }

    return;
  }

  const { mcpConfigPath, mcpFormat } = target;
  const playwrightConfig = {
    command: 'npx',
    args: ['@playwright/mcp']
  };

  if (mcpFormat === 'toml') {
    const dir = path.dirname(mcpConfigPath);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(mcpConfigPath)
      ? fs.readFileSync(mcpConfigPath, 'utf8')
      : '';
    const lines = existing.trim() ? existing.trim().split('\n') : [];
    const section = '[mcp_servers.playwright]';
    const block = [
      section,
      'command = "npx"',
      'args = ["@playwright/mcp"]'
    ];

    const filtered = lines.filter((line) => !line.startsWith('[mcp_servers.playwright]') && !line.startsWith('command = ') && !line.startsWith('args = '));
    const nextContent = [...filtered, '', ...block, ''].join('\n');
    fs.writeFileSync(mcpConfigPath, `${nextContent}\n`, 'utf8');
    return;
  }

  if (mcpFormat === 'json-opencode') {
    const existing = fs.existsSync(mcpConfigPath)
      ? JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'))
      : {};

    const nextConfig = {
      ...existing,
      mcp: {
        ...(existing.mcp || {}),
        playwright: {
          ...(existing.mcp?.playwright || {}),
          type: 'local',
          command: ['npx', '-y', '@playwright/mcp'],
          enabled: true
        }
      }
    };

    fs.writeFileSync(mcpConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    return;
  }

  let existing = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const nextConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      playwright: playwrightConfig
    }
  };

  delete nextConfig.playwright;

  const dir = path.dirname(mcpConfigPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
}

export async function installSelectedSkills({
  targetId = 'claude',
  plugins = Object.keys(getSkillGroups()),
  scope = 'project',
  cwd = process.cwd(),
  version = '1.0.2',
  conflictHandler = null
}) {
  const selected = Array.isArray(plugins) ? plugins : [plugins];
  const consistentPlugins = selected.filter(Boolean);
  const target = resolveTargetPath(targetId, scope, cwd);

  ensureDirectory(target.installRoot);
  let installedCount = 0;

  for (const pluginId of consistentPlugins) {
    const pluginConfig = getSkillGroups()[pluginId];
    if (!pluginConfig) {
      throw new Error(`Plugin "${pluginId}" is missing from this package. The installation cannot continue.`);
    }

    const groupDirectory = path.join(pluginConfig.pluginRoot, 'skills');
    if (!fs.existsSync(groupDirectory)) {
      throw new Error(`Plugin "${pluginId}" is missing from this package. The installation cannot continue.`);
    }

    const skills = getSkillsForGroup(pluginId);

    for (const skillName of skills) {
      const source = path.join(groupDirectory, skillName);
      const destination = path.join(target.installRoot, skillName);

      if (fs.existsSync(destination)) {
        const action = conflictHandler
          ? await conflictHandler({ skillName, destination, source, pluginId })
          : 'overwrite';

        if (action === 'skip') {
          continue;
        }
        if (action === 'abort') {
          throw new Error(`Installation aborted while processing Skill: ${skillName}`);
        }
        if (action === 'overwrite' || action === undefined) {
          fs.rmSync(destination, { recursive: true, force: true });
        }
      }

      fs.cpSync(source, destination, { recursive: true, force: true });
      installedCount += 1;
    }
  }

  writeMetadata(target.metadataPath, targetId, consistentPlugins, version);
  await writeMcpConfig(target, consistentPlugins, scope, cwd);

  return {
    installedCount,
    targetId,
    plugins: consistentPlugins,
    scope,
    installRoot: target.installRoot,
    metadataPath: target.metadataPath,
    mcpConfigPath: target.mcpConfigPath
  };
}
