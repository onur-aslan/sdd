#!/usr/bin/env node
// Waits for a picker wake file and exits so the CLI re-invokes the agent.
// Usage: node wait-for-wake.mjs <dir> [timeoutSeconds] [prefix]
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const timeoutSeconds = Number(process.argv[3] || 1800);
const prefix = process.argv[4] || "ui-prompt-wake-";

if (!dir) {
  console.error("usage: node wait-for-wake.mjs <dir> [timeoutSeconds] [prefix]");
  process.exit(64);
}

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error("timeoutSeconds must be a positive number");
  process.exit(64);
}

fs.mkdirSync(dir, { recursive: true });

function nextWake() {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return null;
  }
  const hits = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  return hits.length ? path.join(dir, hits[0]) : null;
}

const existing = nextWake();
if (existing) {
  console.log(JSON.stringify({ event: "wake", file: existing, at: Date.now() }));
  process.exit(0);
}

const deadline = Date.now() + timeoutSeconds * 1000;
const timer = setInterval(() => {
  const hit = nextWake();
  if (hit) {
    clearInterval(timer);
    console.log(JSON.stringify({ event: "wake", file: hit, at: Date.now() }));
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    clearInterval(timer);
    console.log(JSON.stringify({ event: "timeout", at: Date.now() }));
    process.exit(2);
  }
}, 200);
