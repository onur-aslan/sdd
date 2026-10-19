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

const templates = {
  feature: 'workflow-feature-development.md',
  'bug-fix': 'workflow-bug-fix.md',
  enhancement: 'workflow-enhancement.md'
};

export function getWorkflowTypes() {
  return workflowTypes.map((entry) => ({ ...entry }));
}

export function buildWorkflowContent(type) {
  const template = templates[type];

  if (!template) {
    throw new Error(`Unknown workflow type: ${type}`);
  }

  return fs.readFileSync(path.join(workflowsDir, template), 'utf8').trimEnd();
}

export function writeWorkflow({ type, cwd = process.cwd() }) {
  const docsDirectory = path.join(cwd, 'docs');
  fs.mkdirSync(docsDirectory, { recursive: true });

  const targetPath = path.join(docsDirectory, 'workflow.md');
  fs.writeFileSync(targetPath, `${buildWorkflowContent(type)}\n`, 'utf8');

  return { type, path: targetPath };
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

export async function askWorkflowSelection({ type = null } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const selectedType = type ?? (await promptChoice(rl, 'What do you want to do?', workflowTypes));

    return { type: selectedType };
  } finally {
    rl.close();
  }
}
