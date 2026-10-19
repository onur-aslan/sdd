import fs from 'node:fs';
import path from 'node:path';

// Returns {} for a missing file and null for a file that cannot be parsed.
export function readJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// A config file that only ever held the Playwright entry goes away, as if SDD never ran here.
function writeOrDropJsonConfig(configPath, config) {
  if (Object.keys(config).length === 0) {
    fs.rmSync(configPath, { force: true });
    return;
  }

  writeJsonConfig(configPath, config);
}

// A missing `claude` binary is an ENOENT spawn error on POSIX, but through cmd.exe on Windows it
// is a "not recognized" shell error with a non-zero exit code. Both shapes mean the same thing:
// fall back to editing the MCP config file ourselves.
async function runClaudeCli(commandArgs, cwd) {
  const { spawnSync } = await import('node:child_process');
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'claude', ...commandArgs], { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env })
    : spawnSync('claude', commandArgs, { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  const output = [result.stdout?.toString() || '', result.stderr?.toString() || ''].join('\n');
  const missing = Boolean(result.error && (result.error.code === 'ENOENT' || result.error.code === 'EINVAL'))
    || /is not recognized|command not found|no such file or directory/i.test(output);

  return { result, output, missing };
}

export async function writeMcpConfig(target, selectedPlugins, scope = 'project', cwd = process.cwd()) {
  if (!selectedPlugins.includes('sdd')) {
    return;
  }

  if (target.id === 'claude') {
    const { result, output, missing } = await runClaudeCli(
      ['mcp', 'add', '--scope', scope, '--transport', 'stdio', 'playwright', '--', 'npx', '-y', '@playwright/mcp'],
      cwd
    );

    if (!missing) {
      if (result.error) {
        throw new Error(`Claude MCP setup failed: ${result.error.message}`);
      }

      if (result.status !== 0) {
        if (/already exists/i.test(output)) {
          return;
        }
        throw new Error(`Claude MCP setup exited with code ${result.status}.`);
      }

      return;
    }

    if (fs.existsSync(target.mcpConfigPath) && readJsonConfig(target.mcpConfigPath) === null) {
      console.warn(`[sdd] The Claude CLI was not found and ${target.mcpConfigPath} is not valid JSON, so it was left untouched. Register the Playwright MCP server manually.`);
      return;
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
      console.warn(`[sdd] ${mcpConfigPath} is not valid JSON, so it was left untouched and the Playwright MCP server was not configured.`);
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

    writeJsonConfig(mcpConfigPath, nextConfig);
    return;
  }

  const existing = readJsonConfig(mcpConfigPath);

  if (existing === null) {
    console.warn(`[sdd] ${mcpConfigPath} is not valid JSON, so it was left untouched and the Playwright MCP server was not configured.`);
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

  writeJsonConfig(mcpConfigPath, nextConfig);
}

// Removes the Playwright MCP server this package registered. Returns 'removed' when an entry
// was deleted, 'absent' when the target never had one, and 'skipped' when the config file is
// not valid JSON. Other MCP servers are always preserved.
export async function removeMcpConfig(target, { scope = 'project', cwd = process.cwd() } = {}) {
  if (target.id === 'claude') {
    const { result, output, missing } = await runClaudeCli(['mcp', 'remove', '--scope', scope, 'playwright'], cwd);

    if (!missing) {
      if (result.error) {
        throw new Error(`Claude MCP cleanup failed: ${result.error.message}`);
      }

      if (result.status === 0) {
        return 'removed';
      }

      if (/no .*found|not found|does not exist/i.test(output)) {
        return 'absent';
      }

      throw new Error(`Claude MCP cleanup exited with code ${result.status}.`);
    }

    if (!fs.existsSync(target.mcpConfigPath)) {
      return 'absent';
    }

    console.warn(`[sdd] The Claude CLI was not found; removing the Playwright MCP server from ${target.mcpConfigPath} directly.`);
  }

  const { mcpConfigPath, mcpFormat } = target;

  if (mcpFormat === 'toml') {
    if (!fs.existsSync(mcpConfigPath)) {
      return 'absent';
    }

    const existing = fs.readFileSync(mcpConfigPath, 'utf8');
    const lineEnding = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.trim() ? existing.trim().split(/\r?\n/) : [];
    const section = '[mcp_servers.playwright]';
    const kept = [];
    let found = false;
    let skipping = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('[')) {
        skipping = trimmed === section || trimmed.startsWith(`${section}.`);
        found = found || skipping;
      }

      if (!skipping) {
        kept.push(line);
      }
    }

    if (!found) {
      return 'absent';
    }

    const remaining = kept.join(lineEnding).trim();

    if (remaining) {
      fs.writeFileSync(mcpConfigPath, `${remaining}${lineEnding}`, 'utf8');
    } else {
      fs.rmSync(mcpConfigPath, { force: true });
    }

    return 'removed';
  }

  const existing = readJsonConfig(mcpConfigPath);

  if (existing === null) {
    console.warn(`[sdd] ${mcpConfigPath} is not valid JSON, so the Playwright MCP server entry was left untouched.`);
    return 'skipped';
  }

  if (mcpFormat === 'json-opencode') {
    if (!existing.mcp || existing.mcp.playwright === undefined) {
      return 'absent';
    }

    const nextMcp = { ...existing.mcp };
    delete nextMcp.playwright;

    const nextConfig = { ...existing };

    if (Object.keys(nextMcp).length === 0) {
      delete nextConfig.mcp;
    } else {
      nextConfig.mcp = nextMcp;
    }

    writeOrDropJsonConfig(mcpConfigPath, nextConfig);
    return 'removed';
  }

  if (!existing.mcpServers || existing.mcpServers.playwright === undefined) {
    return 'absent';
  }

  const nextServers = { ...existing.mcpServers };
  delete nextServers.playwright;

  const nextConfig = { ...existing };

  if (Object.keys(nextServers).length === 0) {
    delete nextConfig.mcpServers;
  } else {
    nextConfig.mcpServers = nextServers;
  }

  writeOrDropJsonConfig(mcpConfigPath, nextConfig);
  return 'removed';
}
