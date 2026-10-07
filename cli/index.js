import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

import { installSelectedSkills } from './install.js';
import { getSkillGroups } from './skills.js';
import { askInteractiveInstall } from './prompts.js';
import { askWorkflowSelection, writeWorkflow } from './workflows.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function formatHelp() {
  return `SDD - Spec Driven Development\n\nUsage:\n  sdd <command>\n\nCommands:\n  install     Install SDD skills\n  workflow    Generate docs/workflow.md for a task type\n  list        Show installed SDD skills\n  update      Update SDD installation\n  doctor      Diagnose SDD installation\n\nWorkflow options (for "sdd workflow"):\n  --type <feature|bug-fix|enhancement>\n  --scope <backend|frontend|both>\n\nOptions:\n  --help\n  --version`;
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

    const requestedTargets = args.includes('--all') ? Object.keys(getSkillGroups()) : ['core'];
    const targetId = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'claude';
    const scope = args.includes('--user') ? 'user' : 'project';

    const result = await installSelectedSkills({
      targetId,
      plugins: requestedTargets,
      scope,
      version: packageJson.version
    });

    return `Installed ${result.installedCount} skills to ${result.installRoot}.`;
  }

  if (command === 'workflow') {
    const args = rest;
    let type = readFlagValue(args, '--type');
    let scope = readFlagValue(args, '--scope');

    if ((!type || !scope) && process.stdin.isTTY) {
      const selection = await askWorkflowSelection({ type, scope });
      type = selection.type;
      scope = selection.scope;
    }

    if (!type || !scope) {
      throw new Error('Missing --type and --scope for non-interactive workflow generation.');
    }

    const result = writeWorkflow({ type, scope, cwd: process.cwd() });

    return `Wrote ${result.type} (${result.scope}) workflow to ${result.path}.`;
  }

  if (command === 'list') {
    return `SDD ${packageJson.version}\nInstalled targets:\nClaude Code`;
  }

  if (command === 'update') {
    return 'Update support is not implemented yet.';
  }

  if (command === 'doctor') {
    return 'Doctor support is not implemented yet.';
  }

  return `${formatHelp()}\n\nUnknown command: ${command}`;
}
