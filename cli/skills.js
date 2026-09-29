import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const skillGroups = {
  core: {
    id: 'core',
    name: 'Core',
    pluginRoot: path.join(packageRoot, 'sdd')
  },
  frontend: {
    id: 'frontend',
    name: 'Frontend',
    pluginRoot: path.join(packageRoot, 'sdd-frontend')
  },
  backend: {
    id: 'backend',
    name: 'Backend',
    pluginRoot: path.join(packageRoot, 'sdd-backend')
  },
  utility: {
    id: 'utility',
    name: 'Utility',
    pluginRoot: path.join(packageRoot, 'sdd-utility')
  }
};

export function getSkillGroups() {
  return { ...skillGroups };
}

export function getPackageSkillsRoot() {
  return packageRoot;
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
