import fs from 'node:fs';
import path from 'node:path';

// Skills that were removed in 4.0.0. A pre-4.0.0 install record only stored plugin ids, so it
// cannot name them; without this list an upgrade would leave them on disk forever.
export const skillsRemovedInFourOh = [
  'backend-enhancement',
  'bug-fix-backend',
  'bug-fix-frontend',
  'feature-developer',
  'feature-implementer',
  'feature-web-developer',
  'frontend-enhancement',
  'implementer',
  'init-feature',
  'sdd-review',
  'spec-test-writer',
  'verify-with-curl',
  'verify-with-playwright-mcp'
];

// Skill directories that shipped in older releases and are gone today. Only a full uninstall
// touches these, because a live install cannot prove it still owns such names.
export const retiredSkillNames = [
  ...skillsRemovedInFourOh,
  'chicago-tdd',
  'code-slop-review',
  'gap-analysis',
  'handoff',
  'handoff-resume',
  'prd-test-writer',
  'prd-to-task',
  'spec-to-prd',
  'ui-heuristic-click-audit',
  'using-playwright-mcp',
  'workflow-gateway',
  'workflow-generator'
];

export function readMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    return metadata && typeof metadata === 'object' ? metadata : null;
  } catch {
    return null;
  }
}

export function writeMetadata(metadataPath, plugins, version, skills) {
  const metadata = {
    version,
    plugins,
    skills,
    installedAt: new Date().toISOString()
  };

  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

// Only directory names are ever deleted, and only ones this installer recorded itself, so a
// hand-edited metadata file cannot point the cleanup outside the install root.
export function isSafeSkillName(skillName) {
  return typeof skillName === 'string'
    && skillName.length > 0
    && skillName !== '.'
    && skillName !== '..'
    && skillName === path.basename(skillName);
}

// Returns the sorted skill directories that were removed, or that would be removed on a dry run.
export function removeSkillDirectories(installRoot, skillNames, { dryRun = false } = {}) {
  const removed = [];

  for (const skillName of new Set(skillNames)) {
    if (!isSafeSkillName(skillName)) {
      continue;
    }

    const destination = path.join(installRoot, skillName);

    if (!fs.existsSync(destination)) {
      continue;
    }

    if (!dryRun) {
      fs.rmSync(destination, { recursive: true, force: true });
    }

    removed.push(skillName);
  }

  return removed.sort();
}

// Codex 3.1.1 and earlier installed skills to .codex/skills; 4.0.0 uses .agents/skills. The old
// metadata file is what proves the directory was written by this package rather than by hand.
export function findLegacyCodexInstall(baseDir) {
  const skillsRoot = path.resolve(baseDir, '.codex', 'skills');
  const metadataPath = path.resolve(baseDir, '.codex', 'sdd.json');

  if (!fs.existsSync(skillsRoot) || !fs.existsSync(metadataPath)) {
    return null;
  }

  return { skillsRoot, metadataPath };
}
