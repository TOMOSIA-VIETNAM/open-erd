#!/usr/bin/env bash
# Install open-erd's skills into an agent that reads skills straight off disk (Codex). Claude Code
# does not need this: it installs through its own marketplace (docs/install.md).
#
# Each skill is a short entry under .agents/skills/ that resolves this clone through
# adapters/root.md and hands over to skills/<cmd>/SKILL.md. Links back into this clone by default,
# so updating the clone updates every installed skill; --copy detaches them.
set -euo pipefail
# Piping this into `head` closes stdout early. Progress messages must not be able to abort an
# install part way through, so every one of them tolerates a dead pipe.
trap '' PIPE
say() { printf "$@" 2>/dev/null || true; }

REPO="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MARKER='<!-- installed by open-erd scripts/install-local.sh — safe to delete -->'
# The shim's own pointer to the adapter; --copy rewrites it, since a copy sits outside the clone.
HOP='`../../../adapters/root.md` (relative to this file)'

SKILLS=()
for dir in "$REPO"/.agents/skills/open-erd-*; do
  [ -d "$dir" ] && SKILLS+=("$(basename -- "$dir")")
done
[ ${#SKILLS[@]} -gt 0 ] || { printf 'install-local.sh: no skills under %s/.agents/skills\n' "$REPO" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/install-local.sh [--platform NAME] [--target DIR] [--copy] [--uninstall]

  --platform NAME  codex (default)  skills in ~/.agents/skills
                   all              every platform above
  --target DIR     install into DIR instead
  --copy           copy instead of linking (if your agent will not follow symlinks)
  --uninstall      remove only what this script installed

Never overwrites a file this script did not create.
EOF
  printf 'Skills installed: %s\n' "${SKILLS[*]}"
}

platform_dir() {
  case "$1" in
    codex|all) printf '%s\n' "$HOME/.agents/skills" ;;
    *) printf 'install-local.sh: unknown platform %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
}

PLATFORM=codex
TARGET=
MODE=link
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) [ $# -ge 2 ] || { usage >&2; exit 2; }; PLATFORM="$2"; shift 2 ;;
    --target) [ $# -ge 2 ] || { usage >&2; exit 2; }; TARGET="$2"; shift 2 ;;
    --copy) MODE=copy; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install-local.sh: unexpected argument %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

DIR="${TARGET:-$(platform_dir "$PLATFORM")}"

# Ours = a symlink into an open-erd clone (this one, or one since deleted), or a copy carrying the marker.
installed_by_us() {
  local path="$1" target
  if [ -L "$path" ]; then
    target="$(readlink -- "$path")"
    case "$target" in "$REPO"/*|*/.agents/skills/"$(basename -- "$path")") return 0 ;; esac
    return 1
  fi
  [ -f "$path/SKILL.md" ] && grep -qF -- "$MARKER" "$path/SKILL.md"
}

if [ "$ACTION" = uninstall ]; then
  removed=0
  for name in "${SKILLS[@]}"; do
    path="$DIR/$name"
    [ -e "$path" ] || [ -L "$path" ] || continue
    if installed_by_us "$path"; then
      say 'removing %s\n' "$path"; rm -rf -- "$path"; removed=$((removed + 1))
    else
      say 'kept     %s — not installed by this script\n' "$path"
    fi
  done
  say '\n%d removed\n' "$removed"
  exit 0
fi

for name in "${SKILLS[@]}"; do
  path="$DIR/$name"
  if { [ -e "$path" ] || [ -L "$path" ]; } && ! installed_by_us "$path"; then
    printf 'install-local.sh: %s exists and was not installed by this script — nothing written\n' "$path" >&2
    exit 1
  fi
done

mkdir -p -- "$DIR"
for name in "${SKILLS[@]}"; do
  path="$DIR/$name"
  rm -rf -- "$path"
  if [ "$MODE" = link ]; then
    ln -s -- "$REPO/.agents/skills/$name" "$path"
    say 'linked  %s\n' "$path"
  else
    mkdir -p -- "$path"
    # Point the copy at this clone by absolute path and state ROOT outright (adapter method 1).
    awk -v hop="$HOP" -v abs="\`$REPO/adapters/root.md\`" -v root="ROOT: $REPO" '
      { i = index($0, hop); if (i) $0 = substr($0, 1, i - 1) abs substr($0, i + length(hop)) }
      /^---$/ { print; if (++fence == 2) print "\n" root; next }
      { print }' "$REPO/.agents/skills/$name/SKILL.md" >"$path/SKILL.md"
    say '\n%s\n' "$MARKER" >>"$path/SKILL.md"
    say 'copied  %s\n' "$path"
  fi
done
say '\nready   %s\n' "$DIR"
say 'Also needed: node >= 20.10 and git on PATH; gh logged in for ci-setup and feedback.\n'
