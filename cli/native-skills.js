import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NATIVE_SKILL_AGENTS = new Set(['claude', 'cursor', 'codex', 'opencode', 'antigravity']);

export function resolveNativeSkillAgent(agentPreset, command) {
  const configured = String(agentPreset ?? '').trim().toLowerCase();
  if (NATIVE_SKILL_AGENTS.has(configured)) return configured;

  const executable = path.basename(String(command?.argv?.[0] ?? '')).toLowerCase().replace(/\.(cmd|exe|bat|ps1|sh)$/, '');
  if (executable === 'claude') return 'claude';
  if (executable === 'cursor' || executable === 'cursor-agent') return 'cursor';
  if (executable === 'codex') return 'codex';
  if (executable === 'opencode') return 'opencode';
  if (executable === 'agy' || executable === 'antigravity') return 'antigravity';

  return '';
}

export function buildNativeSkillCall(skillName, agentPreset, skillArguments = {}) {
  const args = Object.entries(skillArguments)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const agent = String(agentPreset ?? '').trim().toLowerCase();
  const detail = args ? ` Studio arguments: ${args}.` : '';

  if (agent === 'codex') return `Use the $${skillName} skill.${detail}`;
  if (agent === 'opencode') return `Load the ${skillName} skill by exact name using OpenCode's native skill tool, then follow it.${detail}`;
  if (agent === 'claude' || agent === 'cursor' || agent === 'antigravity') return `/${skillName}${detail ? `\n${detail.trim()}` : ''}`;

  const error = new Error('A supported native skill-capable agent must be selected; skill text is never embedded as a fallback.');
  error.statusCode = 400;
  throw error;
}

function skillRoots(agentPreset, cwd) {
  const project = (relative) => path.join(cwd, relative);
  const home = os.homedir();

  switch (String(agentPreset ?? '').trim().toLowerCase()) {
    case 'claude':
      return [project('.claude/skills'), path.join(home, '.claude', 'skills')];
    case 'cursor':
      return [project('.cursor/skills'), project('.agents/skills'), project('.claude/skills'), project('.codex/skills'), path.join(home, '.cursor', 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'skills')];
    case 'codex':
      return [project('.agents/skills'), ...(process.env.CODEX_HOME ? [path.join(process.env.CODEX_HOME, 'skills')] : []), path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')];
    case 'opencode':
      return [project('.opencode/skills'), project('.claude/skills'), project('.agents/skills'), path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')];
    case 'antigravity':
      return [
        project('.agent/skills'),
        project('.agents/skills'),
        project('.antigravity/skills'),
        project('.cursor/skills'),
        project('.claude/skills'),
        project('.codex/skills'),
        path.join(home, '.gemini', 'antigravity', 'skills'),
        path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'),
        path.join(home, '.antigravity', 'skills'),
        path.join(home, '.agents', 'skills'),
        path.join(home, '.cursor', 'skills'),
        path.join(home, '.claude', 'skills')
      ];
    default:
      return [];
  }
}

export function assertNativeSkillAvailable(cwd, agentPreset, skillName) {
  const agent = String(agentPreset ?? '').trim().toLowerCase();
  if (!NATIVE_SKILL_AGENTS.has(agent)) {
    const error = new Error(`The ${agent || 'custom'} agent has no configured native SDD skill invocation. Choose Claude Code, Cursor, Codex, OpenCode, or Antigravity.`);
    error.statusCode = 400;
    throw error;
  }

  if (skillRoots(agent, cwd).some((root) => fs.existsSync(path.join(root, skillName, 'SKILL.md')))) return;

  const invoke = agent === 'codex' ? `$${skillName}` : agent === 'opencode' ? `the native skill tool for ${skillName}` : `/${skillName}`;
  const error = new Error(
    `${agent} cannot invoke ${invoke} because the skill is not installed where this agent discovers skills. ` +
    `Install the SDD skills with "sdd install --target ${agent} --user", then retry.`
  );
  error.statusCode = 400;
  throw error;
}
