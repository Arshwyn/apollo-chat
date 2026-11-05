# Host hook changes (applied by the host operator, not by this app)

`docs/host/apollo-isolation-pre.proposed.sh` is the full proposed replacement for the host PreToolUse isolation hook. The app does not install it. It is shipped here so it can be reviewed and tested with this repository's suite (`test/hook/hook.test.js`).

## What changes compared with a lock-file-only hook

1. **Chat runs.** When `APOLLO_CHAT_RUN=1` (set by the gateway), the user is `APOLLO_USER`, set per process. Any of these deny every tool call: a missing or invalid user, a missing or relative `APOLLO_CHAT_DATA`, or a lock file that names a different user (conflict). An empty lock or the same user is fine. The checks apply to every tool call in the process whatever `agent_type` it carries, and the `Agent` tool is refused.
2. **Orchestrator runs are unchanged.** Without `APOLLO_CHAT_RUN` the lock file decides, as before; `APOLLO_USER` alone is ignored, so a stray variable cannot override the lock. The spawn guard for `subagent_type=apollo` stays.
3. **Connectors.** Any `mcp__*` tool must match the active user's connector globs (`APOLLO_CONNECTORS_<user>`); everything else (mail, calendar, drive, docs, the other user's connectors) is denied. This is stricter than a name check for Onyx and Oura and applies to both flows.
4. **Chat data.** For chat runs, any reference to `APOLLO_CHAT_DATA` must be this user's `users/<user>/transcripts/...` or one `users/<user>/tmp/<run>/...`. The chat database, the `work` folder, `users/` itself, the data root and any other user's tree are denied. Parent-path hops (`..`) and any mention of `users/<other>` are denied.
5. **Memory folders.** The other user's folder is denied by the real root path as well as by the `apollo/<user>` convention; wildcards over the user folders and wide reads of the root are denied.
6. **No jq.** A chat run fails closed (deny); the orchestrator flow keeps its old behaviour.

## Install

1. Back up the installed hook. Copy the proposed file over it (keep the installed path; the settings entry does not change).
2. Edit the defaults at the top: `APOLLO_USERS` (the real user ids, space separated, as used in the memory folders) and one `APOLLO_CONNECTORS_<user>` glob list per user (for example the user's own Onyx connector and, for a user who has one, the Oura connector). Placeholders in the file are `user_a`/`user_b`.
3. If the memory root is not `~/.claude/agent-memory/apollo`, set `APOLLO_ROOT`.
4. Run the suite against the installed file: `APOLLO_HOOK_PATH=/path/to/installed/hook npm test`. All hook tests must pass, including the parallel one.
5. Re-verify the orchestrator flow (lock set, own folder allowed, other folder denied, spawn without lock denied).

## Agent rules text (rules.md)

Add this short paragraph to the single host rules file:

> Free chat (messages that are not a coaching trigger): when a message contains a durable fact (an injury, a preference, a correction to one of your estimates, a goal change), save a short dated note in that user's history folder before replying. Profile changes are still only proposed to the user and need approval. Do not read the chat database or transcripts to produce analysis: the day files remain the source of truth; grep the user's `transcripts/` folder only when the user asks about something said earlier in chat. When a photo is attached, write its extracted numbers (an `Intake:` line for food, recovery numbers and so on, estimates marked with a range) to the day file before replying, because the photo is deleted afterwards.

## Test coverage

`test/hook/hook.test.js` feeds PreToolUse JSON for both users, interleaved in parallel, and asserts: each user is allowed their own memory, transcripts, run photos and connectors; denied the other user's of each; fail-closed on invalid users and data directories; lock conflict denied; the variable alone never overrides the lock; the orchestrator flow is unchanged. It skips with a clear message when `APOLLO_HOOK_PATH` is unset or `jq` is missing.
