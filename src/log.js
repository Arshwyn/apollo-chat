// Content-free request log: time, user, method, route template, status, duration. Nothing else is
// ever passed in here (no bodies, titles, filenames, tokens or emails).
export function makeLogger(write = (line) => process.stdout.write(line + '\n')) {
  return {
    request({ user, method, route, status, ms }) {
      write(JSON.stringify({ t: new Date().toISOString(), user: user || '-', method, route, status, ms }));
    },
    event(name, fields = {}) {
      write(JSON.stringify({ t: new Date().toISOString(), event: name, ...fields }));
    },
  };
}
