import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const skillGroups = {
  sdd: {
    id: 'sdd',
    name: 'SDD',
    pluginRoot: path.join(packageRoot, 'sdd')
  },
  vibecoding: {
    id: 'vibecoding',
    name: 'Vibecoding',
    pluginRoot: path.join(packageRoot, 'vibecoding')
  }
};

export function getSkillGroups() {
  return { ...skillGroups };
}

export function getSkillsForGroup(groupId) {
  const group = skillGroups[groupId];

  if (!group) {
    return [];
  }

  const groupDirectory = path.join(group.pluginRoot, 'skills');

  if (!fs.existsSync(groupDirectory)) {
    throw new Error(`Plugin "${groupId}" is missing from this package.`);
  }

  return fs
    .readdirSync(groupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
