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

function writeMcpConfig(target, selectedPlugins) {
  if (!selectedPlugins.includes('frontend')) {
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
          type: 'stdio',
          command: 'npx',
          args: ['@playwright/mcp']
        }
      }
    };

    fs.writeFileSync(mcpConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    return;
  }

  const existing = fs.existsSync(mcpConfigPath)
    ? JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'))
    : {};

  const nextConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      playwright: playwrightConfig
    },
    playwright: playwrightConfig
  };

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
        if (conflictHandler) {
          const action = await conflictHandler({ skillName, destination, source, pluginId });
          if (action === 'skip') {
            continue;
          }
          if (action === 'abort') {
            throw new Error(`Installation aborted while processing Skill: ${skillName}`);
          }
          if (action === 'overwrite') {
            fs.rmSync(destination, { recursive: true, force: true });
          }
        } else {
          throw new Error(`Skill already exists: ${skillName}`);
        }
      }

      fs.cpSync(source, destination, { recursive: true, force: true });
      installedCount += 1;
    }
  }

  writeMetadata(target.metadataPath, targetId, consistentPlugins, version);
  writeMcpConfig(target, consistentPlugins);

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
