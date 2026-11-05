#!/usr/bin/env bash
# PROPOSED replacement for the host PreToolUse isolation hook. Applied by the host operator, not by the
# app. See docs/HOOK.md for what changed and how to install it.
#
# Keeps Apollo's users apart. Two ways a run learns which user it serves:
#   1. Chat runs (APOLLO_CHAT_RUN=1, set by the gateway): the user, data directory and run id come from
#      per-process variables the gateway sets. The run gets a small FIXED tool surface (no shell). File
#      tools are allowed only on canonical paths inside this user's own memory folder, transcripts
#      folder or this run's photo folder. Anything not listed is denied, and malformed input is denied.
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
deny() { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }
is_user() { local u; for u in $APOLLO_USERS; do [ "$u" = "$1" ] && return 0; done; return 1; }
active=""; [ -s "$lock" ] && active=$(tr -d '[:space:]' <"$lock")

# ---------------------------------------------------------------------------------------------
# Chat runs: structural allowlist, default deny.
# ---------------------------------------------------------------------------------------------
chat_run() {
  # Malformed input is never allowed: it must be a JSON object with a non-empty string tool_name.
  jq -e 'type=="object" and (.tool_name|type=="string" and length>0)' <<<"$in" >/dev/null 2>&1 \
    || deny "apollo-isolation: malformed hook input."
  local tool me data runid
  tool=$(jq -er '.tool_name' <<<"$in" 2>/dev/null) || deny "apollo-isolation: malformed hook input."

  is_user "${APOLLO_USER:-}" || deny "apollo-isolation: chat run without a valid user."
  me=$APOLLO_USER
  if [ -n "$active" ] && [ "$active" != "$me" ]; then deny "apollo-isolation: run lock held for another user."; fi
  case "${APOLLO_CHAT_DATA:-}" in /?*) ;; *) deny "apollo-isolation: chat run without a data directory.";; esac
  data=${APOLLO_CHAT_DATA%/}
  runid=${APOLLO_RUN_ID:-}
  [[ $runid =~ ^[A-Za-z0-9_-]{8,64}$ ]] || deny "apollo-isolation: chat run without a valid run id."

  # Canonical roots for this user and this run.
  local mem trs pho
  mem=$(realpath -m -- "$root/$me" 2>/dev/null) || deny "apollo-isolation: cannot resolve the memory folder."
  trs=$(realpath -m -- "$data/users/$me/transcripts" 2>/dev/null) || deny "apollo-isolation: cannot resolve the transcripts folder."
  pho=$(realpath -m -- "$data/users/$me/tmp/$runid" 2>/dev/null) || deny "apollo-isolation: cannot resolve the photo folder."
  [ -n "$mem" ] && [ -n "$trs" ] && [ -n "$pho" ] || deny "apollo-isolation: cannot resolve a folder."

  # A string field of tool_input, or failure when it is missing or not a string.
  field() { jq -er --arg k "$1" '.tool_input[$k] | select(type=="string")' <<<"$in" 2>/dev/null; }
  within() { [[ $1 == "$2" || $1 == "$2"/* ]]; }
  # check_path <value> <read|write>: absolute, no control or glob characters, canonical (symlinks
  # resolved, .. collapsed), and inside an allowed root.
  check_path() {
    local v=$1 mode=$2 c re='[][*?{}]'
    [[ $v == /* ]] || deny "apollo-isolation: paths must be absolute."
    [[ $v =~ [[:cntrl:]] ]] && deny "apollo-isolation: control characters in a path."
    [[ $v =~ $re ]] && deny "apollo-isolation: wildcards are not allowed in a path."
    c=$(realpath -m -- "$v" 2>/dev/null) && [ -n "$c" ] || deny "apollo-isolation: cannot resolve the path."
    if within "$c" "$mem"; then return 0; fi
    if [ "$mode" = read ]; then
      within "$c" "$trs" && return 0
      within "$c" "$pho" && return 0
    fi
    deny "apollo-isolation: that path is outside this run's own folders."
  }
  # A relative glob or filter: no absolute or home-relative start, no leading **, no parent hops.
  check_pattern() {
    local p=$1
    [[ $p == /* || $p == '~'* || $p == '**'* ]] && deny "apollo-isolation: pattern must be relative and not start with a wildcard."
    [[ $p =~ (^|/)\.\.(/|$) ]] && deny "apollo-isolation: parent paths are not allowed."
    [[ $p =~ [[:cntrl:]] ]] && deny "apollo-isolation: control characters in a pattern."
  }

  case "$tool" in
    Read)
      check_path "$(field file_path)" read;;
    Write|Edit)
      check_path "$(field file_path)" write;;
    Grep)
      # path is required: a search with no path would start in the working directory.
      p=$(field path) || deny "apollo-isolation: a path is required."
      check_path "$p" read
      if g=$(field glob); then check_pattern "$g"; fi;;
    Glob)
      p=$(field path) || deny "apollo-isolation: a path is required."
      pat=$(field pattern) || deny "apollo-isolation: a pattern is required."
      check_path "$p" read
      check_pattern "$pat";;
    WebSearch|WebFetch|ToolSearch)
      : ;;
    mcp__*)
      local var="APOLLO_CONNECTORS_$me" ok=1 g
      for g in ${!var}; do
        # shellcheck disable=SC2053
        [[ $tool == $g ]] && ok=0 && break
      done
      [ "$ok" = 0 ] || deny "apollo-isolation: this connector is not available to a $me run.";;
    *)
      deny "apollo-isolation: this tool is not available in chat runs.";;
  esac
  exit 0
}

if [ "${APOLLO_CHAT_RUN:-}" = 1 ]; then chat_run; fi

# ---------------------------------------------------------------------------------------------
# Orchestrator flow (lock file), unchanged apart from path-based matching of the memory root.
# ---------------------------------------------------------------------------------------------
tool=$(jq -r '.tool_name // empty' <<<"$in")
agent=$(jq -r '.agent_type // empty' <<<"$in")
S=$(jq -r '[.tool_input|..|strings]|join(" ")' <<<"$in" 2>/dev/null)
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

# Spawn of an apollo run by the orchestrator: the prompt must not carry another user's paths.
if [ "$tool" = Agent ]; then
  [ "$(jq -r '.tool_input.subagent_type // empty' <<<"$in")" = apollo ] || exit 0
  is_user "$active" || deny "apollo-isolation: set the run lock first (bin/apollo-lock.sh set <user>)."
  for o in $(others_of "$active"); do
    mentions_user "$o" && deny "apollo-isolation: the spawn prompt names another user's folder; remove it."
  done
  exit 0
fi

[ "$agent" = apollo ] || exit 0

if is_user "$active"; then
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
exit 0
