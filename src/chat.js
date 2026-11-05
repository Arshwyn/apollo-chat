import { HttpError } from './errors.js';
import { readJson, SECURITY_HEADERS } from './server.js';

function sse(res, runHandle) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!res.destroyed && res.writable) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const { events, userMessage, assistantMessage } = runHandle;
  send('start', { userMessage, assistantMessage });
  // A browser that goes away does not stop the run: the reply is saved and visible on reload.
  for (const name of ['delta', 'interim', 'tool', 'done', 'error']) events.on(name, (d) => send(name, d));
  events.once('end', () => res.end());
  res.on('close', () => events.removeAllListeners());
  return new Promise((resolve) => res.on('close', resolve));
}

export function chatRoutes({ runs }) {
  return [
    [
      'POST',
      '/api/conversations/:id/messages',
      async ({ req, res, user, params }) => {
        const body = await readJson(req);
        if (body.photoIds !== undefined && !Array.isArray(body.photoIds))
          throw new HttpError(400, 'invalid photos');
        const handle = runs.start({
          user,
          conversationId: params.id,
          text: body.text,
          photoIds: body.photoIds || [],
        });
        await sse(res, handle);
      },
    ],
    [
      'POST',
      '/api/conversations/:id/retry',
      async ({ res, user, params }) => {
        await sse(res, runs.retry({ user, conversationId: params.id }));
      },
    ],
    [
      'POST',
      '/api/conversations/:id/cancel',
      async ({ user, params }) => {
        await runs.cancel({ user, conversationId: params.id });
        return { ok: true };
      },
    ],
  ];
}
