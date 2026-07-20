// Minimal markdown -> HTML renderer for assistant text blocks.
// No dependency: pi-web keeps Vue as its only runtime dependency, so this
// covers the common subset (headings, bold/italic, inline/fenced code,
// links, nested lists, tables, blockquotes, hr) rather than pulling in a
// full parser.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline rules for one segment of text with no code spans in it.
function inlineText(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Bare URLs not already inside a rendered link.
  s = s.replace(/(^|[^"=>])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s;
}

// Inline rules. The text is split on code spans first so that `**`, `*`,
// `~~` etc. inside backticks are never touched by the other rules.
function inline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      const code = part.match(/^`([^`]+)`$/);
      if (code) return `<code>${escapeHtml(code[1])}</code>`;
      return inlineText(part);
    })
    .join("");
}

// --- lists (nested via indentation) ---

// items: [{ indent, type: "ul"|"ol", text }]
// Renders one list at the indent level of items[0]; deeper runs become a
// nested list inside the previous <li>.
function renderList(items) {
  const base = items[0].indent;
  const type = items[0].type;
  const html = [`<${type}>`];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.indent <= base && it.type !== type) {
      // sibling list of the other type at the same level: close and restart
      html.push(`</${type}>`);
      return html.join("") + renderList(items.slice(i));
    }
    let li = `<li>${inline(it.text)}`;
    i++;
    const children = [];
    while (i < items.length && items[i].indent > base) {
      children.push(items[i]);
      i++;
    }
    if (children.length) li += renderList(children);
    html.push(li + "</li>");
  }
  html.push(`</${type}>`);
  return html.join("");
}

// --- tables ---

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on | not preceded by backslash
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function renderTable(headerLine, sepLine, bodyLines) {
  const aligns = splitRow(sepLine).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return null;
  });
  const attr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
  const cells = (line, tag) =>
    splitRow(line)
      .map((c, idx) => `<${tag}${attr(idx)}>${inline(c)}</${tag}>`)
      .join("");
  const head = `<thead><tr>${cells(headerLine, "th")}</tr></thead>`;
  const body = bodyLines.length
    ? `<tbody>${bodyLines.map((l) => `<tr>${cells(l, "td")}</tr>`).join("")}</tbody>`
    : "";
  return `<table>${head}${body}</table>`;
}

export function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.split("\n");
  const html = [];
  let i = 0;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length) {
      // Preserve intentional single line breaks instead of flattening.
      html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    }
  }

  const listItem = (line) => {
    const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!m) return null;
    return {
      indent: m[1].replace(/\t/g, "  ").length,
      type: /^\d+\.$/.test(m[2]) ? "ol" : "ul",
      text: m[3],
    };
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (with optional language label)
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1];
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      // The copy button is static HTML wired up via event delegation in
      // MessageView.vue (onMarkdownClick), since this output lands in v-html.
      const copyBtn = '<button class="code-copy" type="button" title="Copy code" aria-label="Copy code"></button>';
      html.push(`<pre${langAttr}>${copyBtn}<code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      html.push("<hr>");
      i++;
      continue;
    }

    // Table: a | row whose next line is a separator row
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushParagraph();
      const headerLine = line;
      const sepLine = lines[i + 1];
      i += 2;
      const bodyLines = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        bodyLines.push(lines[i]);
        i++;
      }
      html.push(renderTable(headerLine, sepLine, bodyLines));
      continue;
    }

    // List block: collect consecutive list items, then render (handles nesting)
    if (listItem(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const it = listItem(lines[i]);
        if (!it) break;
        items.push(it);
        i++;
      }
      html.push(renderList(items));
      continue;
    }

    // Blockquote: collect consecutive quoted lines into one block
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();

  return html.join("\n");
}
