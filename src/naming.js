// Auto-names for new conversations: the creation date YYYY-MM-DD in the configured time zone,
// "YYYY-MM-DD (2)", "(3)" ... for further chats on the same local day (first free slot).
export function localDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nextAutoName(existingTitles, ms, timeZone) {
  const taken = new Set(existingTitles);
  const base = localDate(ms, timeZone);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`;
    if (!taken.has(name)) return name;
  }
}

export function cleanTitle(input) {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = input.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length >= 1 && t.length <= 80 ? t : null;
}
