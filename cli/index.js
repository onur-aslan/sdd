import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSelectedSkills } from './install.js';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { uninstallSkills } from './uninstall.js';
import { askInteractiveInstall } from './prompts.js';
import { askWorkflowSelection, writeWorkflow } from './workflows.js';
import { resolveTargetPath, targets } from './targets.js';
import { runBugSweep } from './bug-sweep.js';
import { runJiraCheck } from './jira-check.js';
import { runStudio } from './studio.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function formatHelp() {
  const targetIds = Object.keys(targets).join('|');
  const pluginIds = Object.keys(getSkillGroups()).join(', ');

  return `SDD - Spec Driven Development

Start here:
  sdd studio  Open the dashboard (starts the server and opens your browser)

Usage:
  sdd <command>

Commands:
  install     Install SDD skills
  uninstall   Remove SDD skills and the Playwright MCP server
  workflow    Generate docs/workflow.md for a task type
  bug-sweep   Fix Jira bugs one by one and open a pull request
  jira-check  Verify Jira reachability, TLS, and credentials
  studio      Open the local web dashboard for bug sweeps and future flows
  list        Show installed SDD skills
  update      Update SDD installation
  doctor      Diagnose SDD installation\n\nInstall options (for "sdd install"):\n  --target <${targetIds}>\n  --user              Install to the user directory instead of the current project\n  --all               Install every plugin (${pluginIds})\n  --non-interactive   Skip the interactive prompts\n\nUninstall options (for "sdd uninstall"):\n  --target <${targetIds}>   Limit the cleanup to one target\n  --user                   Limit the cleanup to the user directory\n  --keep-mcp               Keep the Playwright MCP server registered\n  --dry-run                Report what would be removed without changing anything\n\nWorkflow options (for "sdd workflow"):\n  --type <feature|bug-fix|enhancement>\n\nBug sweep options (for "sdd bug-sweep"):\n  --project <KEY>          Jira project key\n  --jql <query>            Custom JQL (alternative to --project)\n  --date <YYYY-MM-DD>      Sweep date (default: today)\n  --agent-cmd <value>      Agent command (JSON array or command template)\n  --verify-cmd <command>   Command run before each commit\n  --max-turns <n>          bug-fix subagent attempt limit (default: 5)\n  --limit <n>              Maximum bugs to process (default: 50)\n  --timeout <seconds>      Per-bug agent timeout (default: 1800)\n  --work-dir <path>        State and logs directory (default: .bug-fix)\n  --at <HH:MM>             Wait until this local time, then start\n  --every <duration>       Repeat after each sweep (e.g. 1d)\n  --run-now                With --every, run immediately instead of waiting\n  --resume                 Continue an existing sweep\n  --retry-failed           Retry bugs reported as not fixed\n  --no-push                Do not push the branch or tag\n  --no-pr                  Do not open a pull request\n  --jira-auth <mode>       auto | basic | bearer (default: auto)\n  --jira-ca <path>         PEM file for an internal or self-signed CA\n  --pr-cmd <command>       Replace gh with glab, tea, or a script\n  --dry-run                Print the plan without touching git\n\nJira check options (for "sdd jira-check"):\n  --jira-url <url>         Base URL; JIRA_BASE_URL also works\n  --jira-token <token>     API token or personal access token\n  --jira-auth <mode>       auto | basic | bearer (default: auto)\n  --jira-api-version <v>   auto | 2 | 3 (default: auto)\n  --jira-ca <path>         PEM file for an internal or self-signed CA\n  --jira-insecure          Skip TLS verification (last resort)\n  --project <KEY>          Also verify a search against this project\n\nStudio options (for "sdd studio"):\n  --port <n>               Port to listen on (default: 4321)\n  --host <addr>            Interface to bind (default: 127.0.0.1)\n  --no-open                Do not open the dashboard in your browser\n\nOptions:\n  --help\n  --version`;
}

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];

  if (!value || value.startsWith('--')) {
    return null;
  }

  return value;
}

function formatInstallResult(result) {
  const summary = `Installed ${result.installedCount} skills to ${result.installRoot}.`;
  const removedSkills = result.removedSkills || [];
  const legacyCodexSkills = result.legacyCodexSkills || [];
  const notes = [];

  if (removedSkills.length > 0) {
    notes.push(`Removed ${removedSkills.length} skill(s) that are no longer part of SDD: ${removedSkills.join(', ')}.`);
  }
  if (legacyCodexSkills.length > 0) {
    notes.push(`Removed ${legacyCodexSkills.length} skill(s) from the pre-4.0.0 .codex/skills directory.`);
  }

  return [
    summary,
    ...notes,
    '',
    'Next: open the dashboard in your project folder',
    '  sdd studio',
    '  No global install?  npx @onuraslan/sdd@latest studio'
  ].join('\n');
}

function formatUninstallResult(result) {
  const installedTargets = result.targets.filter((entry) => entry.installed);

  if (installedTargets.length === 0) {
    return 'No SDD installation was found for the selected targets and scopes.';
  }

  const lines = result.dryRun ? ['Dry run: nothing was removed.'] : [];

  for (const entry of installedTargets) {
    const removed = [];

    if (entry.removedSkills.length > 0) {
      removed.push(`${entry.removedSkills.length} skill(s)`);
    }
    if (entry.removedMetadata) {
      removed.push('sdd.json');
    }
    if (entry.legacyCodexSkills.length > 0) {
      removed.push(`${entry.legacyCodexSkills.length} skill(s) from the pre-4.0.0 .codex/skills directory`);
    }

    const mcpNotes = {
      removed: ' The Playwright MCP server was removed.',
      'would-remove': ' The Playwright MCP server would be removed.',
      kept: ' The Playwright MCP server was kept (--keep-mcp).',
      skipped: ' The MCP config file could not be parsed, so the Playwright entry was left untouched.',
      absent: ''
    };
    const summary = removed.length > 0
      ? `${result.dryRun ? 'would remove' : 'removed'} ${removed.join(', ')}.`
      : 'nothing to remove.';

    lines.push(`${entry.targetName} (${entry.scope}): ${summary}${mcpNotes[entry.mcp] || ''}`);
  }

  return lines.join('\n');
}

export async function run(argv = process.argv.slice(2)) {
  // Commands with their own help text handle --help themselves.
  const selfHelp = new Set(['bug-sweep', 'jira-check', 'studio']);

  if ((argv.includes('--help') || argv.includes('-h')) && !selfHelp.has(argv[0])) {
    return formatHelp();
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return packageJson.version;
  }

  if (argv.length === 0) {
    return formatHelp();
  }

  const [command, ...rest] = argv;

  if (command === 'bug-sweep') {
    return runBugSweep(rest);
  }

  if (command === 'jira-check') {
    return runJiraCheck(rest, { exitOnFailure: true });
  }

  if (command === 'studio') {
    return runStudio(rest, { version: packageJson.version });
  }

  if (command === 'install') {
    const args = rest;

    if (process.stdin.isTTY && !args.includes('--non-interactive')) {
      const options = await askInteractiveInstall();
      const result = await installSelectedSkills({
        targetId: options.targetId,
        plugins: options.plugins,
        scope: options.scope,
        version: packageJson.version
      });

      return formatInstallResult(result);
    }

    const requestedPlugins = args.includes('--all') ? Object.keys(getSkillGroups()) : ['sdd'];
    const targetId = args.includes('--target') ? readFlagValue(args, '--target') : 'claude';

    if (!targetId) {
      throw new Error('Missing value for --target.');
    }

    const scope = args.includes('--user') ? 'user' : 'project';

    const result = await installSelectedSkills({
      targetId,
      plugins: requestedPlugins,
      scope,
      version: packageJson.version
    });

    return formatInstallResult(result);
  }

  if (command === 'uninstall') {
    const args = rest;
    const hasTargetFlag = args.includes('--target');
    const targetId = hasTargetFlag ? readFlagValue(args, '--target') : null;

    if (hasTargetFlag && !targetId) {
      throw new Error('Missing value for --target.');
    }

    const result = await uninstallSkills({
      targetIds: targetId ? [targetId] : null,
      scope: args.includes('--user') ? 'user' : null,
      removeMcp: !args.includes('--keep-mcp'),
      dryRun: args.includes('--dry-run')
    });

    return formatUninstallResult(result);
  }

  if (command === 'workflow') {
    const args = rest;
    let type = readFlagValue(args, '--type');

    if (!type && process.stdin.isTTY) {
      const selection = await askWorkflowSelection({ type });
      type = selection.type;
    }

    if (!type) {
      throw new Error('Missing --type for non-interactive workflow generation.');
    }

    const result = writeWorkflow({ type, cwd: process.cwd() });

    return `Wrote ${result.type} workflow to ${result.path}.`;
  }

  if (command === 'list') {
    const lines = [`SDD ${packageJson.version}`, 'Installed targets:'];

    for (const targetId of Object.keys(targets)) {
      const installs = [];

      for (const targetScope of ['project', 'user']) {
        const { metadataPath, installRoot } = resolveTargetPath(targetId, targetScope, process.cwd());

        if (!fs.existsSync(metadataPath)) {
          continue;
        }

        let plugins = [];

        try {
          plugins = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).plugins || [];
        } catch {
          plugins = [];
        }

        if (plugins.length === 0) {
          installs.push(`${targetScope}: unknown plugin selection`);
          continue;
        }

        const expectedSkills = plugins.flatMap((pluginId) => getSkillsForGroup(pluginId));
        const presentSkills = expectedSkills.filter((skillName) => fs.existsSync(path.join(installRoot, skillName)));

        installs.push(`${targetScope}: ${plugins.join(', ')} (${presentSkills.length}/${expectedSkills.length} skills)`);
      }

      lines.push(installs.length > 0
        ? `  ${targets[targetId].name}: ${installs.join('; ')}`
        : `  ${targets[targetId].name}: not installed`);
    }

    return lines.join('\n');
  }

  if (command === 'update') {
    return 'Update support is not implemented yet.';
  }

  if (command === 'doctor') {
    return 'Doctor support is not implemented yet.';
  }

  return `${formatHelp()}\n\nUnknown command: ${command}`;
}
