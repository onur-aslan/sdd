#!/usr/bin/env node

import { run } from '../cli/index.js';

const result = await run(process.argv.slice(2));

if (typeof result === 'string') {
  process.stdout.write(`${result}\n`);
}
