import type { LCTool } from './preamble';
import {
  buildScopedSentinel,
  PTC_HISTORY_SANDBOX_PATH,
} from './ptc-constants';

export interface BashReplayPreambleConfig {
  executionId: string;
  tools: LCTool[];
}

/** Detect tools whose names normalize to the same bash function
 * identifier. Returns the first colliding pair, or null if none.
 * Used by the router to surface a 400 before the job is enqueued
 * rather than letting the preamble generator throw mid-run. */
export function findBashToolNameCollision(
  tools: readonly LCTool[],
): { firstName: string; secondName: string; normalized: string } | null {
  const seen = new Map<string, string>();
  for (const tool of tools) {
    const normalized = normalizeBashFunctionName(tool.name);
    const prior = seen.get(normalized);
    if (prior !== undefined && prior !== tool.name) {
      return { firstName: prior, secondName: tool.name, normalized };
    }
    seen.set(normalized, tool.name);
  }
  return null;
}

export class BashToolNameCollisionError extends Error {
  constructor(
    public readonly firstName: string,
    public readonly secondName: string,
    public readonly normalized: string,
  ) {
    super(
      `Bash tool names "${firstName}" and "${secondName}" both normalize to the same function identifier "${normalized}"; rename one to avoid collision`,
    );
    this.name = 'BashToolNameCollisionError';
  }
}

const BASH_RESERVED = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select',
  'while', 'until', 'do', 'done', 'in', 'function', 'time', 'coproc',
  'return', 'exit', 'break', 'continue', 'shift', 'export', 'readonly',
  'local', 'declare', 'typeset', 'unset', 'alias', 'unalias', 'source',
  'echo', 'printf', 'read', 'cd', 'pwd', 'kill', 'trap', 'wait', 'eval',
  'exec', 'jobs', 'bg', 'fg', 'set', 'let', 'test', 'true', 'false',
]);

function normalizeBashFunctionName(name: string): string {
  let normalized = name.replace(/[-\s.]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  if (/^[0-9]/.test(normalized)) normalized = '_' + normalized;
  /** Reserve the entire `_ptc_` / `_PTC_` helper namespace so user-supplied
   * tool names can never normalize onto an internal function or variable
   * identifier (e.g. `_ptc_maybe_emit_pending`, `_PTC_HISTORY_PATH`). A
   * colliding stub would otherwise overwrite the internal helper before
   * the end-of-preamble `readonly -f` lockdown runs. Compared case-
   * insensitively because the `_PTC_` prefix is used for variables and
   * `_ptc_` for functions, and both live in the same identifier space. */
  if (
    BASH_RESERVED.has(normalized) ||
    /^_ptc_/i.test(normalized)
  ) {
    normalized = normalized + '_tool';
  }
  if (normalized === '') normalized = 'tool';
  return normalized;
}

/** Escape a string so it is safe to embed inside a bash double-quoted literal. */
function escapeForBashDoubleQuote(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`');
}

/**
 * Replay-mode bash preamble. The script reads the replay history from
 * `/mnt/data/_ptc_history.json`, dispatches each tool call through
 * `_ptc_call_tool`, and uses DEBUG + EXIT traps so that tool calls made
 * inside command substitution (e.g. `result=$(my_tool '{"x":1}')`) still
 * surface the sentinel on the main shell's stdout before the script exits.
 *
 * Caveat: bash is inherently sequential, so only one tool call per round trip.
 * Users capture results via command substitution; input is passed as a single
 * JSON object string argument (validated by jq).
 */
export function generateBashReplayPreamble(config: BashReplayPreambleConfig): string {
  const { executionId, tools } = config;
  const { start: scopedStart, end: scopedEnd } = buildScopedSentinel(executionId);

  let preamble = `#!/bin/bash
# ============================================================================
# PROGRAMMATIC TOOL CALLING INFRASTRUCTURE (bash, replay mode)
# Auto-generated - do not modify
# ============================================================================

_PTC_EXECUTION_ID="${executionId}"
_PTC_SENTINEL_START="${scopedStart}"
_PTC_SENTINEL_END="${scopedEnd}"
_PTC_HISTORY_PATH="\${PTC_HISTORY_PATH:-${PTC_HISTORY_SANDBOX_PATH}}"
_PTC_PENDING_FILE="$(mktemp -t _ptc_pending.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_pending.XXXXXX)"
# Counter must persist across subshells (command substitution) so call_ids
# stay deterministic across cached/uncached calls. Bash variables set in a
# subshell don't propagate back, so we use a file.
_PTC_COUNTER_FILE="$(mktemp -t _ptc_counter.XXXXXX 2>/dev/null || mktemp /tmp/_ptc_counter.XXXXXX)"
printf '0' > "$_PTC_COUNTER_FILE"

_ptc_cleanup_tempfiles() {
    rm -f "$_PTC_PENDING_FILE" "$_PTC_COUNTER_FILE" 2>/dev/null
}

_ptc_maybe_emit_pending() {
    if [ ! -s "$_PTC_PENDING_FILE" ]; then
        return 0
    fi
    local _ptc_first
    _ptc_first=$(head -c 4 "$_PTC_PENDING_FILE" 2>/dev/null)
    if [ "$_ptc_first" = "ERR:" ]; then
        tail -c +5 "$_PTC_PENDING_FILE" >&2
        _ptc_cleanup_tempfiles
        trap - DEBUG EXIT
        exit 1
    fi
    printf '\\n%s\\n' "$_PTC_SENTINEL_START"
    cat "$_PTC_PENDING_FILE"
    printf '\\n%s\\n' "$_PTC_SENTINEL_END"
    _ptc_cleanup_tempfiles
    trap - DEBUG EXIT
    exit 0
}

_ptc_exit_handler() {
    _ptc_maybe_emit_pending
    _ptc_cleanup_tempfiles
}

# DEBUG/EXIT traps are installed INSIDE the user-code subshell (via
# \`builtin trap\`, which bypasses the wrapper below). The parent shell
# intentionally keeps no DEBUG/EXIT traps because user code can always
# override traps in its own subshell — the authoritative sentinel emission
# runs unconditionally in the parent after the subshell returns.

# Wrap the \`trap\` builtin with a function that silently drops attempts to
# modify DEBUG / EXIT / 0 and forwards every other signal spec to the real
# builtin. The wrapper alone is not a complete defence — \`builtin trap\` and
# \`command builtin trap\` bypass it — so the subshell model above is the
# real guard; the wrapper just keeps accidental user \`trap ... EXIT\` calls
# from taking effect in the subshell. We install our own DEBUG/EXIT traps
# via \`builtin trap\` directly inside the subshell so this wrapper never
# intercepts them.
trap() {
    if [ "$#" -eq 0 ]; then
        builtin trap
        return $?
    fi
    case "$1" in
        -l|-p)
            builtin trap "$@"
            return $?
            ;;
    esac
    local _ptc_action="$1"
    shift
    local _ptc_filtered=()
    local _ptc_sig
    for _ptc_sig in "$@"; do
        case "$_ptc_sig" in
            DEBUG|EXIT|0) ;;
            *) _ptc_filtered+=("$_ptc_sig") ;;
        esac
    done
    if [ "\${#_ptc_filtered[@]}" -gt 0 ]; then
        builtin trap "$_ptc_action" "\${_ptc_filtered[@]}"
    fi
    return 0
}

_ptc_call_tool() {
    local _ptc_name="$1"
    local _ptc_default_input='{}'
    local _ptc_input="\${2:-\$_ptc_default_input}"
    local _ptc_cur
    _ptc_cur=$(cat "$_PTC_COUNTER_FILE" 2>/dev/null || printf '0')
    _ptc_cur=$((_ptc_cur + 1))
    printf '%s' "$_ptc_cur" > "$_PTC_COUNTER_FILE"
    local _ptc_call_id
    _ptc_call_id=$(printf "call_%03d" "$_ptc_cur")

    local _ptc_entry
    if [ -r "$_PTC_HISTORY_PATH" ]; then
        _ptc_entry=$(jq -c --arg id "$_ptc_call_id" '.[$id] // empty' "$_PTC_HISTORY_PATH" 2>/dev/null || printf '')
    else
        _ptc_entry=""
    fi
    if [ -n "$_ptc_entry" ] && [ "$_ptc_entry" != "null" ]; then
        local _ptc_is_err
        _ptc_is_err=$(printf '%s' "$_ptc_entry" | jq -r 'if type == "object" then (.is_error // false) else false end' 2>/dev/null)
        if [ "$_ptc_is_err" = "true" ]; then
            local _ptc_msg
            _ptc_msg=$(printf '%s' "$_ptc_entry" | jq -r '.error_message // "tool execution failed"' 2>/dev/null)
            printf 'ERR:%s\\n' "$_ptc_msg" > "$_PTC_PENDING_FILE"
            exit 1
        fi
        local _ptc_result
        _ptc_result=$(printf '%s' "$_ptc_entry" | jq -c 'if type == "object" and has("result") then .result else . end' 2>/dev/null || printf 'null')
        printf '%s' "$_ptc_result"
        return 0
    fi

    if ! printf '%s' "$_ptc_input" | jq -e 'type == "object"' >/dev/null 2>&1; then
        printf 'ERR:tool input for %s must be a JSON object, got: %s\\n' "$_ptc_name" "$_ptc_input" > "$_PTC_PENDING_FILE"
        exit 1
    fi
    if ! jq -c -n \\
        --arg cid "$_ptc_call_id" \\
        --arg nm "$_ptc_name" \\
        --argjson inp "$_ptc_input" \\
        '{pending:[{call_id:$cid,tool_name:$nm,input:$inp}]}' > "$_PTC_PENDING_FILE"; then
        printf 'ERR:failed to serialize pending tool call for %s\\n' "$_ptc_name" > "$_PTC_PENDING_FILE"
        exit 1
    fi
    exit 0
}

# ============================================================================
# TOOL DEFINITIONS
# ============================================================================

`;

  /** Defense-in-depth: the router rejects tool-name collisions up front
   * via `findBashToolNameCollision`, but throw here too so any future
   * caller that bypasses the router still fails loudly rather than
   * silently emitting stubs where one tool's function overwrites
   * another's. */
  const collision = findBashToolNameCollision(tools);
  if (collision) {
    throw new BashToolNameCollisionError(
      collision.firstName,
      collision.secondName,
      collision.normalized,
    );
  }
  for (const tool of tools) {
    preamble += generateBashToolStub(tool) + '\n';
  }

  preamble += `# ============================================================================
# LOCK INTERNAL FUNCTIONS
# ============================================================================
# Prevent user code from redefining or unsetting the PTC infrastructure.
# Done at preamble end so every function referenced below already exists.
# \`|| true\` keeps the preamble robust if a future refactor renames one.
readonly -f trap _ptc_maybe_emit_pending _ptc_exit_handler _ptc_cleanup_tempfiles _ptc_call_tool 2>/dev/null || true

# ============================================================================
# USER CODE EXECUTES INSIDE A SUBSHELL
# ============================================================================
# User code runs in \`(...)\` so any trap modifications it makes (via the
# wrapped \`trap\` function, the raw \`builtin trap\`, or \`command builtin
# trap\`) are scoped to the subshell and torn down on subshell exit. The
# parent shell then calls \`_ptc_maybe_emit_pending\` unconditionally so
# the pending-call sentinel is emitted from the pending file even if the
# subshell's DEBUG/EXIT traps were disabled by user code. Net effect:
# a sufficiently motivated user can still neutralise in-subshell trap
# firing, but they cannot prevent the parent from seeing the pending
# file and producing the sentinel.
(
    # Use \`builtin trap\` so the wrapper (which filters DEBUG/EXIT from user
    # calls) does not filter our own internal install.
    builtin trap _ptc_maybe_emit_pending DEBUG
    builtin trap _ptc_exit_handler EXIT

# ============================================================================
# USER CODE BEGINS BELOW
# ============================================================================

`;

  return preamble;
}

/** Emitted after user code to close the subshell opened by
 * {@link generateBashReplayPreamble} and run the parent-shell fallback
 * sentinel emitter. `buildBashPayload` is responsible for splicing this
 * in so the per-tool stubs never run in the parent but still inherit
 * into the subshell via function inheritance. */
export function generateBashReplayPostamble(): string {
  return `
# ============================================================================
# USER CODE ENDS
# ============================================================================
)
_ptc_user_exit_code=$?

# Parent shell fallback. If the subshell's DEBUG/EXIT traps were
# disabled by user code (\`builtin trap '' DEBUG\`, \`command builtin trap
# '' EXIT\`, or similar), the pending file may still be non-empty
# because \`_ptc_call_tool\` writes before exiting. Emit the sentinel
# from the parent so replay correctness does not depend on trap
# survivability in the subshell.
_ptc_maybe_emit_pending
_ptc_cleanup_tempfiles
exit $_ptc_user_exit_code
`;
}

function generateBashToolStub(tool: LCTool): string {
  const fnName = normalizeBashFunctionName(tool.name);
  const desc = (tool.description ?? '').split('\n').map(l => `# ${l}`).join('\n');
  const nameComment = fnName !== tool.name ? `# Original tool name: ${tool.name}\n` : '';
  const escapedToolName = escapeForBashDoubleQuote(tool.name);
  return `${nameComment}${desc ? desc + '\n' : ''}${fnName}() {
    local _default_input='{}'
    local _input="\${1:-\$_default_input}"
    _ptc_call_tool "${escapedToolName}" "\$_input"
}
`;
}
