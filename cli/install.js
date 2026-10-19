import fs from 'node:fs';
import path from 'node:path';

import { writeMcpConfig } from './mcp.js';
import { findLegacyCodexInstall, readMetadata, removeSkillDirectories, skillsRemovedInFourOh, writeMetadata } from './metadata.js';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { resolveTargetPath } from './targets.js';

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

// Codex 3.1.1 and earlier installed skills to .codex/skills; 4.0.0 uses .agents/skills. The old
// directory is never read again, but nothing else removes it, so point it out on upgrade.
function warnAboutLegacyCodexSkills(target) {
  if (target.id !== 'codex') {
    return;
  }

  const legacyInstall = findLegacyCodexInstall(target.baseDir);

  if (!legacyInstall) {
    return;
  }

  console.warn(`[sdd] ${legacyInstall.skillsRoot} holds a pre-4.0.0 SDD installation that Codex no longer reads. Delete that directory to finish the upgrade.`);
}

export async function installSelectedSkills({
  targetId = 'claude',
  plugins = Object.keys(getSkillGroups()),
  scope = 'project',
  cwd = process.cwd(),
  version = '1.0.2',
  conflictHandler = null
}) {
  const selected = Array.isArray(plugins) ? plugins : [plugins];
  const consistentPlugins = selected.filter(Boolean);
  const target = resolveTargetPath(targetId, scope, cwd);

  ensureDirectory(target.installRoot);
  warnAboutLegacyCodexSkills(target);
  let installedCount = 0;
  const selectedSkills = new Set();

  for (const pluginId of consistentPlugins) {
    const pluginConfig = getSkillGroups()[pluginId];
    if (!pluginConfig) {
      throw new Error(`Plugin "${pluginId}" is missing from this package. The installation cannot continue.`);
    }

    const groupDirectory = path.join(pluginConfig.pluginRoot, 'skills');
    if (!fs.existsSync(groupDirectory)) {
      throw new Error(`Plugin "${pluginId}" is missing from this package. The installation cannot continue.`);
    }

    const skills = getSkillsForGroup(pluginId);

    for (const skillName of skills) {
      selectedSkills.add(skillName);
      const source = path.join(groupDirectory, skillName);
      const destination = path.join(target.installRoot, skillName);

      if (fs.existsSync(destination)) {
        const action = conflictHandler
          ? await conflictHandler({ skillName, destination, source, pluginId })
          : 'overwrite';

        if (action === 'skip') {
          continue;
        }
        if (action === 'abort') {
          throw new Error(`Installation aborted while processing Skill: ${skillName}`);
        }
        if (action === 'overwrite' || action === undefined) {
          fs.rmSync(destination, { recursive: true, force: true });
        }
      }

      fs.cpSync(source, destination, { recursive: true, force: true });
      installedCount += 1;
    }
  }

  // Skills the previous install recorded, plus the 4.0.0 removals when that install predates the
  // skill list in the metadata. Everything written above is exempt through selectedSkills.
  const previousMetadata = readMetadata(target.metadataPath);
  const previousSkills = Array.isArray(previousMetadata?.skills) ? previousMetadata.skills : [];
  const isLegacyInstall = previousMetadata !== null && previousSkills.length === 0;
  const removedSkills = removeSkillDirectories(
    target.installRoot,
    [...previousSkills, ...(isLegacyInstall ? skillsRemovedInFourOh : [])]
      .filter((skillName) => !selectedSkills.has(skillName))
  );

  writeMetadata(target.metadataPath, consistentPlugins, version, [...selectedSkills].sort());
  await writeMcpConfig(target, consistentPlugins, scope, cwd);

  return {
    installedCount,
    removedSkills,
    targetId,
    plugins: consistentPlugins,
    scope,
    installRoot: target.installRoot,
    metadataPath: target.metadataPath,
    mcpConfigPath: target.mcpConfigPath
  };
}
