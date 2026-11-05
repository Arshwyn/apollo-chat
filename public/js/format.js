// Tiny, safe text formatting: paragraphs, "- " bullets and **bold**. Output is plain data; the UI builds
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

export function formatText(text) {
  const blocks = [];
  for (const raw of String(text).split('\n')) {
    const bullet = BULLET.exec(raw);
    const last = blocks[blocks.length - 1];
    if (bullet) {
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
