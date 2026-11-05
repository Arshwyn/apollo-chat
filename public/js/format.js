// Tiny, safe text formatting: paragraphs, "- " bullets, # headings, pipe tables and **bold**. Output is plain data; the UI builds
// DOM nodes with textContent, so nothing from the model or the user is ever parsed as HTML.
export function parseInline(line) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), bold: false });
  return parts.length ? parts : [{ text: '', bold: false }];
}

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,4})\s+(.+?)(?:\s+#+)?\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isTableRow = (line) => line.includes('|') && line.trim() !== '';

// Pure parser: text in, plain block data out (p, ul, heading, table). No markup is ever produced.
// Heading levels 1-4 map to two visual levels: 1-2 -> 3, 3-4 -> 4 (`level` is the display level).
export function formatText(text) {
  const blocks = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const bullet = BULLET.exec(raw);
    const heading = HEADING.exec(raw);
    const last = blocks[blocks.length - 1];
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length <= 2 ? 3 : 4, parts: parseInline(heading[2]) });
    } else if (
      isTableRow(raw) &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      const header = splitRow(raw).map(parseInline);
      const rows = [];
      i += 1;
      while (i + 1 < lines.length && isTableRow(lines[i + 1])) {
        i += 1;
        const cells = splitRow(lines[i]).map(parseInline);
        while (cells.length < header.length) cells.push(parseInline(''));
        rows.push(cells.slice(0, header.length));
      }
      blocks.push({ type: 'table', header, rows });
    } else if (bullet) {
      if (last && last.type === 'ul') last.items.push(parseInline(bullet[1]));
      else blocks.push({ type: 'ul', items: [parseInline(bullet[1])] });
    } else if (raw.trim() === '') {
      blocks.push({ type: 'gap' });
    } else if (last && last.type === 'p') {
      last.lines.push(parseInline(raw));
    } else {
      blocks.push({ type: 'p', lines: [parseInline(raw)] });
    }
  }
  return blocks.filter((b) => b.type !== 'gap');
}
