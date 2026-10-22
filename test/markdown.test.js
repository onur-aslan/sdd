import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

function loadRenderer() {
  const source = fs.readFileSync(new URL('../studio/markdown.js', import.meta.url), 'utf8');
  const context = { window: {} };

  vm.createContext(context);
  vm.runInContext(source, context);

  return context.window.SDDMarkdown;
}

const { render } = loadRenderer();

test('markdown renders headings, emphasis, links, and lists', () => {
  const html = render([
    '# Plan',
    '',
    'A **bold** and *soft* [link](https://example.com).',
    '',
    '- one',
    '- [x] done'
  ].join('\n'));

  assert.match(html, /<h1>Plan<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>soft<\/em>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">link<\/a>/);
  assert.match(html, /<ul><li>one<\/li>/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
});

test('markdown renders Mermaid and ordinary code fences', () => {
  const html = render([
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '```js',
    'const x = 1 < 2;',
    '```'
  ].join('\n'));

  assert.match(html, /<pre class="mermaid">flowchart LR/);
  assert.match(html, /A --&gt; B/);
  assert.match(html, /<code class="language-js">const x = 1 &lt; 2;<\/code>/);
});

test('an unfinished Mermaid fence stays as code until it closes', () => {
  const html = render('```mermaid\nflowchart LR\nA --> B');

  assert.doesNotMatch(html, /<pre class="mermaid">/);
  assert.match(html, /class="language-mermaid"/);
  assert.match(html, /flowchart LR/);
});

test('an interview fence renders as a question card, not code', () => {
  const html = render([
    'Before asking.',
    '',
    '```interview',
    'Which storage should we use?',
    '',
    '- local disk',
    '- a database',
    '```'
  ].join('\n'));

  assert.match(html, /<div class="md-interview">/);
  assert.match(html, /<p class="md-interview-label">Agent asks<\/p>/);
  assert.match(html, /Which storage should we use\?/);
  assert.match(html, /<li>local disk<\/li>/);
  assert.doesNotMatch(html, /class="language-interview"/);
});

test('an unfinished interview fence stays as code until it closes', () => {
  const html = render('```interview\nWhich storage?');

  assert.doesNotMatch(html, /md-interview/);
  assert.match(html, /class="language-interview"/);
});

test('markdown renders tables and blockquotes', () => {
  const html = render([
    '| Check | Owner |',
    '| --- | ---: |',
    '| unit | studio |',
    '',
    '> A note.'
  ].join('\n'));

  assert.match(html, /<table>/);
  assert.match(html, /<th>Check<\/th>/);
  assert.match(html, /<td style="text-align:right">studio<\/td>/);
  assert.match(html, /<blockquote><p>A note\.<\/p><\/blockquote>/);
});

test('markdown escapes raw HTML and refuses unsafe links', () => {
  const html = render('<script>alert(1)</script> [bad](javascript:alert(1)) <img src=x onerror=alert(1)>');

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
});

test('markdown keeps local links but rejects protocol-relative hosts', () => {
  const html = render('[local](/docs/readme) and [host](//evil.example/plan)');

  assert.match(html, /<a href="\/docs\/readme">local<\/a>/);
  assert.doesNotMatch(html, /href="\/\/evil\.example/);
  assert.match(html, /\[host\]\(\/\/evil\.example\/plan\)/);
});

test('markdown strips ANSI colour sequences from terminal output', () => {
  const html = render('\u001b[31mred\u001b[0m plan');

  assert.doesNotMatch(html, /\u001b/);
  assert.match(html, /red plan/);
});
