import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSelectedSkills } from './install.js';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { askInteractiveInstall } from './prompts.js';
import { askWorkflowSelection, writeWorkflow } from './workflows.js';
import { resolveTargetPath, targets } from './targets.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function formatHelp() {
  const targetIds = Object.keys(targets).join('|');
  const pluginIds = Object.keys(getSkillGroups()).join(', ');

  return `SDD - Spec Driven Development\n\nUsage:\n  sdd <command>\n\nCommands:\n  install     Install SDD skills\n  workflow    Generate docs/workflow.md for a task type\n  list        Show installed SDD skills\n  update      Update SDD installation\n  doctor      Diagnose SDD installation\n\nInstall options (for "sdd install"):\n  --target <${targetIds}>\n  --user              Install to the user directory instead of the current project\n  --all               Install every plugin (${pluginIds})\n  --non-interactive   Skip the interactive prompts\n\nWorkflow options (for "sdd workflow"):\n  --type <feature|bug-fix|enhancement>\n\nOptions:\n  --help\n  --version`;
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

      return `Installed ${result.installedCount} skills to ${result.installRoot}.`;
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

    return `Installed ${result.installedCount} skills to ${result.installRoot}.`;
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
