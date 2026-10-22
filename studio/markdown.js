/* A small, dependency-free Markdown renderer for the studio session viewer.
 *
 * It deliberately supports the subset a plan needs: headings, paragraphs,
 * lists, task lists, tables, blockquotes, links, emphasis, code, Mermaid
 * fences, and the `interview` fence that carries an agent's question. Raw HTML
 * is escaped rather than passed through, so agent output cannot inject markup
 * into the page.
 */
(function (global) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripAnsi(value) {
    return String(value ?? '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  }

  function safeHref(raw) {
    const url = String(raw ?? '').trim();

    if (/^(https?:|mailto:)/i.test(url)) {
      return url;
    }

    // A single slash is a local path; two slashes would be a protocol-relative
    // link to another host, which a plan does not need.
    if (/^(#|\/(?!\/)|\.{1,2}\/)/.test(url)) {
      return url;
    }

    return '';
  }

  function renderInline(input) {
    const tokens = [];
    const stash = (html) => {
      const key = `\u0000SDD${tokens.length}\u0000`;
      tokens.push(html);
      return key;
    };

    let text = escapeHtml(input);

    text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (all, label, href) => {
      const safe = safeHref(href);

      if (!safe) {
        return all;
      }

      const external = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';

      return stash(`<a href="${safe}"${external}>${label}</a>`);
    });

    text = text.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
      const trailing = /[.,;:!?)]+$/.exec(url)?.[0] ?? '';
      const clean = trailing ? url.slice(0, -trailing.length) : url;

      return stash(`<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>`) + trailing;
    });

    text = text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

    return text.replace(/\u0000SDD(\d+)\u0000/g, (_, index) => tokens[Number(index)] ?? '');
  }

  function isListItem(line) {
    return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
  }

  function isHorizontalRule(line) {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function isTableStart(lines, index) {
    if (!/^\s*\|/.test(lines[index] ?? '') || index + 1 >= lines.length) {
      return false;
    }

    const separator = splitRow(lines[index + 1]);

    return separator.length > 0 && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isBlockStart(lines, index) {
    const line = lines[index] ?? '';

    return (
      /^\s*$/.test(line) ||
      /^\s*(```+|~~~+)/.test(line) ||
      /^(#{1,6})\s+/.test(line) ||
      isHorizontalRule(line) ||
      /^\s*>/.test(line) ||
      isListItem(line) ||
      isTableStart(lines, index)
    );
  }

  function renderTable(lines, index) {
    const header = splitRow(lines[index]);
    const separator = splitRow(lines[index + 1]);
    const align = header.map((_, cellIndex) => {
      const marker = separator[cellIndex] ?? '';

      if (/^:-+:$/.test(marker)) {
        return 'center';
      }
      if (/^-+:$/.test(marker)) {
        return 'right';
      }
      return 'left';
    });
    const rows = [];
    let cursor = index + 2;

    while (cursor < lines.length && /^\s*\|/.test(lines[cursor]) && !/^\s*$/.test(lines[cursor])) {
      rows.push(splitRow(lines[cursor]));
      cursor += 1;
    }

    const alignAttr = (cellIndex) => (align[cellIndex] === 'left' ? '' : ` style="text-align:${align[cellIndex]}"`);
    const head = header
      .map((cell, cellIndex) => `<th${alignAttr(cellIndex)}>${renderInline(cell)}</th>`)
      .join('');
    const body = rows
      .map((row) => `<tr>${header.map((_, cellIndex) => `<td${alignAttr(cellIndex)}>${renderInline(row[cellIndex] ?? '')}</td>`).join('')}</tr>`)
      .join('');

    return {
      html: `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      next: cursor
    };
  }

  function renderList(lines, index) {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[index]);
    const items = [];
    let cursor = index;

    while (cursor < lines.length && isListItem(lines[cursor])) {
      const match = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[cursor]);
      let content = match?.[1] ?? '';

      cursor += 1;

      while (
        cursor < lines.length &&
        !/^\s*$/.test(lines[cursor]) &&
        !isListItem(lines[cursor]) &&
        /^\s+/.test(lines[cursor])
      ) {
        content += ` ${lines[cursor].trim()}`;
        cursor += 1;
      }

      items.push(content);
    }

    const tag = ordered ? 'ol' : 'ul';
    const html = items
      .map((item) => {
        const task = /^\[([ xX])\]\s+(.*)$/.exec(item);

        if (task) {
          const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';

          return `<li class="md-task"><input type="checkbox" disabled${checked}> <span>${renderInline(task[2])}</span></li>`;
        }

        return `<li>${renderInline(item)}</li>`;
      })
      .join('');

    return { html: `<${tag}>${html}</${tag}>`, next: cursor };
  }

  function render(source) {
    const text = stripAnsi(source).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const out = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (/^\s*$/.test(line)) {
        index += 1;
        continue;
      }

      const fence = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);

      if (fence) {
        const marker = fence[1][0];
        const minLength = fence[1].length;
        const language = (fence[2] || '').toLowerCase();
        const code = [];
        const closing = new RegExp(`^\\s*${marker}{${minLength},}\\s*$`);
        let closed = false;

        index += 1;

        while (index < lines.length && !closing.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }

        if (index < lines.length) {
          closed = true;
          index += 1;
        }

        const body = escapeHtml(code.join('\n'));

        // A fence that is still streaming is shown as code; it becomes a diagram
        // once the closing fence arrives, so a half-written graph is never drawn.
        if ((language === 'mermaid' || language === 'mmd') && closed) {
          out.push(`<div class="md-mermaid"><pre class="mermaid">${body}</pre></div>`);
        } else if (language === 'interview' && closed) {
          // The agent's question is a first-class card in the terminal, so the
          // interview reads as a conversation rather than a code block.
          out.push(
            '<div class="md-interview">'
            + '<p class="md-interview-label">Agent asks</p>'
            + `<div class="md-interview-body">${render(code.join('\n'))}</div>`
            + '</div>'
          );
        } else {
          const className = language ? ` class="language-${escapeHtml(language)}"` : '';

          out.push(`<pre class="md-code"><code${className}>${body}</code></pre>`);
        }
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);

      if (heading) {
        const level = heading[1].length;

        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (isHorizontalRule(line)) {
        out.push('<hr>');
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];

        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }

        out.push(`<blockquote>${quote.map((part) => `<p>${renderInline(part)}</p>`).join('')}</blockquote>`);
        continue;
      }

      if (isTableStart(lines, index)) {
        const table = renderTable(lines, index);

        out.push(table.html);
        index = table.next;
        continue;
      }

      if (isListItem(line)) {
        const list = renderList(lines, index);

        out.push(list.html);
        index = list.next;
        continue;
      }

      const paragraph = [];

      while (index < lines.length && !isBlockStart(lines, index)) {
        paragraph.push(lines[index]);
        index += 1;
      }

      if (paragraph.length === 0) {
        // Defensive: an unrecognized block marker must still make progress.
        paragraph.push(line);
        index += 1;
      }

      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    }

    return out.join('\n');
  }

  global.SDDMarkdown = { escapeHtml, render };
})(typeof window !== 'undefined' ? window : globalThis);
