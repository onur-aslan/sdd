import os from 'node:os';
import path from 'node:path';

export const targets = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    skillDirectory: '.claude/skills',
    mcpConfigPath: '.mcp.json',
    mcpFormat: 'json'
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    skillDirectory: '.cursor/skills',
    mcpConfigPath: '.cursor/mcp.json',
    mcpFormat: 'json'
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    skillDirectory: '.codex/skills',
    mcpConfigPath: '.codex/config.toml',
    mcpFormat: 'toml'
  },
  windsurf: {
    id: 'windsurf',
    name: 'Windsurf',
    skillDirectory: '.windsurf/skills',
    mcpConfigPath: '.windsurf/mcp.json',
    mcpFormat: 'json'
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    skillDirectory: '.opencode/skills',
    mcpConfigPath: 'opencode.json',
    mcpFormat: 'json-opencode'
  }
};

export function resolveInstallBase(scope = 'project', cwd = process.cwd()) {
  if (scope === 'user') {
    return os.homedir();
  }

  return cwd;
}

export function resolveTargetPath(targetId, scope = 'project', cwd = process.cwd()) {
  const target = targets[targetId];

  if (!target) {
    throw new Error(`Unknown installation target: ${targetId}`);
  }

  const baseDir = resolveInstallBase(scope, cwd);
  const installRoot = path.resolve(baseDir, target.skillDirectory);
  const metadataPath = path.resolve(baseDir, path.dirname(target.skillDirectory), 'sdd.json');
  const mcpConfigPath = path.resolve(baseDir, target.mcpConfigPath);

  return {
    ...target,
    baseDir,
    installRoot,
    metadataPath,
    mcpConfigPath
  };
}
