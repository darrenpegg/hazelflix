#!/bin/sh
# HazelFlix: starts reel on Node.js, from wherever this folder is.
#
#   ./start.sh [--web HOST:PORT] [--library FOLDER]... [--db PATH] [--quiet]
#
# Its data (the database, keys, photos, posters, IMDb's and GeoNames' databases) is kept outside this folder, so a new
# version can replace the folder: in HAZELFLIX_DATA if that's set, else ~/Library/Application Support/HazelFlix on a
# Mac, else $XDG_DATA_HOME/hazelflix (~/.local/share/hazelflix). --db PATH puts it elsewhere.
#
# Needs Node.js 22.5 or later, and ffmpeg and ffprobe.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

if [ -n "${HAZELFLIX_DATA:-}" ]; then
    data=$HAZELFLIX_DATA
elif [ "$(uname)" = Darwin ]; then
    data="$HOME/Library/Application Support/HazelFlix"
else
    data="${XDG_DATA_HOME:-$HOME/.local/share}/hazelflix"
fi

need() {
    command -v "$1" >/dev/null 2>&1 || { echo "HazelFlix needs $1: $2" >&2; exit 1; }
}
need node "https://nodejs.org (22.5 or later)"
need ffmpeg "https://ffmpeg.org (brew install ffmpeg, apt install ffmpeg)"
need ffprobe "it comes with ffmpeg"

node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)' ||
    { echo "HazelFlix needs Node.js 22.5 or later (this is $(node --version))" >&2; exit 1; }

mkdir -p "$data"
cd "$here"
exec node --no-warnings reel.js --db "$data/reel.db" --assets "$here/assets" --client "$here/client" --docs "$here/help" "$@"
