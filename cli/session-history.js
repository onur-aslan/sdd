import fs from 'node:fs';
import path from 'node:path';

// File-based session history. session.json carries the metadata the UI needs
// after a Studio restart; session.md is the human-readable conversation record.
export const SESSION_HISTORY_LIMIT = 20;

export function sessionsRoot(cwd) {
  return path.resolve(cwd, '.sdd', 'sessions');
}

export function sessionRecordDir(cwd, flow, id) {
  return path.join(sessionsRoot(cwd), String(flow), String(id));
}

function roles(role) {
  return role === 'assistant' ? 'Agent' : role === 'user' ? 'You' : '';
}

export function renderSessionMarkdown(record = {}) {
  const lines = [`# ${String(record.flow ?? 'session')} session`, ''];

  if (record.brief) {
    lines.push(String(record.brief), '');
  }

  lines.push(`Status: ${String(record.status ?? '')}`, '');

  for (const turn of Array.isArray(record.turns) ? record.turns : []) {
    if (turn?.role === 'marker') {
      lines.push(`── ${String(turn.text ?? '').trim()} ──`, '');
      continue;
    }

    const heading = roles(turn?.role);

    if (!heading) {
      continue;
    }

    lines.push(`## ${heading}`, '', String(turn.text ?? ''), '');
  }

  return `${lines.join('\n').trim()}\n`;
}

export function writeSessionRecord(cwd, record = {}) {
  const flow = String(record.flow ?? '');
  const id = String(record.id ?? '');

  if (!flow || !id) {
    return null;
  }

  const dir = sessionRecordDir(cwd, flow, id);
  const payload = { ...record };

  delete payload.markdown;

  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, 'session.json');

  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }

  const markdown = record.markdown ?? renderSessionMarkdown(record);

  fs.writeFileSync(path.join(dir, 'session.md'), markdown, 'utf8');

  return dir;
}

export function readSessionRecord(cwd, flow, id) {
  try {
    const file = path.join(sessionRecordDir(cwd, flow, id), 'session.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (!record || typeof record !== 'object') {
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

export function readSessionMarkdown(cwd, flow, id) {
  try {
    return fs.readFileSync(path.join(sessionRecordDir(cwd, flow, id), 'session.md'), 'utf8');
  } catch {
    return '';
  }
}

export function listSessionHistory(cwd, flow, { limit = SESSION_HISTORY_LIMIT } = {}) {
  const dir = path.join(sessionsRoot(cwd), String(flow));
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const record = readSessionRecord(cwd, flow, entry.name);

    if (record) {
      records.push(record);
    }
  }

  return records
    .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))
    .slice(0, limit);
}

export function removeSessionHistory(cwd, flow, id) {
  const dir = sessionRecordDir(cwd, flow, id);

  if (!fs.existsSync(dir)) {
    return false;
  }

  fs.rmSync(dir, { recursive: true, force: true });

  return true;
}
