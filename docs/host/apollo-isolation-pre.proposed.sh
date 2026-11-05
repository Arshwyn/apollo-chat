#!/usr/bin/env bash
# PROPOSED replacement for the host PreToolUse isolation hook. Applied by the host operator, not by the
# app. See docs/HOOK.md for what changed and how to install it.
#
# Keeps Apollo's users apart. Two ways a run learns which user it serves:
#   1. Chat runs (APOLLO_CHAT_RUN=1, set by the gateway): the user comes from APOLLO_USER, set by the
#      gateway per run. Fails closed on a missing/invalid user, a missing data dir, or a conflict with
#      the lock. Enforced for EVERY tool call in the process, whatever agent_type it carries.
#   2. Orchestrator runs (no APOLLO_CHAT_RUN): the single lock file, exactly as before. APOLLO_USER alone
#      is ignored there, so a stray variable can never override the lock.
#
# Configuration: edit the defaults below (or export the variables). Globs are matched against the tool name.
command -v jq >/dev/null 2>&1 || {
  # Without jq nothing can be inspected. Chat runs fail closed; the orchestrator flow keeps its old behaviour.
  [ "${APOLLO_CHAT_RUN:-}" = 1 ] && printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"apollo-isolation: jq missing"}}'
  exit 0
}
: "${APOLLO_USERS:=user_a user_b}"   # space separated user ids, as used in the memory folders
: "${APOLLO_CONNECTORS_user_a:=mcp__*Onyx*UserA* mcp__*Oura*}"   # connector tool globs each user may use
: "${APOLLO_CONNECTORS_user_b:=mcp__*Onyx*UserB*}"
root=${APOLLO_ROOT:-$HOME/.claude/agent-memory/apollo}
lock=$root/.active-user
in=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$in")
agent=$(jq -r '.agent_type // empty' <<<"$in")
S=$(jq -r '[.tool_input|..|strings]|join(" ")' <<<"$in" 2>/dev/null)
active=""; [ -s "$lock" ] && active=$(tr -d '[:space:]' <"$lock")
deny() { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }
is_user() { local u; for u in $APOLLO_USERS; do [ "$u" = "$1" ] && return 0; done; return 1; }
# Does the tool input name user $1's memory folder (by the real root path or the apollo/<user> convention)?
mentions_user() {
  printf '%s' "$S" | grep -Fq "$root/$1" && return 0
  printf '%s' "$S" | grep -Eq "apollo/$1|$1-profile|$1-project"
}
# Every token in the tool input that starts with directory $1 (up to the next space or quote).
refs_of() {
  awk -v d="$1" '{ s=$0; while ((i=index(s,d))>0) { s=substr(s,i); match(s,/^[^ \t"'"'"']*/); print substr(s,1,RLENGTH); s=substr(s,RLENGTH+1) } }' <<<"$S"
}
others_of() { local u; for u in $APOLLO_USERS; do [ "$u" = "$1" ] || printf '%s\n' "$u"; done; }

chat=0; [ "${APOLLO_CHAT_RUN:-}" = 1 ] && chat=1

# Spawn of an apollo run by the orchestrator: the prompt must not carry another user's paths.
if [ "$tool" = Agent ]; then
  [ "$chat" = 1 ] && deny "apollo-isolation: chat runs may not start subagents."
  [ "$(jq -r '.tool_input.subagent_type // empty' <<<"$in")" = apollo ] || exit 0
  is_user "$active" || deny "apollo-isolation: set the run lock first (bin/apollo-lock.sh set <user>)."
  for o in $(others_of "$active"); do
    mentions_user "$o" && deny "apollo-isolation: the spawn prompt names another user's folder; remove it."
  done
  exit 0
fi

[ "$chat" = 1 ] || [ "$agent" = apollo ] || exit 0

me=""
if [ "$chat" = 1 ]; then
  is_user "${APOLLO_USER:-}" || deny "apollo-isolation: chat run without a valid user."
  me=$APOLLO_USER
  if [ -n "$active" ] && [ "$active" != "$me" ]; then deny "apollo-isolation: run lock held for another user."; fi
  case "${APOLLO_CHAT_DATA:-}" in /?*) ;; *) deny "apollo-isolation: chat run without a data directory.";; esac
  data=${APOLLO_CHAT_DATA%/}
elif is_user "$active"; then
  me=$active
else
  case "$tool" in mcp__*) deny "apollo-isolation: no active user lock; refusing connector access.";; esac
  for o in $APOLLO_USERS; do
    mentions_user "$o" && deny "apollo-isolation: no active user lock; refusing user data access."
  done
  exit 0
fi

# Connectors: only the active user's own (Gmail, Calendar, Drive, Docs and every other connector are denied).
case "$tool" in
  mcp__*)
    var="APOLLO_CONNECTORS_$me"; ok=1
    for g in ${!var}; do
      # shellcheck disable=SC2053
      [[ $tool == $g ]] && ok=0 && break
    done
    [ "$ok" = 0 ] || deny "apollo-isolation: this connector is not available to a $me run."
    ;;
esac

for o in $(others_of "$me"); do
  mentions_user "$o" && deny "apollo-isolation: this run is $me; another user's folder is off limits."
done
printf '%s' "$S" | grep -Eq 'apollo/[*?\[{]' && deny "apollo-isolation: this run is $me; wildcard over the user folders is off limits."
while IFS= read -r ref; do
  [[ $ref == "$root"/[*?\[{]* ]] && deny "apollo-isolation: this run is $me; wildcard over the user folders is off limits."
  case "$tool" in Grep|Glob|Bash)
    [[ $ref == "$root" || $ref == "$root/" ]] && deny "apollo-isolation: name a path inside apollo/$me/ instead of a wider directory.";; esac
done < <(refs_of "$root")
case "$tool" in Grep|Glob|Bash)
  if printf '%s' "$S" | grep -Eq 'agent-memory(/apollo)?/?([[:space:]"'"'"']|$)'; then
    deny "apollo-isolation: name a path inside apollo/$me/ instead of a wider directory."
  fi;; esac

if [ "$chat" = 1 ]; then
  # No parent-directory hops, and no mention of another user's tree in the chat data.
  printf '%s' "$S" | grep -Eq '(^|[[:space:]"'"'"'=:/])\.\.($|[[:space:]"'"'"'/])' && deny "apollo-isolation: parent paths are not allowed."
  for o in $(others_of "$me"); do
    printf '%s' "$S" | grep -Fq "users/$o" && deny "apollo-isolation: another user's chat data is off limits."
  done
  # Every reference to the chat data directory must be this user's transcripts folder or one run's photo dir.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    [[ $ref =~ ^"$data"/users/"$me"/(transcripts|tmp/[^/]+)(/.*)?$ ]] || deny "apollo-isolation: only your transcripts folder and this run's photos may be read from the chat data."
  done < <(refs_of "$data")
fi
exit 0
