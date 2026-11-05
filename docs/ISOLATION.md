# Isolation model

Two people use the app. Neither may see the other's chats, photos, transcripts or health connectors. This page says who can see what and what enforces it.

## Who can see what

| Data                                        | Owner can                                 | Other user can                      | Enforced by                                                                                   |
| ------------------------------------------- | ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Chat history (`users/<user>/chat.db`)       | read, rename, delete                      | nothing; their id returns 404       | separate files per user, the store opens only the verified user's path, every route is scoped |
| Staged and run photos (`users/<user>/tmp/`) | upload, send, remove an unsent one        | nothing; their photo id is rejected | per-user directories, ids are random and checked against the caller's tree                    |
| Transcripts (`users/<user>/transcripts/`)   | nothing directly; the agent may grep them | nothing                             | per-user directories, the host hook allows only the active user's folder                      |
| Agent memory and day files                  | nothing directly                          | nothing                             | the host hook (per process, from `APOLLO_USER`)                                               |
| Health connectors                           | through the agent                         | not through their run               | gateway tool lists plus the host hook                                                         |

## Layers

1. **Identity.** Only a valid Cloudflare Access token for a mapped email gets in. The user comes from the verified token and nowhere else (no parameter, header or body field is read for it).
2. **App.** Per-user database files, per-user directories, ids validated against strict patterns, `404` for anything that is not the caller's.
3. **Gateway.** Accepts only `{user, prompt, run_id, photo_paths, check_dayfile}`; the user must be a configured id; photo paths must resolve (symlinks followed) into that user's run directory; the gateway alone builds the argv, working directory and environment, and sets `APOLLO_USER`, `APOLLO_CHAT_RUN=1` and `APOLLO_CHAT_DATA`. Tool allow and deny lists are computed per user from `GATEWAY_USERS`; chat runs get no shell.
4. **Host hook.** Reads the user, data directory and run id from per-process variables, fails closed on missing or invalid values, on a conflict with the lock and on malformed hook input, and applies a default-deny allowlist to every tool call in the run (not only a call tagged as the agent). File tools are allowed only on canonical paths inside the user's own memory folder, transcripts folder or this run's photo folder; connectors only the user's own. See [`HOOK.md`](HOOK.md).
5. **Tests.** `test/isolation.test.js` and `test/api.test.js` (API and storage), `test/gateway.test.js` (gateway), `test/hook/hook.test.js` (the hook, with both users running in parallel).

## Residual risk (be honest about it)

- Chat runs have no shell: the tool surface is the file tools, web lookups and the user's connectors, and the hook confines the file tools by canonical path. All runs still share one OS user, so the hook is defence in depth; the stronger boundary would be separate OS users or containers.
- **Prompt injection.** Screenshots are untrusted input and could carry instructions. The tool allowlist, the connector denylist and the hook limit what an injected instruction could do; they do not make it harmless.
- A process that can reach the gateway socket can ask for a run for either user. The socket is group-restricted (0660 in a 0750 directory) and should stay reachable only by the app container and the service user.
- Logs and the database never hold photos, but chat text is stored in plain SQLite files readable by the service user and by backups of `DATA_DIR`.
