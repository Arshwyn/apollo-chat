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
- Docs: [`docs/DEPLOY.md`](docs/DEPLOY.md) (install and operate), [`docs/ISOLATION.md`](docs/ISOLATION.md) (threat model), [`docs/HOOK.md`](docs/HOOK.md) (host hook changes), [`docs/DESIGN.md`](docs/DESIGN.md) (visual identity and tokens).

## What it does

- **Login:** Cloudflare Access sits in front. The app validates the `Cf-Access-Jwt-Assertion` token (signature against the team's JWKS, issuer, audience, expiry) and maps the email to a user through `USERS`. Unknown email is 403, no token is 401. There are no passwords and no login page.
- **History:** one SQLite file per user (`users/<user>/chat.db`), text only. New chats are named by date (`YYYY-MM-DD`, then `(2)`, `(3)`) in `TZ_NAME`; chats can be renamed and deleted, and a user can delete everything they have.
- **Photos are transient:** up to 4 per message, 10 MB each, JPEG/PNG/WebP by magic bytes. Each is auto-oriented, re-encoded (EXIF and GPS dropped), capped at 2000 px and staged under the user's temp folder. After a successful run the originals are deleted. A photo the person removes before sending is deleted at once (`DELETE /api/photos/:id`; an unknown, malformed or another user's id answers 400 and removes nothing), also when the removal happens while it is still uploading, and best effort when the page closes. A photo that is never sent is swept after about an hour. A failed or cancelled run keeps its photos for at most 24 hours so Retry works. The sweep runs at startup and every 30 minutes. History shows a "photo analysed" placeholder; no thumbnails or image bytes are ever stored.
- **Streaming:** replies stream over server-sent events (`delta`, `interim`, `tool`, `done`, `error`). Only text and a generic tool label reach the browser; tool inputs, outputs and thinking are dropped. Only the text after the run's last tool call is stored, exported and shown as the reply; narration before a tool call arrives as `interim` and shows as a transient status line (if a run ends on a tool call, the last narration is kept so a reply is never empty).
- **Rendering:** message text is parsed into plain data (paragraphs, bullets, `#`-`####` headings, pipe tables, `**bold**`) and the DOM is built with `createElement` and `textContent` only, never `innerHTML`, so HTML in a message is shown as text. Anything unrecognised stays plain text. Replies are set as serif prose without a bubble; the person's own messages are small blocks on the right; tables scroll sideways inside their own frame. The look follows the OS light or dark setting (see `docs/DESIGN.md`).
- **Busy handling:** one run at a time per user (a second send gets 409 and the UI says Apollo is still replying), users run in parallel, a global cap (`MAX_RUNS`) bounds the total, and a user can stop their own reply. A browser that disconnects does not stop the run: the reply is saved and shows on reload. A reload or reconnect mid-run shows the replying indicator and the full reply appears once it is saved; partial text is not replayed. Why: replaying it would need a separate attach stream, and the streaming response belongs to the request that started the run.
- **Transcripts:** after each reply the app writes a plain-text per-user transcript (`users/<user>/transcripts/`, no images) that the agent may grep when asked about something said earlier. The agent never reads the chat database; its day files stay the analytic source of truth.
- **Day-file check:** after a trigger-style message (a coaching trigger phrase or any message with photos) the gateway checks that a file in the user's history folder was written during the run, and the app logs a content-free warning if not.
- **Copy:** every message has a small copy icon in a row directly under it (outside the bubble; right-aligned for the person's turn), and the chats drawer has "Copy conversation" (the whole chat as plain text, labelled `You:` and `Apollo:`, no timestamps or photo chips). Both copy the stored markdown source, not the rendered page, using the Clipboard API with a hidden-textarea fallback for non-secure contexts; a short "Copied" status (an `aria-live` region) confirms it, and touch targets are 44px on coarse pointers. Buttons, header and input chrome are `user-select: none`, so select-all and long-press select only message text. The clipboard interaction itself is not browser-tested; the text serialiser is covered by `test/copy.test.js`.
- **Chats drawer:** opens over a dimmed page; the scrim, the close button or Escape closes it, focus moves into it and back to the menu button, and the page behind is inert while it is open.
- **PWA:** manifest, icons (any and maskable, regenerated by `npm run icons`), and an app-shell service worker that never caches `/api/` or photos. The shell includes the self-hosted font files, so the type renders offline too.

## Configuration

All settings come from the environment (`.env` for the app, a separate env file for the gateway). Placeholders only here; see [`.env.example`](.env.example) and [`gateway/gateway.env.example`](gateway/gateway.env.example).

| Variable                                            | Meaning                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`            | Cloudflare Access team domain and application audience tag                                 |
| `USERS`                                             | `email:user` pairs; user ids are `[a-z][a-z0-9_]{1,19}`                                    |
| `DATA_DIR`                                          | Absolute data directory, outside the repository (the app refuses to start inside it)       |
| `GATEWAY_SOCKET_DIR`                                | Directory that holds `gateway.sock`                                                        |
| `APOLLO_MEMORY_ROOT`                                | The agent's memory root as the host sees it (used to name the user's folder in the prompt) |
| `TZ_NAME`                                           | Fallback IANA time zone when the browser has sent none (default `UTC`)                     |
| `RUN_TIMEOUT_MS`, `MAX_RUNS`, `RATE_LIMIT_PER_HOUR` | Run timeout (default 300000), global concurrency (2), messages per user per hour (30)      |
| `PHOTO_TTL_HOURS`, `REPLAY_TURNS`                   | Failed-run photo retention (24), earlier text turns replayed into each prompt (20)         |
| `STAGED_PHOTO_TTL_MINUTES`                          | Retention of photos attached but never sent (60)                                           |
| `TRIGGER_PHRASES`, `STRIP_TRAILER_LINES`            | Day-file trigger phrases; drop trailing `mail:`/`temp:` housekeeping lines from replies    |

The host clock is UTC, so dates follow the user instead. The browser sends its IANA time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) with every message, retry and new-chat request. The server accepts it only if it is a plain zone name of at most 64 characters that `Intl` knows; anything else is ignored, never an error. The last valid zone is stored in that user's own database (never shared between users, never logged, never used in a path or shell) and is used when a request has none; `TZ_NAME` applies only when nothing valid is known. A change of place takes effect on the next message. The resolved zone drives the chat auto-name (`YYYY-MM-DD`, `(2)`, ...), transcript timestamps and the first line of every run prompt, computed when the run starts: weekday, local date, time, zone and UTC offset, with the instruction to use it for the day-file folder, "today"/"yesterday" and connector date arguments. The gateway's day-file check compares file modification times under the user's history folder and builds no date path, so it needs no zone. Edge: it looks at the history folders for the UTC year and the one before, so a run on 1 January local time east of UTC, while UTC is still 31 December, may log a spurious missing-day-file warning (no effect on the reply).

Chat runs have no shell and no `/tmp`: the prompt tells the agent to skip the temp-file and mail trailer steps and not to glob without a path. A generic "That request was blocked" line is appended to a reply only when the run's last tool call was blocked or the reply text is empty; a blocked call followed by a successful one is not mentioned.

The gateway has its own variables (`DATA_DIR`, `SOCKET_DIR`, `CLAUDE_BIN`, `GATEWAY_USERS`, `APOLLO_MEMORY_ROOT`, `RUN_TIMEOUT_MS`, `MAX_RUNS`, `REQUEST_TIMEOUT_MS`); `GATEWAY_USERS` maps each user to the connector tool prefixes their runs may use. `REQUEST_TIMEOUT_MS` (default 10000) closes a connection that has not sent a complete request line in time; it does not affect a run's own timeout.

## Develop

```
npm ci
npm test        # node --test, includes the hook and gateway suites; no model, no network
npm run lint    # eslint + prettier --check
npm run format
npm run icons   # regenerate public/icons
```

Run locally: `node --env-file=.env src/index.js` (the app needs a reachable gateway socket to answer messages). The test suite uses a fake `claude` script, so no real data or model is involved. The hook tests read `APOLLO_HOOK_PATH`; `npm test` points it at the proposed hook in `docs/host/`, and the host operator re-runs it against the installed hook (see `docs/HOOK.md`).

Node support: the minimum is Node 20 for everything (`engines` in `package.json`). The container image tracks a newer Node (24, pinned by digest), and the host gateway needs only Node 20 because it is dependency-free. `test/nodeSupport.test.js` guards both claims.

## Cloudflare Access

Create one Access application that covers the whole hostname (the app, its manifest and its service worker), with an allow policy for exactly the people in `USERS`. Copy the application's audience tag into `CF_ACCESS_AUD` and the team domain into `CF_ACCESS_TEAM_DOMAIN`. Make the origin reachable only through the tunnel or a firewall so nothing can bypass Access. The manifest link uses `crossorigin="use-credentials"` so the install prompt works behind Access.

## Install on Android

Open the site in Chrome, sign in through Access, then use the browser menu and choose "Install app" (or "Add to Home screen"). It opens full screen with its own icon. The camera button offers the camera and the gallery.

## Privacy

No analytics, telemetry, third-party scripts or external requests (no external fonts either: the typefaces are self-hosted under `public/fonts/`); a strict CSP (`default-src 'self'`). Logs hold only time, user id, method, route template, status, duration and run exit code, never message text, filenames, prompts, tokens or emails. Health data lives only in `DATA_DIR` (outside the repo, mode 0700) and in the agent's own memory folder. Each user can delete their data from the menu.

## Design notes (why)

- **The user binding is an environment variable, set by the gateway.** The host hook cannot tell two simultaneous runs apart through a single lock file, so the gateway sets `APOLLO_USER` (and `APOLLO_CHAT_RUN=1`, `APOLLO_CHAT_DATA`, `APOLLO_RUN_ID`) per process and the hook enforces it for every tool call in that process.
- **Chat runs have no shell.** They get the file tools, web lookups and the user's own connectors; the hook allows file access only on canonical paths inside the user's own folders and denies anything not on its list. See `docs/HOOK.md`.
- **Runs use `--no-session-persistence`.** Claude Code's session transcripts keep image data from tool results, so resuming a session would leave photo bytes on disk. Instead the app replays the last few text turns of the chat into each prompt.
- **A fixed working directory per user** (`users/<user>/work`) keeps runs predictable, and the gateway, not the app, decides every flag, path and environment variable.
- **The service worker never caches the API** so chats and photos never sit in a shared browser cache.
- **Per-user database files** make separation a matter of path, which the host hook can deny, instead of a `WHERE user = ?` that has to be right everywhere.
- **Auto-names take the first free slot** for the day, so a deleted or renamed chat never causes a duplicate.
- **User ids are configuration, not code**, so the repository carries no personal names; the hook and gateway take the real ids from the host.

## Third-party assets

- **Literata** (roman and italic, variable weight and optical size) and **Public Sans** (variable weight), latin subset, in `public/fonts/`. Both are licensed under the SIL Open Font License 1.1 (texts in `public/fonts/OFL-Literata.txt` and `public/fonts/OFL-PublicSans.txt`). The files are the woff2 builds from the `@fontsource-variable/literata` and `@fontsource-variable/public-sans` packages, version 5.3.0, copied in as static files; upstream projects: the Literata project (`googlefonts/literata`) and the Public Sans project (`uswds/public-sans`). No npm dependency is added.

## Licence

MIT, see [LICENSE](LICENSE).
