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
# Configuration: edit the defaults below (or export the variables). Globs are matched against the whole tool
# name and should be anchored exact prefixes (mcp__<server-prefix>__*), never substrings (mcp__*Name*).
command -v jq >/dev/null 2>&1 || {
  # Without jq nothing can be inspected. Chat runs fail closed; the orchestrator flow keeps its old behaviour.
  [ "${APOLLO_CHAT_RUN:-}" = 1 ] && printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"apollo-isolation: jq missing"}}'
  exit 0
}
: "${APOLLO_USERS:=user_a user_b}"   # space separated user ids, as used in the memory folders
: "${APOLLO_CONNECTORS_user_a:=mcp__claude_ai_Onyx_-_UserA__* mcp__claude_ai_Oura__*}"   # anchored connector tool globs each user may use
: "${APOLLO_CONNECTORS_user_b:=mcp__claude_ai_Onyx_-_UserB__*}"
# Shared start-up files in the memory root that chat runs may READ (exact files only, no per-user data).
: "${APOLLO_SHARED_FILES:=persona.md rules.md MEMORY.md}"
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
  # shared_ok <value>: true only when the canonical path EQUALS <canonical root>/<name> for one of the
  # shared files. Equality, not prefix: siblings, suffixes, directories and symlink swaps (a symlink
  # resolves elsewhere, so it no longer equals) all fail.
  shared_ok() {
    local v=$1 c rc n re='[][*?{}]' names
    [[ $v == /* ]] || return 1
    [[ $v =~ [[:cntrl:]] ]] && return 1
    [[ $v =~ $re ]] && return 1
    c=$(realpath -m -- "$v" 2>/dev/null) && [ -n "$c" ] || return 1
    rc=$(realpath -m -- "$root" 2>/dev/null) && [ -n "$rc" ] || return 1
    # Split without pathname expansion (read, not an unquoted expansion); only plain filenames count.
    read -r -a names <<<"$APOLLO_SHARED_FILES"
    for n in "${names[@]}"; do
      [[ $n =~ ^[A-Za-z0-9._-]+$ && $n != . && $n != .. ]] || continue
      [ "$c" = "$rc/$n" ] && return 0
    done
    return 1
  }
  # A relative glob or filter, only ever a filter UNDER the already confined path argument: no absolute
  # or home-relative start, no parent hops, no brace or bracket forms (they could spell a parent hop or
  # expand to an absolute path), no control characters. A leading ** is fine: it cannot leave the path.
  check_pattern() {
    local p=$1 re='[][{}]'
    [[ $p == /* || $p == '~'* ]] && deny "apollo-isolation: pattern must be relative."
    [[ $p =~ (^|/)\.\.(/|$) ]] && deny "apollo-isolation: parent paths are not allowed."
    [[ $p =~ $re ]] && deny "apollo-isolation: braces and brackets are not allowed in a pattern."
    [[ $p =~ [[:cntrl:]] ]] && deny "apollo-isolation: control characters in a pattern."
  }

  case "$tool" in
    Read)
      p=$(field file_path)
      shared_ok "$p" || check_path "$p" read;;
    Write|Edit)
      check_path "$(field file_path)" write;;
    Grep)
      # path is required: a search with no path would start in the working directory.
      p=$(field path) || deny "apollo-isolation: a path is required."
      shared_ok "$p" || check_path "$p" read
      if g=$(field glob); then check_pattern "$g"; fi;;
    Glob)
      p=$(field path) || deny "apollo-isolation: a path is required."
      pat=$(field pattern) || deny "apollo-isolation: a pattern is required."
      check_path "$p" read
      check_pattern "$pat";;
    WebSearch|WebFetch|ToolSearch)
      : ;;
    mcp__*)
      local var="APOLLO_CONNECTORS_$me" ok=1 g globs
      read -r -a globs <<<"${!var}"
      for g in "${globs[@]}"; do
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

# An apollo agent with no chat-run marker and no valid lock does not know whose data it serves: every tool
# call is denied, not only connectors and user-folder mentions.
if [ "$agent" = apollo ] && ! is_user "$active"; then
  deny "apollo-isolation: no active user lock; refusing every tool."
fi

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

me=$active

# Connectors: only the active user's own (Gmail, Calendar, Drive, Docs and every other connector are denied).
case "$tool" in
  mcp__*)
    var="APOLLO_CONNECTORS_$me"; ok=1
    read -r -a globs <<<"${!var}"
    for g in "${globs[@]}"; do
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
