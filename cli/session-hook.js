// Claude Code PermissionRequest hook for sdd studio.
//
// Claude Code hands the request to this process on stdin and blocks until it
// exits. The studio answers through a sibling `.answer` file so the human can
// approve or deny from the browser. Timing out prints nothing, which makes
// Claude Code deny the tool call: the safe default.
import fs from 'node:fs';

const requestFile = process.argv[2];
const waitMs = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 50_000;
const answerFile = `${requestFile}.answer`;

if (!requestFile) {
  process.exit(0);
}

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  void decide(raw);
});

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, file);
}

function describeTool(input) {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const keys = ['command', 'file_path', 'path', 'url', 'query', 'pattern'];

  for (const key of keys) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      const value = input[key].trim().replace(/\s+/g, ' ');

      return value.length > 300 ? `${value.slice(0, 297)}…` : value;
    }
  }

  return '';
}

function readDecision() {
  let answer;

  try {
    answer = JSON.parse(fs.readFileSync(answerFile, 'utf8'));
  } catch {
    return null;
  }

  return answer?.behavior === 'allow' ? 'allow' : 'deny';
}

async function decide(input) {
  let event = {};

  try {
    event = JSON.parse(input || '{}');
  } catch {
    // A malformed payload still gets a request so the studio can show it.
  }

  const id = `${Date.now()}-${process.pid}`;

  try {
    writeJson(requestFile, {
      id,
      tool: event.tool_name ?? 'tool',
      detail: describeTool(event.tool_input),
      description: typeof event.tool_input?.description === 'string' ? event.tool_input.description : '',
      at: new Date().toISOString()
    });
  } catch {
    // Without a request file the human has nothing to decide: deny.
    process.exit(0);
  }

  const deadline = Date.now() + waitMs;

  let behavior = null;

  while (Date.now() < deadline) {
    behavior = readDecision();

    if (behavior) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  try {
    fs.rmSync(requestFile, { force: true });
  } catch {
    // Best effort.
  }

  try {
    fs.rmSync(answerFile, { force: true });
  } catch {
    // Best effort.
  }

  if (!behavior) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied in sdd studio.' }
    }
  }));
}
