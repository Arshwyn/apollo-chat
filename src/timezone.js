// Time zone sent by the browser (Intl.DateTimeFormat().resolvedOptions().timeZone). It is untrusted input:
// only a plain IANA-style name that Intl accepts is ever used; anything else is ignored (never an error).
// The value is used for dates in the prompt, chat naming and transcript stamps. It never reaches a path,
// a shell or a log line.
const IANA = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

export function parseZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !IANA.test(value)) return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
  } catch {
    return null;
  }
  return value;
}
