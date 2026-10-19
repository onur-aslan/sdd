import fs from 'node:fs';
import path from 'node:path';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { resolveTargetPath } from './targets.js';

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

// Reads an MCP config file, warning instead of destroying a file we cannot parse.
// Returns null when the existing file is not valid JSON.
function readJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.warn(`[sdd] ${configPath} is not valid JSON, so it was left untouched and the Playwright MCP server was not configured.`);
    return null;
  }
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
  if (!selectedPlugins.includes('sdd')) {
    return;
  }

  if (target.id === 'claude') {
    const { spawnSync } = await import('node:child_process');
    const commandArgs = ['mcp', 'add', '--scope', scope, '--transport', 'stdio', 'playwright', '--', 'npx', '-y', '@playwright/mcp'];

    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'claude', ...commandArgs], { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env })
      : spawnSync('claude', commandArgs, { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env });

    const combinedOutput = [result.stdout?.toString() || '', result.stderr?.toString() || ''].join('\n');
    // A missing `claude` binary is an ENOENT spawn error on POSIX, but through cmd.exe on
    // Windows it is a "not recognized" shell error with a non-zero exit code. Both shapes
    // mean the same thing: fall back to writing the MCP config file ourselves.
    const claudeCliMissing = Boolean(result.error && (result.error.code === 'ENOENT' || result.error.code === 'EINVAL'))
      || /is not recognized|command not found|no such file or directory/i.test(combinedOutput);

    if (!claudeCliMissing) {
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

    if (fs.existsSync(target.mcpConfigPath)) {
      try {
        JSON.parse(fs.readFileSync(target.mcpConfigPath, 'utf8'));
      } catch {
        console.warn(`[sdd] The Claude CLI was not found and ${target.mcpConfigPath} is not valid JSON, so it was left untouched. Register the Playwright MCP server manually.`);
        return;
      }
    }

    console.warn(`[sdd] The Claude CLI was not found; writing the Playwright MCP server to ${target.mcpConfigPath} directly.`);
  }

  const { mcpConfigPath, mcpFormat } = target;
  const playwrightConfig = {
    command: 'npx',
    args: ['-y', '@playwright/mcp']
  };

  if (mcpFormat === 'toml') {
    const dir = path.dirname(mcpConfigPath);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(mcpConfigPath)
      ? fs.readFileSync(mcpConfigPath, 'utf8')
      : '';
    const lineEnding = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.trim() ? existing.trim().split(/\r?\n/) : [];
    const section = '[mcp_servers.playwright]';
    const block = [
      section,
      'command = "npx"',
      'args = ["-y", "@playwright/mcp"]'
    ];

    const kept = [];
    let skipping = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('[')) {
        skipping = trimmed === section || trimmed.startsWith(`${section}.`);
      }

      if (!skipping) {
        kept.push(line);
      }
    }

    const sections = [kept.join(lineEnding).trim(), block.join(lineEnding)].filter(Boolean);
    fs.writeFileSync(mcpConfigPath, `${sections.join(lineEnding + lineEnding)}${lineEnding}`, 'utf8');
    return;
  }

  if (mcpFormat === 'json-opencode') {
    const existing = readJsonConfig(mcpConfigPath);

    if (existing === null) {
      return;
    }

    // OpenCode 2 groups servers under `mcp.servers`, but OpenCode 1 rejects that key
    // outright ("Invalid input mcp.servers"), which invalidates the whole config file.
    // OpenCode's V1 migration guide keeps V1 MCP entries with a `type` working in 2,
    // so this entry is the only shape both accept.
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

  const existing = readJsonConfig(mcpConfigPath);

  if (existing === null) {
    return;
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
