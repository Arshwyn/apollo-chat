# apollo-chat

A small private web chat for talking to a coaching agent. Each person signs in through Cloudflare Access, sees only their own chats, can send food photos and screenshots, and installs the app on Android as a PWA (home-screen icon, full screen, camera and gallery upload).

The app is a thin wrapper. The agent itself (Claude Code, `--agent apollo`) runs headless on the host, one run per message, with the agent's existing instructions, rules and per-user memory folder. There is no second copy of the agent.

## Architecture

```
 phone (PWA) --https--> Cloudflare Access --> app container (Node)        host
                          verifies the user    - verifies the Access JWT
                                               - per-user SQLite chats    gateway (Node, no deps)
                                               - photo staging + cleanup    listens on a unix socket
                                               - queue, SSE streaming   -->   builds the fixed argv + env
                                                                              launches `claude -p --agent apollo`
                                                                              streams stream-json back
```

- `src/`: the app (container). No `claude` binary and no Claude credentials are in the image.
- `gateway/gateway.mjs`: the host-side runner. Dependency-free, runs on a plain Node 20.
- `public/`: the PWA (vanilla JS, no build step).
- `docs/host/`: the proposed host isolation hook (not part of the app).
- Docs: [`docs/DEPLOY.md`](docs/DEPLOY.md) (install and operate), [`docs/ISOLATION.md`](docs/ISOLATION.md) (threat model), [`docs/HOOK.md`](docs/HOOK.md) (host hook changes).

## What it does

- **Login:** Cloudflare Access sits in front. The app validates the `Cf-Access-Jwt-Assertion` token (signature against the team's JWKS, issuer, audience, expiry) and maps the email to a user through `USERS`. Unknown email is 403, no token is 401. There are no passwords and no login page.
- **History:** one SQLite file per user (`users/<user>/chat.db`), text only. New chats are named by date (`YYYY-MM-DD`, then `(2)`, `(3)`) in `TZ_NAME`; chats can be renamed and deleted, and a user can delete everything they have.
- **Photos are transient:** up to 4 per message, 10 MB each, JPEG/PNG/WebP by magic bytes. Each is auto-oriented, re-encoded (EXIF and GPS dropped), capped at 2000 px and staged under the user's temp folder. After a successful run the originals are deleted. A failed or cancelled run keeps them for at most 24 hours so Retry works; a sweep at startup and every 30 minutes removes anything older. History shows a "photo analysed" placeholder; no thumbnails or image bytes are ever stored.
- **Streaming:** replies stream over server-sent events (`delta`, `tool`, `done`, `error`). Only text and a generic tool label reach the browser; tool inputs, outputs and thinking are dropped.
- **Busy handling:** one run at a time per user (a second send gets 409 and the UI says Apollo is still replying), users run in parallel, a global cap (`MAX_RUNS`) bounds the total, and a user can stop their own reply. A browser that disconnects does not stop the run: the reply is saved and shows on reload.
- **Transcripts:** after each reply the app writes a plain-text per-user transcript (`users/<user>/transcripts/`, no images) that the agent may grep when asked about something said earlier. The agent never reads the chat database; its day files stay the analytic source of truth.
- **Day-file check:** after a trigger-style message (a coaching trigger phrase or any message with photos) the gateway checks that a file in the user's history folder was written during the run, and the app logs a content-free warning if not.
- **PWA:** manifest, icons (any and maskable), and an app-shell service worker that never caches `/api/` or photos.

## Configuration

All settings come from the environment (`.env` for the app, a separate env file for the gateway). Placeholders only here; see [`.env.example`](.env.example) and [`gateway/gateway.env.example`](gateway/gateway.env.example).

| Variable                                            | Meaning                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`            | Cloudflare Access team domain and application audience tag                                 |
| `USERS`                                             | `email:user` pairs; user ids are `[a-z][a-z0-9_]{1,19}`                                    |
| `DATA_DIR`                                          | Absolute data directory, outside the repository (the app refuses to start inside it)       |
| `GATEWAY_SOCKET_DIR`                                | Directory that holds `gateway.sock`                                                        |
| `APOLLO_MEMORY_ROOT`                                | The agent's memory root as the host sees it (used to name the user's folder in the prompt) |
| `TZ_NAME`                                           | IANA time zone for chat names and transcripts (default `UTC`)                              |
| `RUN_TIMEOUT_MS`, `MAX_RUNS`, `RATE_LIMIT_PER_HOUR` | Run timeout (default 300000), global concurrency (2), messages per user per hour (30)      |
| `PHOTO_TTL_HOURS`, `REPLAY_TURNS`                   | Failed-run photo retention (24), earlier text turns replayed into each prompt (20)         |
| `TRIGGER_PHRASES`, `STRIP_TRAILER_LINES`            | Day-file trigger phrases; drop trailing `mail:`/`temp:` housekeeping lines from replies    |

The gateway has its own variables (`DATA_DIR`, `SOCKET_DIR`, `CLAUDE_BIN`, `GATEWAY_USERS`, `APOLLO_MEMORY_ROOT`, `RUN_TIMEOUT_MS`, `MAX_RUNS`); `GATEWAY_USERS` maps each user to the connector tool prefixes their runs may use.

## Develop

```
npm ci
npm test        # node --test, includes the hook and gateway suites; no model, no network
npm run lint    # eslint + prettier --check
npm run format
npm run icons   # regenerate public/icons
```

Run locally: `node --env-file=.env src/index.js` (the app needs a reachable gateway socket to answer messages). The test suite uses a fake `claude` script, so no real data or model is involved. The hook tests read `APOLLO_HOOK_PATH`; `npm test` points it at the proposed hook in `docs/host/`, and the host operator re-runs it against the installed hook (see `docs/HOOK.md`).

The app targets Node 24 in the container and also runs on Node 20 (the gateway needs only Node 20).

## Cloudflare Access

Create one Access application that covers the whole hostname (the app, its manifest and its service worker), with an allow policy for exactly the people in `USERS`. Copy the application's audience tag into `CF_ACCESS_AUD` and the team domain into `CF_ACCESS_TEAM_DOMAIN`. Make the origin reachable only through the tunnel or a firewall so nothing can bypass Access. The manifest link uses `crossorigin="use-credentials"` so the install prompt works behind Access.

## Install on Android

Open the site in Chrome, sign in through Access, then use the browser menu and choose "Install app" (or "Add to Home screen"). It opens full screen with its own icon. The camera button offers the camera and the gallery.

## Privacy

No analytics, telemetry, third-party scripts, fonts or external requests; a strict CSP (`default-src 'self'`). Logs hold only time, user id, method, route template, status, duration and run exit code, never message text, filenames, prompts, tokens or emails. Health data lives only in `DATA_DIR` (outside the repo, mode 0700) and in the agent's own memory folder. Each user can delete their data from the menu.

## Design notes (why)

- **The user binding is an environment variable, set by the gateway.** The host hook cannot tell two simultaneous runs apart through a single lock file, so the gateway sets `APOLLO_USER` (and `APOLLO_CHAT_RUN=1`, `APOLLO_CHAT_DATA`) per process and the hook enforces it for every tool call in that process. See `docs/HOOK.md`.
- **Runs use `--no-session-persistence`.** Claude Code's session transcripts keep image data from tool results, so resuming a session would leave photo bytes on disk. Instead the app replays the last few text turns of the chat into each prompt.
- **A fixed working directory per user** (`users/<user>/work`) keeps runs predictable, and the gateway, not the app, decides every flag, path and environment variable.
- **The service worker never caches the API** so chats and photos never sit in a shared browser cache.
- **Per-user database files** make separation a matter of path, which the host hook can deny, instead of a `WHERE user = ?` that has to be right everywhere.
- **Auto-names take the first free slot** for the day, so a deleted or renamed chat never causes a duplicate.
- **User ids are configuration, not code**, so the repository carries no personal names; the hook and gateway take the real ids from the host.

## Licence

MIT, see [LICENSE](LICENSE).
