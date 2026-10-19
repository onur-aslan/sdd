import fs from 'node:fs';
import path from 'node:path';

import { removeMcpConfig } from './mcp.js';
import { findLegacyCodexInstall, readMetadata, removeSkillDirectories, retiredSkillNames } from './metadata.js';
import { getSkillGroups, getSkillsForGroup } from './skills.js';
import { resolveTargetPath, targets } from './targets.js';

function currentSkillNames() {
  return Object.keys(getSkillGroups()).flatMap((pluginId) => getSkillsForGroup(pluginId));
}

function sddSkillNames() {
  return [...currentSkillNames(), ...retiredSkillNames];
}

// Uninstalling means "remove SDD", not "remove this record": every skill directory the package has
// ever shipped is a candidate, so a copy left behind by skills.sh or by an older install whose
// record was overwritten goes away too. Recorded names are added as well, for a skill a newer
// package introduced that this version does not know. Names the package does not know are never
// touched.
function ownedSkillNames(metadata) {
  const recordedSkills = Array.isArray(metadata?.skills) ? metadata.skills : [];

  return [...sddSkillNames(), ...recordedSkills];
}

function removeDirectoryIfEmpty(directory) {
  if (!fs.existsSync(directory) || fs.readdirSync(directory).length > 0) {
    return;
  }

  fs.rmdirSync(directory);
}

export async function uninstallSkills({
  targetIds = null,
  scope = null,
  cwd = process.cwd(),
  removeMcp = true,
  dryRun = false
} = {}) {
  const requestedTargets = targetIds && targetIds.length > 0 ? targetIds : Object.keys(targets);
  const requestedScopes = scope ? [scope] : ['project', 'user'];
  const results = [];

  for (const targetId of requestedTargets) {
    for (const targetScope of requestedScopes) {
      const target = resolveTargetPath(targetId, targetScope, cwd);
      const metadata = readMetadata(target.metadataPath);
      const legacyCodexInstall = target.id === 'codex' ? findLegacyCodexInstall(target.baseDir) : null;

      if (!metadata && !legacyCodexInstall) {
        results.push({
          targetId,
          targetName: targets[targetId].name,
          scope: targetScope,
          installed: false,
          removedSkills: [],
          removedMetadata: false,
          legacyCodexSkills: [],
          mcp: 'absent'
        });
        continue;
      }

      // Without a record the installer cannot prove it owns anything in the skill directory, so
      // only a recorded installation is cleaned up.
      const removedSkills = metadata
        ? removeSkillDirectories(target.installRoot, ownedSkillNames(metadata), { dryRun })
        : [];

      if (!dryRun && metadata) {
        removeDirectoryIfEmpty(target.installRoot);
        fs.rmSync(target.metadataPath, { force: true });
      }

      // A pre-4.0.0 Codex installation is removed completely, but only for the directory names
      // this package has ever shipped, so unrelated skills inside `.codex/skills` stay put.
      const legacyCodexSkills = legacyCodexInstall
        ? removeSkillDirectories(legacyCodexInstall.skillsRoot, sddSkillNames(), { dryRun })
        : [];

      if (!dryRun && legacyCodexInstall) {
        removeDirectoryIfEmpty(legacyCodexInstall.skillsRoot);
        fs.rmSync(legacyCodexInstall.metadataPath, { force: true });
      }

      // Playwright was registered by whichever plugin preceded `sdd`, so any record is worth an
      // attempt: if the target never had the entry, the cleanup simply reports it as absent.
      let mcp = 'kept';

      if (removeMcp) {
        mcp = dryRun ? 'would-remove' : await removeMcpConfig(target, { scope: targetScope, cwd });
      }

      results.push({
        targetId,
        targetName: targets[targetId].name,
        scope: targetScope,
        installed: true,
        removedSkills,
        removedMetadata: Boolean(metadata),
        legacyCodexSkills,
        mcp
      });
    }
  }

  return {
    dryRun,
    targets: results,
    removedSkills: results.flatMap((result) => result.removedSkills),
    foundInstallation: results.some((result) => result.installed)
  };
}
