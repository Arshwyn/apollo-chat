// A "trigger-style" message is a coaching trigger phrase or any message that carries photos.
// After one, Apollo is expected to have written a day file; the app checks and warns without content.
export function isTrigger(text, photoCount, phrases) {
  if (photoCount > 0) return true;
  const t = String(text || '').toLowerCase();
  return phrases.some((p) => t.includes(p));
}
