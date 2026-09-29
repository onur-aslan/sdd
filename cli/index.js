import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

import { installSelectedSkills } from './install.js';
import { getSkillGroups } from './skills.js';
import { askInteractiveInstall } from './prompts.js';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

function formatHelp() {
  return `SDD - Spec Driven Development\n\nUsage:\n  sdd <command>\n\nCommands:\n  install     Install SDD skills\n  list        Show installed SDD skills\n  update      Update SDD installation\n  doctor      Diagnose SDD installation\n\nOptions:\n  --help\n  --version`;
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
