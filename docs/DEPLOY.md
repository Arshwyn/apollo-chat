# Deploying apollo-chat

The app runs as a container. Apollo runs on the host, launched by a small gateway over a unix socket. The container holds no Claude credentials and no `claude` binary. All paths below are placeholders.

```
container (app)  --unix socket (directory bind-mount)-->  host gateway  -->  claude -p --agent apollo
   DATA_DIR  <---- same absolute path on both sides ---->  DATA_DIR
```

## What goes where

| Piece                           | Runs                                              | Reads                                                                       |
| ------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| App (`src/`, `public/`)         | container, Node 24                                | its `.env`, `DATA_DIR`, the socket directory                                |
| Gateway (`gateway/gateway.mjs`) | host, systemd unit, host Node 20, no dependencies | its env file, `DATA_DIR`, the agent memory root (read only, day-file check) |
| Agent, rules, persona, memory   | host (existing)                                   | per run, nothing to restart                                                 |
| Isolation hook                  | host `~/.claude` (existing, edited once)          | per tool call                                                               |

## One-time host steps

1. **Data directory.** Create an absolute `DATA_DIR` outside any repository, owned by the service user, mode 0700 (the app creates `users/<user>/...` with 0700/0600). Decide retention: chats and transcripts are text and are kept until the user deletes them; photos are transient (deleted at once when discarded, about 1 h for photos never sent, 24 h at most after a failed run). Exclude `users/*/tmp/` from backups.
2. **Container user.** The container user's uid and gid (`APP_UID`, `APP_GID`) must match the host owner of `DATA_DIR/users`, or share a group with group-write, so the host-run `claude` can read photos the app writes and the app can read the transcript and day-file paths it checks.
3. **Gateway socket directory.** Create a dedicated directory (mode 0750, group shared with the container user). The gateway creates `gateway.sock` inside it with mode 0660. Confirm no other host user can reach it.
4. **Gateway unit.** Copy `gateway/gateway.env.example` to a private file (mode 0600), fill it in (`GATEWAY_USERS` maps each user to the connector tool prefixes their runs may use), adapt `gateway/apollo-chat-gateway.service` (service user, group, paths), install it and enable it. The unit needs only Node 20 on the host; no Node 24 install is required.
5. **Agent resolution.** `--agent apollo` is project-scoped. Make it resolvable from the gateway's neutral working directory without duplicating the agent: add a user-level link `~/.claude/agents/apollo.md` pointing at the one agent file, and confirm the orchestrator can still spawn it. Fallback: add the workspace with `--add-dir` (broader read access; the hook rules matter more then).
6. **Isolation hook.** Apply the proposed hook and rules text from [`docs/HOOK.md`](HOOK.md). This must be done before the app is exposed.
7. **Rules text.** Add the short rules.md paragraph given in `docs/HOOK.md` (durable facts from free chat, photo numbers written before replying).
8. **Retention for Claude Code sessions.** Chat runs write no session transcript (`--no-session-persistence`), but Claude Code transcripts do retain image data from tool results. Set an explicit `cleanupPeriodDays` in the host settings (a short, approved value; it affects all sessions), and make sure orchestrator-run sessions that handled photos are covered by the same retention.
9. **Cloudflare.** Create the Access application and policy as described in the README, record the audience tag and team domain in the app's `.env`, and route the tunnel or ingress to the app port. Nothing may reach the origin except through Access.
10. **Monitoring.** Add a check on `GET /healthz` (returns `{"ok":true}`, no content) to the watchdog.

## Deploy the app

```
cp .env.example .env     # fill in; stays untracked
docker compose up -d --build
```

Compose bind-mounts `DATA_DIR` and `GATEWAY_SOCKET_DIR` at the same absolute path as on the host and runs the container read-only with no capabilities. The socket directory (not the socket file) is mounted, so the app reconnects by itself after the gateway restarts; the client retries the connect with backoff.

The Daily logs screen needs the gateway and the app to match: restart the gateway unit first, then use the new app image. A running older gateway rejects the day-file requests, so the screen shows that daily logs are unavailable until it is restarted. `APOLLO_MEMORY_ROOT` must be set in the gateway's env file (it is already used for the day-file check); the container needs no new variable, mount or compose change and still cannot see the agent's memory.

Node versions: everything supports Node 20 or newer (`engines`); the container image runs Node 24 and the host gateway needs only Node 20.

## What needs a restart

| Change                                                                | Restart                             |
| --------------------------------------------------------------------- | ----------------------------------- |
| `gateway/gateway.mjs`, `gateway/dayfiles.mjs` or the gateway env file | the gateway unit only               |
| App code, `public/`, app `.env`                                       | rebuild and restart the container   |
| Agent file, rules.md, persona, memory, the isolation hook             | nothing: they are read on every run |

## Acceptance checks after install (host operator)

1. Run the hook tests against the installed hook: `APOLLO_HOOK_PATH=/path/to/installed/hook npm test`.
2. Gateway rejections on the live socket: an unknown user, a photo path outside the user's run directory, and an extra request field (`args`, `env`, `cwd`) must each return `{"type":"error","code":"invalid"}`. `test/gateway.test.js` runs the same cases against a fake CLI.
3. End to end with a harmless read-only prompt for each user: the user's own Onyx connector works (and the Oura connector for a user who has one); the mail, calendar, drive and docs connectors are refused.
4. Parallel isolation: start one real run for each user at the same time with a prompt that tries to read the other user's folder. Both must be denied and both users' replies unaffected.
5. Re-verify the orchestrator's lock-based Apollo flow: spawn, own-folder access, other-folder denial.

Record the results in the host changelog.
