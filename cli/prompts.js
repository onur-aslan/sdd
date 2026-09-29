import readline from 'node:readline/promises';
import { targets } from './targets.js';
import { getSkillGroups } from './skills.js';

export async function promptTarget(rl) {
  const targetEntries = Object.values(targets);

  console.log('\nSelect target:');
  targetEntries.forEach((target, index) => {
    console.log(`${index + 1}. ${target.name}`);
  });

  const answer = await rl.question('Choose a target [1-5]: ');
  const index = Number.parseInt(answer, 10) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= targetEntries.length) {
    throw new Error('Unknown installation target.');
  }

  return targetEntries[index].id;
}

export async function promptPluginSelection(rl) {
  const groups = Object.values(getSkillGroups());

  console.log('\nSelect plugins:');
  groups.forEach((group, index) => {
    console.log(`${index + 1}. ${group.name}`);
  });

  const answer = await rl.question('Choose plugin numbers separated by commas (or "all"): ');
  const normalized = answer.trim().toLowerCase();

  if (normalized === 'all') {
    return groups.map((group) => group.id);
  }

  const selected = new Set();

  for (const value of normalized.split(',')) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const index = Number.parseInt(trimmed, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= groups.length) {
      throw new Error(`Unknown plugin selection: ${trimmed}`);
    }
    selected.add(groups[index].id);
  }

  if (selected.size === 0) {
    return [groups[0].id];
  }

  return [...selected];
}

export async function promptScope(rl) {
  console.log('\nWhere should SDD be installed?');
  console.log('1. Current project');
  console.log('2. User home directory');
  const answer = await rl.question('Choose a location [1-2]: ');
  const value = Number.parseInt(answer, 10);

  if (value === 2) {
    return 'user';
  }

  return 'project';
}

export async function promptConfirmation(rl, targetId, plugins, scope) {
  console.log(`\nInstalling SDD for ${targets[targetId].name} (${scope})`);
  console.log(`Plugins: ${plugins.join(', ')}`);
  const answer = await rl.question('Proceed? [Y/n]: ');
  return answer.trim().toLowerCase() !== 'n';
}

export async function askInteractiveInstall() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const targetId = await promptTarget(rl);
    const plugins = await promptPluginSelection(rl);
    const scope = await promptScope(rl);
    const confirmed = await promptConfirmation(rl, targetId, plugins, scope);

    if (!confirmed) {
      throw new Error('Installation cancelled.');
    }

    return { targetId, plugins, scope };
  } finally {
    rl.close();
  }
}
