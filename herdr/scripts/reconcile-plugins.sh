#!/usr/bin/env bash
# Reconcile approved Herdr plugins from data-only manifests.

set -euo pipefail

HERDR_BIN=${HERDR_BIN:-herdr}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST_ROOT=${HERDR_PLUGIN_MANIFEST_ROOT:-"$SCRIPT_DIR/../plugins"}
MODE=reconcile

case "${1:-}" in
  "") ;;
  --refresh) MODE=refresh; shift ;;
  *) printf 'usage: %s [--refresh]\n' "$0" >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { printf 'usage: %s [--refresh]\n' "$0" >&2; exit 2; }

fail() {
  printf 'herdr-plugins: %s\n' "$*" >&2
  exit 1
}

validated=$(mktemp)
trap 'rm -f "$validated"' EXIT

# Validate the complete catalog before checking or mutating Herdr state. Values
# are intentionally constrained so the tab-separated handoff is unambiguous.
if ! python3 - "$MANIFEST_ROOT" >"$validated" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
paths = sorted(root.glob("*/plugin.env"))
if not paths:
    raise SystemExit(f"herdr-plugins: no plugin manifests under {root}")

allowed = {"id", "source", "ref", "enabled", "required_action"}
required = {"id", "source", "enabled"}
seen_ids: set[str] = set()
rows: list[tuple[str, str, str, str, str, str]] = []

for path in paths:
    content = path.read_bytes()
    if any((byte < 32 and byte != 10) or byte == 127 for byte in content):
        raise SystemExit(f"herdr-plugins: {path}: control characters are forbidden")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise SystemExit(f"herdr-plugins: {path}: manifest must be UTF-8")
    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw or raw.startswith("#"):
            continue
        if "=" not in raw:
            raise SystemExit(f"herdr-plugins: {path}:{number}: expected key=value")
        key, value = raw.split("=", 1)
        if key not in allowed:
            raise SystemExit(f"herdr-plugins: {path}:{number}: unknown key {key!r}")
        if key in values:
            raise SystemExit(f"herdr-plugins: {path}:{number}: duplicate key {key!r}")
        if any(ord(char) < 32 or ord(char) == 127 for char in key + value):
            raise SystemExit(f"herdr-plugins: {path}:{number}: control characters are forbidden")
        values[key] = value

    missing = sorted(required - values.keys())
    if missing:
        raise SystemExit(f"herdr-plugins: {path}: missing keys: {', '.join(missing)}")
    plugin_id = values["id"]
    source = values["source"]
    ref = values.get("ref", "")
    enabled = values["enabled"]
    required_action = values.get("required_action", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", plugin_id):
        raise SystemExit(f"herdr-plugins: {path}: invalid plugin id")
    if plugin_id in seen_ids:
        raise SystemExit(f"herdr-plugins: duplicate plugin id {plugin_id!r}")
    seen_ids.add(plugin_id)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source):
        raise SystemExit(f"herdr-plugins: {path}: invalid GitHub plugin source")
    if ref and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", ref):
        raise SystemExit(f"herdr-plugins: {path}: invalid rollback ref")
    if enabled not in {"true", "false"}:
        raise SystemExit(f"herdr-plugins: {path}: enabled must be true or false")
    if required_action and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", required_action):
        raise SystemExit(f"herdr-plugins: {path}: invalid required action")
    rows.append((plugin_id, source, ref, enabled, required_action, str(path)))

for row in rows:
    print("\x1f".join(row))
PY
then
  exit 1
fi

[ -x "$HERDR_BIN" ] || command -v "$HERDR_BIN" >/dev/null 2>&1 \
  || fail "Herdr executable not found: $HERDR_BIN"

plugin_state() {
  local plugin_id=$1 raw
  raw=$("$HERDR_BIN" plugin list --plugin "$plugin_id" --json) \
    || fail "could not inspect plugin $plugin_id"
  python3 -c '
import json
import sys

plugin_id = sys.argv[1]
try:
    payload = json.load(sys.stdin)
    plugins = payload["result"]["plugins"]
except (KeyError, TypeError, ValueError) as error:
    raise SystemExit(f"invalid Herdr plugin-list response: {error}")
if not isinstance(plugins, list) or len(plugins) > 1:
    raise SystemExit("invalid Herdr plugin-list response: expected at most one plugin")
if not plugins:
    print("absent|false|-|-|-" )
    raise SystemExit(0)
plugin = plugins[0]
if plugin.get("plugin_id") != plugin_id:
    raise SystemExit("invalid Herdr plugin-list response: plugin id mismatch")
source = plugin.get("source")
if not isinstance(source, dict) or source.get("kind") != "github":
    raise SystemExit("installed plugin is not GitHub-managed")
owner = source.get("owner")
repo = source.get("repo")
commit = source.get("resolved_commit")
if not isinstance(owner, str) or not owner or not isinstance(repo, str) or not repo:
    raise SystemExit("installed plugin has invalid GitHub source")
if not isinstance(commit, str) or not commit:
    raise SystemExit("installed plugin has invalid resolved commit")
enabled = plugin.get("enabled")
if not isinstance(enabled, bool):
    raise SystemExit("installed plugin has invalid enabled state")
actions = plugin.get("actions")
if not isinstance(actions, list):
    raise SystemExit("installed plugin has invalid actions")
action_ids = []
for item in actions:
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
        raise SystemExit("installed plugin has invalid action entry")
    action_ids.append(item["id"])
print("present|{}|{}/{}|{}|{}".format(
    "true" if enabled else "false",
    owner,
    repo,
    commit,
    ",".join(action_ids) or "-",
))
' "$plugin_id" <<<"$raw" || fail "could not parse plugin state for $plugin_id"
}

install_plugin() {
  local source=$1 ref=$2
  local -a args=(plugin install -y)
  [ -n "$ref" ] && args+=(--ref "$ref")
  args+=("$source")
  "$HERDR_BIN" "${args[@]}"
}

read_plugin_state() {
  local target_id=$1 state
  state=$(plugin_state "$target_id") \
    || fail "state inspection failed for $target_id; refusing mutation"
  IFS='|' read -r presence actual_enabled actual_source resolved_commit action_ids <<<"$state" \
    || fail "invalid state fields for $target_id; refusing mutation"
  case "$presence" in
    absent) ;;
    present)
      [ "$actual_enabled" = true ] || [ "$actual_enabled" = false ] \
        || fail "invalid enabled state for $target_id; refusing mutation"
      [ -n "$actual_source" ] && [ "$actual_source" != - ] \
        || fail "invalid source state for $target_id; refusing mutation"
      [ -n "$resolved_commit" ] && [ "$resolved_commit" != - ] \
        || fail "invalid commit state for $target_id; refusing mutation"
      ;;
    *) fail "invalid presence state for $target_id; refusing mutation" ;;
  esac
}

verify_required_action() {
  local target_id=$1 required=$2
  [ -z "$required" ] && return 0
  case ",$action_ids," in
    *",$required,"*) ;;
    *) fail "$target_id is missing required action $required" ;;
  esac
}

while IFS=$'\x1f' read -r plugin_id source ref desired_enabled required_action manifest_path; do
  read_plugin_state "$plugin_id"

  if [ "$presence" = present ] && [ "$actual_source" != "$source" ]; then
    fail "$plugin_id source mismatch: installed $actual_source, expected $source"
  fi
  if [ "$presence" = present ] && [ "$MODE" != refresh ]; then
    verify_required_action "$plugin_id" "$required_action"
  fi

  mutated=0
  if [ "$presence" = absent ]; then
    printf 'herdr-plugins: installing %s from %s%s\n' \
      "$plugin_id" "$source" "${ref:+ at $ref}"
    install_plugin "$source" "$ref"
    mutated=1
  elif [ "$MODE" = refresh ]; then
    printf 'herdr-plugins: refreshing %s from %s%s\n' \
      "$plugin_id" "$source" "${ref:+ at $ref}"
    "$HERDR_BIN" plugin uninstall "$plugin_id"
    install_plugin "$source" "$ref"
    mutated=1
  fi

  if [ "$mutated" -eq 1 ]; then
    read_plugin_state "$plugin_id"
    [ "$presence" = present ] || fail "$plugin_id is absent after installation"
    [ "$actual_source" = "$source" ] \
      || fail "$plugin_id source mismatch after installation"
    verify_required_action "$plugin_id" "$required_action"
    mutated=0
  fi

  if [ "$desired_enabled" = true ] && [ "$actual_enabled" != true ]; then
    "$HERDR_BIN" plugin enable "$plugin_id"
    mutated=1
  elif [ "$desired_enabled" = false ] && [ "$actual_enabled" != false ]; then
    "$HERDR_BIN" plugin disable "$plugin_id"
    mutated=1
  fi

  if [ "$mutated" -eq 1 ]; then
    read_plugin_state "$plugin_id"
  fi
  [ "$presence" = present ] || fail "$plugin_id is absent after reconciliation"
  [ "$actual_source" = "$source" ] || fail "$plugin_id source mismatch after reconciliation"
  [ "$actual_enabled" = "$desired_enabled" ] \
    || fail "$plugin_id enabled state does not match $manifest_path"
  verify_required_action "$plugin_id" "$required_action"
  printf 'herdr-plugins: %s ready (%s, commit %s)\n' \
    "$plugin_id" "$actual_enabled" "$resolved_commit"
done <"$validated"
