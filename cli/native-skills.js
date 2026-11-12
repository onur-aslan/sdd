import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Studio runs exactly one agent: Claude Code. Skills are invoked through the
// `/name args` slash-command form that Claude discovers in its skill roots.
export function buildNativeSkillCall(skillName, skillArguments = {}) {
  const args = Object.entries(skillArguments ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => (key === 'arguments' ? String(value) : `${key}=${value}`))
    .join(' ');
  const name = String(skillName ?? '').trim();

  if (!name) {
    const error = new Error('A skill name is required.');
    error.statusCode = 400;
    throw error;
  }

  return `/${name}${args ? ` ${args}` : ''}`;
}

export function claudeSkillRoots(cwd) {
  return [path.join(cwd, '.claude', 'skills'), path.join(os.homedir(), '.claude', 'skills')];
}

export function assertNativeSkillAvailable(cwd, skillName) {
  if (claudeSkillRoots(cwd).some((root) => fs.existsSync(path.join(root, skillName, 'SKILL.md')))) {
    return;
  }

  const error = new Error(
    `Claude Code cannot invoke /${skillName} because the skill is not installed where Claude discovers skills. ` +
    'Install the SDD skills with "sdd install --target claude --user", then retry.'
  );
  error.statusCode = 400;
  throw error;
}
