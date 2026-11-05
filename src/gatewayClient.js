import net from 'node:net';

export class GatewayError extends Error {
  constructor(code) {
    super(`gateway: ${code}`);
    this.code = code;
  }
}

const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Talks to the host gateway over a unix socket. The socket path is re-resolved on every request, so a
// gateway restart (new socket file in the same, bind-mounted directory) is survived by retrying the connect.
export function createGatewayClient({ socketPath, backoffMs = [200, 500, 1000, 2000] }) {
  async function connect(signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const c = net.createConnection(socketPath);
          c.once('connect', () => resolve(c));
          c.once('error', reject);
        });
      } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= backoffMs.length || signal?.aborted)
          throw new GatewayError('unavailable');
        await sleep(backoffMs[attempt]);
      }
    }
  }

  async function exchange(request, onEvent, signal) {
    const c = await connect(signal);
    return new Promise((resolve, reject) => {
      let buf = '';
      let result = null;
      const onAbort = () => c.destroy();
      signal?.addEventListener('abort', onAbort, { once: true });
      c.setEncoding('utf8');
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'error') result = new GatewayError(String(ev.code || 'error'));
          else if (ev.type === 'exit' || ev.type === 'cancelled') result = ev;
          else onEvent?.(ev);
        }
      });
      c.on('error', () => {});
      c.on('close', () => {
        signal?.removeEventListener('abort', onAbort);
        if (result instanceof Error) reject(result);
        else if (result) resolve(result);
        else reject(new GatewayError(signal?.aborted ? 'aborted' : 'closed'));
      });
      c.write(JSON.stringify(request) + '\n');
    });
  }

  return {
    // Resolves with the gateway's exit event; `onLine` receives each raw stream-json line.
    run(request, { onLine, signal } = {}) {
      return exchange(request, (ev) => ev.type === 'line' && onLine?.(ev.data), signal);
    },
    async cancel(runId) {
      try {
        await exchange({ cancel: runId });
        return true;
      } catch {
        return false;
      }
    },
  };
}
