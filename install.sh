#!/bin/sh
# crank-mem installer: downloads a release into <crank home>/versions/<version>,
# checks it against its .sha256, then runs that version's `crank-mem self-install`.
# Usage: curl -fsSL <release url>/install.sh | sh -s -- [--to vX.Y.Z] [--yes] [--bin-dir <dir>]
# CRANK_RELEASE_URL overrides the release host, CRANK_HOME the crank home.
set -u

BASE="${CRANK_RELEASE_URL:-https://github.com/ChrisLiva/crank-mem/releases}"
BASE="${BASE%/}"
HOME_DIR="${CRANK_HOME:-$HOME/.crank}"
TARBALL=crank-mem.tar.gz
INCOMING=""

die() {
  echo "crank-mem: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$INCOMING" ]; then rm -rf "$INCOMING"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

TAG=""
YES=""
BIN_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || die "--to needs a release tag, such as v1.2.3"
      TAG="$2"
      shift 2
      ;;
    --yes)
      YES=1
      shift
      ;;
    --bin-dir)
      [ $# -ge 2 ] || die "--bin-dir needs a directory"
      BIN_DIR="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: install.sh [--to vX.Y.Z] [--yes] [--bin-dir <dir>]"
      exit 0
      ;;
    *) die "unknown argument $1 (usage: install.sh [--to vX.Y.Z] [--yes] [--bin-dir <dir>])" ;;
  esac
done

# The same runtime test bin/crank-mem runs: bun, else node >= 23.6.
runtime_ok() {
  command -v bun >/dev/null 2>&1 && return 0
  command -v node >/dev/null 2>&1 || return 1
  NODE_V=$(node -v 2>/dev/null) || return 1
  MAJOR=$(echo "$NODE_V" | sed 's/^v\([0-9]*\).*/\1/')
  MINOR=$(echo "$NODE_V" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')
  [ "$MAJOR" -gt 23 ] 2>/dev/null && return 0
  [ "$MAJOR" -eq 23 ] 2>/dev/null && [ "$MINOR" -ge 6 ] 2>/dev/null
}

runtime_ok || die "crank-mem needs bun or node >= 23.6. Install bun with
  curl -fsSL https://bun.sh/install | bash
then run this installer again."
command -v curl >/dev/null 2>&1 || die "the installer needs curl to download the release"

if [ -n "$TAG" ]; then
  URL="$BASE/download/$TAG"
else
  URL="$BASE/latest/download"
fi

# mktemp -d fails when the parent is missing, as it is on a fresh home.
mkdir -p "$HOME_DIR/versions" || die "could not create $HOME_DIR/versions"
INCOMING=$(mktemp -d "$HOME_DIR/versions/.incoming-XXXXXX") || die "could not create a download dir in $HOME_DIR/versions"

curl -fsSL "$URL/$TARBALL" -o "$INCOMING/$TARBALL" || die "could not download $URL/$TARBALL"
curl -fsSL "$URL/$TARBALL.sha256" -o "$INCOMING/$TARBALL.sha256" || die "could not download $URL/$TARBALL.sha256"

EXPECTED=$(awk 'NR == 1 { print $1 }' "$INCOMING/$TARBALL.sha256")
if command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$INCOMING/$TARBALL" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$INCOMING/$TARBALL" | awk '{ print $1 }')
else
  die "the installer needs shasum or sha256sum to check the download"
fi
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $URL/$TARBALL (expected ${EXPECTED:-none}, got $ACTUAL); nothing was installed"

mkdir "$INCOMING/release" || die "could not create $INCOMING/release"
tar -xzf "$INCOMING/$TARBALL" -C "$INCOMING/release" || die "could not extract $TARBALL"

VERSION=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INCOMING/release/package.json" 2>/dev/null | head -n 1)
case "$VERSION" in
  "" | .* | *[!0-9A-Za-z.+-]*) die "the release's package.json names no usable version" ;;
esac

DEST="$HOME_DIR/versions/$VERSION"
if [ -e "$DEST" ]; then
  echo "crank-mem: $VERSION is already in $DEST; keeping it"
else
  mv "$INCOMING/release" "$DEST" || die "could not move the release to $DEST"
fi
rm -rf "$INCOMING"
INCOMING=""

set -- self-install
if [ -n "$YES" ]; then set -- "$@" --yes; fi
if [ -n "$BIN_DIR" ]; then set -- "$@" --bin-dir "$BIN_DIR"; fi
# Under `curl | sh` stdin is the script, so questions read the terminal instead.
if (exec </dev/tty) 2>/dev/null; then
  exec "$DEST/bin/crank-mem" "$@" </dev/tty
fi
exec "$DEST/bin/crank-mem" "$@"
