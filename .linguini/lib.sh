# Shared by assemble / regen / bump. Sourced, not run.
set -euo pipefail
shopt -s nullglob dotglob
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
L=$ROOT/.linguini
pin_get() { sed -n "s/^$1=//p" "$L/upstream.pin"; }
UPSTREAM_URL=$(pin_get repo)
PIN=$(pin_get commit)
PIN_TAG=$(pin_get tag) # the release tag the pin came from (empty: a branch or commit pin)
# write_pin COMMIT [TAG]: rewrite upstream.pin (tag= only for a release-tag pin).
write_pin() {
  { printf 'repo=%s\n' "$UPSTREAM_URL"; [ -z "${2:-}" ] || printf 'tag=%s\n' "$2"
    printf 'commit=%s\n' "$1"; } >"$L/upstream.pin"
}
# Latest stable release tag upstream (vX.Y.Z only: prereleases carry a -suffix). One ls-remote, no fetch.
latest_release_tag() {
  git ls-remote --tags --refs "$UPSTREAM_URL" 'v*' | sed -n 's#.*refs/tags/##p' |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}
CACHE=${LINGUINI_UPSTREAM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/linguini-upstream.git}
export GIT_AUTHOR_NAME=linguini GIT_AUTHOR_EMAIL=linguini@localhost GIT_COMMITTER_NAME=linguini \
  GIT_COMMITTER_EMAIL=linguini@localhost GIT_AUTHOR_DATE=2000-01-01T00:00:00Z \
  GIT_COMMITTER_DATE=2000-01-01T00:00:00Z
# cache_commit SHA-or-ref: make sure the bare cache has it (shallow); prints the commit SHA.
cache_commit() {
  [ -d "$CACHE" ] || git init -q --bare "$CACHE"
  if ! git -C "$CACHE" cat-file -e "$1^{commit}" 2>/dev/null; then
    git -C "$CACHE" fetch -q --depth 1 "$UPSTREAM_URL" "$1" >&2
    git -C "$CACHE" rev-parse FETCH_HEAD
  else
    git -C "$CACHE" rev-parse "$1^{commit}"
  fi
}
# Our own files: everything in this repo except .linguini/ (tracked + untracked-not-ignored, present).
overlay_files() {
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard -- ':!:.linguini' ':!:.gitignore' |
    while IFS= read -r -d '' f; do [ -e "$ROOT/$f" ] || [ -L "$ROOT/$f" ] && printf '%s\0' "$f"; done
}
patch_name() { printf '%s.patch' "$(printf '%s' "$1" | sed 's#/#__#g')"; }
# A digest of everything assemble reads (pin, patches, deleted list, our files).
inputs_digest() {
  { cat "$L/upstream.pin" "$L/deleted"; for p in "$L"/patches/*.patch; do sha256sum "$p"; done
    overlay_files | (cd "$ROOT" && xargs -0 -r sha256sum); } | sha256sum | cut -d' ' -f1
}
