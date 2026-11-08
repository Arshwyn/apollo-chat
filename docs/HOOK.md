# Host hook changes (applied by the host operator, not by this app)

`docs/host/apollo-isolation-pre.proposed.sh` is the full proposed replacement for the host PreToolUse isolation hook. The app does not install it. It is shipped here so it can be reviewed and tested with this repository's suite (`test/hook/hook.test.js`).

## What changes compared with a lock-file-only hook

1. **Chat runs use a structural allowlist, not string matching.** When `APOLLO_CHAT_RUN=1` (set by the gateway), the user is `APOLLO_USER`, the data directory is `APOLLO_CHAT_DATA` and the run is `APOLLO_RUN_ID`, all set per process. Any of these deny every tool call: a missing or invalid user, a missing or relative data directory, a missing or malformed run id, or a lock file that names a different user (conflict; an empty lock or the same user is fine). The checks apply to every tool call in the process whatever `agent_type` it carries.
2. **No shell in chat runs.** The gateway no longer allows Bash and the hook denies it too (defence in depth). Chat runs need only the file tools, web lookups, `ToolSearch` and the user's own connectors.
3. **File tools are confined by canonical path.** `Read`, `Write`, `Edit`, `Grep` and `Glob` must name an absolute path with no wildcard or control characters. The path is canonicalised first (symlinks resolved, `..` segments collapsed), so a `..` in a path is harmless only when the collapsed result still lies inside an allowed folder; the check is on the canonical result, never on the text. It must lie inside this user's own memory folder, or (read-only) this user's transcripts folder or this run's photo folder. `Write` and `Edit` are limited to the memory folder. `Grep` and `Glob` require a path. The Glob pattern and the Grep `glob` filter are only filters under that confined path, so they follow a separate, stricter text rule: relative (no leading `/` or `~`), no `..` segment at all (patterns are never collapsed, so any `..` is denied), no `{`, `}`, `[` or `]` (these could spell a parent hop or expand to an absolute path), and no control characters. A pattern may start with `**` (for example `**/*.md`), because it cannot leave the directory named by `path`; the same pattern over the memory root, another user's folder, the data root or any parent is still denied by the path check.
4. **Shared start-up files are readable, exactly.** The agent's start-up text reads a persona, a rules file and a memory index that sit directly in the shared memory root. They hold no per-user data, so chat runs may `Read` (and `Grep` with that exact file as the path) those files and nothing else there. The names come from one list, `APOLLO_SHARED_FILES` (default `persona.md rules.md MEMORY.md`), and a request matches only when its canonical path EQUALS `<canonical root>/<name>`: siblings, backup suffixes, a different case, the directory itself, parent hops, wildcards and a symlink swapped in for one of the files all stay denied. Write and Edit on them, and Glob over them, stay denied. Mailbox access is not part of chat runs and stays denied.
5. **Default deny.** Any tool not on the list (including subagents, skills and notebooks) is denied. Connector tools must match the active user's connector globs (`APOLLO_CONNECTORS_<user>`); mail, calendar, drive, docs and the other user's connectors are denied.
6. **Malformed input fails closed.** In chat runs the hook input must be a JSON object with a non-empty string `tool_name`; empty, truncated, non-object or otherwise malformed input is denied. Without `jq` a chat run is denied.
7. **Orchestrator runs are unchanged.** Without `APOLLO_CHAT_RUN` the lock file decides, as before; `APOLLO_USER` alone is ignored, so a stray variable cannot override the lock. The spawn guard for `subagent_type=apollo` stays, and the other user's folder is now also recognised by its real root path.

## Install

The operator installs the host hook separately from this repository. The installed host copy may carry a local denial-logging diagnostic that is not part of the file shipped here: a reinstall from the repository file drops it, so re-apply it afterwards if it is still wanted.

The hook lives on the host, so any change here takes effect only after the operator reinstalls it.

1. Back up the installed hook. Copy the proposed file over it (keep the installed path; the settings entry does not change).
2. Edit the defaults at the top: `APOLLO_USERS` (the real user ids, space separated, as used in the memory folders) and one `APOLLO_CONNECTORS_<user>` glob list per user (for example the user's own Onyx connector and, for a user who has one, the Oura connector). Placeholders in the file are `user_a`/`user_b`.
   2b. Keep `APOLLO_SHARED_FILES` in step with the files your agent's start-up text reads from the memory root (the app's prompt names the same three by default).
3. If the memory root is not `~/.claude/agent-memory/apollo`, set `APOLLO_ROOT`. The hook needs `jq` and `realpath` (GNU coreutils).
4. Run the suite against the installed file: `APOLLO_HOOK_PATH=/path/to/installed/hook npm test`. All hook tests must pass, including the parallel one.
5. Re-verify the orchestrator flow (lock set, own folder allowed, other folder denied, spawn without lock denied).

## Agent rules text (rules.md)

Add this short paragraph to the single host rules file:

> Free chat (messages that are not a coaching trigger): when a message contains a durable fact (an injury, a preference, a correction to one of your estimates, a goal change), save a short dated note in that user's history folder before replying. Profile changes are still only proposed to the user and need approval. Do not read the chat database or transcripts to produce analysis: the day files remain the source of truth; grep the user's `transcripts/` folder only when the user asks about something said earlier in chat. When a photo is attached, write its extracted numbers (an `Intake:` line for food, recovery numbers and so on, estimates marked with a range) to the day file before replying, because the photo is temporary.

## Test coverage

`test/hook/hook.test.js` feeds PreToolUse JSON for both users, interleaved in parallel, and asserts:

- each user is allowed their own memory, transcripts, run photos and connectors, and each file tool on those paths;
- each user is denied, for every file tool, the other user's data and every path class that could reach it: wildcards in the user segment or above it, parent directories and the roots themselves, relative paths, symlinks planted in the user's own folders, parent hops, sibling-prefix names, missing or wrongly typed arguments, and unsafe Glob patterns (`..`, absolute, `~`, braces, brackets, control characters) and Grep filters, while `**/*`, `**/*.md`, `*.md` and `history/**/*.md` are allowed under the user's own folder only;
- the three shared files are readable by both users in parallel (Read, and Grep on the exact file), while siblings, backup suffixes, case variants, parent hops, wildcards, a symlink swapped in for a shared file, the root directory, the mailbox directory, Write/Edit/Glob on them and every other file in the root are denied; a custom file list is honoured and only plain names count;
- the shared-file list and the connector globs are split without pathname expansion (files in the hook's working directory cannot widen them) and only plain filenames count in the shared list;
- the shell is denied, as is every tool not on the list;
- malformed input (empty, garbage, truncated, wrong types, no tool name) is denied, as are an invalid user, data directory or run id;
- a lock held for another user is denied; the variable alone never overrides the lock; the orchestrator flow is unchanged.

It skips with a clear message when `APOLLO_HOOK_PATH` is unset or `jq`/`realpath` is missing.
