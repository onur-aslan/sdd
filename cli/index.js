import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSelectedSkills } from './install.js';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { uninstallSkills } from './uninstall.js';
import { askInteractiveInstall } from './prompts.js';
import { askWorkflowSelection, writeWorkflow } from './workflows.js';
import { resolveTargetPath, targets } from './targets.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function formatHelp() {
  const targetIds = Object.keys(targets).join('|');
  const pluginIds = Object.keys(getSkillGroups()).join(', ');

  return `SDD - Spec Driven Development\n\nUsage:\n  sdd <command>\n\nCommands:\n  install     Install SDD skills\n  uninstall   Remove SDD skills and the Playwright MCP server\n  workflow    Generate docs/workflow.md for a task type\n  list        Show installed SDD skills\n  update      Update SDD installation\n  doctor      Diagnose SDD installation\n\nInstall options (for "sdd install"):\n  --target <${targetIds}>\n  --user              Install to the user directory instead of the current project\n  --all               Install every plugin (${pluginIds})\n  --non-interactive   Skip the interactive prompts\n\nUninstall options (for "sdd uninstall"):\n  --target <${targetIds}>   Limit the cleanup to one target\n  --user                   Limit the cleanup to the user directory\n  --keep-mcp               Keep the Playwright MCP server registered\n  --dry-run                Report what would be removed without changing anything\n\nWorkflow options (for "sdd workflow"):\n  --type <feature|bug-fix|enhancement>\n\nOptions:\n  --help\n  --version`;
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

  return [summary, ...notes].join(' ');
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
  if (argv.includes('--help') || argv.includes('-h')) {
    return formatHelp();
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return packageJson.version;
  }

  if (argv.length === 0) {
    return formatHelp();
  }

  const [command, ...rest] = argv;

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
