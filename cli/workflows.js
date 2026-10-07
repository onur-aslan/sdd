import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const workflowsDir = fileURLToPath(new URL('./workflows', import.meta.url));

const workflowTypes = [
  { id: 'feature', name: 'Feature Development' },
  { id: 'bug-fix', name: 'Bug Fix' },
  { id: 'enhancement', name: 'Enhancement' }
];

const workflowScopes = [
  { id: 'backend', name: 'Backend' },
  { id: 'frontend', name: 'Frontend' },
  { id: 'both', name: 'Both' }
];

const templates = {
  feature: {
    backend: 'workflow-feature-development-backend.md',
    frontend: 'workflow-feature-frontend-development.md'
  },
  'bug-fix': {
    backend: 'workflow-bug-fix-backend.md',
    frontend: 'workflow-bug-fix-frontend.md'
  },
  enhancement: {
    backend: 'workflow-enhancement-backend.md',
    frontend: 'workflow-enhancement-frontend.md'
  }
};

export function getWorkflowTypes() {
  return workflowTypes.map((entry) => ({ ...entry }));
}

export function getWorkflowScopes() {
  return workflowScopes.map((entry) => ({ ...entry }));
}

export function buildWorkflowContent(type, scope) {
  const typeTemplates = templates[type];

  if (!typeTemplates) {
    throw new Error(`Unknown workflow type: ${type}`);
  }

  if (!workflowScopes.some((entry) => entry.id === scope)) {
    throw new Error(`Unknown workflow scope: ${scope}`);
  }

  if (scope === 'both') {
    // Fullstack selected: use the frontend development workflow as the guide
    return fs.readFileSync(path.join(workflowsDir, typeTemplates['frontend']), 'utf8').trimEnd();
  }

  return fs.readFileSync(path.join(workflowsDir, typeTemplates[scope]), 'utf8').trimEnd();
}

export function writeWorkflow({ type, scope, cwd = process.cwd() }) {
  const docsDirectory = path.join(cwd, 'docs');
  fs.mkdirSync(docsDirectory, { recursive: true });

  const targetPath = path.join(docsDirectory, 'workflow.md');
  fs.writeFileSync(targetPath, `${buildWorkflowContent(type, scope)}\n`, 'utf8');

  return { type, scope, path: targetPath };
}

async function promptChoice(rl, title, entries) {
  console.log(`\n${title}`);
  entries.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry.name}`);
  });

  const answer = await rl.question(`Choose [1-${entries.length}]: `);
  const index = Number.parseInt(answer, 10) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error(`Unknown selection: ${answer}`);
  }

  return entries[index].id;
}

export async function askWorkflowSelection({ type = null, scope = null } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const selectedType = type ?? (await promptChoice(rl, 'What do you want to do?', workflowTypes));
    const selectedScope = scope ?? (await promptChoice(rl, 'Is this Backend, Frontend, or Both?', workflowScopes));

    return { type: selectedType, scope: selectedScope };
  } finally {
    rl.close();
  }
}
