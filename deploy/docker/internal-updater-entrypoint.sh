#!/bin/sh
set -eu
case "${1:-}" in internal|rehearsal) ;; *) echo 'Expected internal or rehearsal role' >&2; exit 64 ;; esac
exec flock --exclusive --nonblock "/remi-control/$1.lock" bun run "/updater/apps/platform-updater/$1.ts"
