#!/bin/sh
set -eu
source_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
guest_repo=${1:?expected guest repository staging directory}
runtime=packages/daemon/src/agent-runtime
tests=tests/unit/daemon
mkdir -p "$guest_repo/$runtime/workspace" "$guest_repo/$tests"
cp "$source_root/$runtime"/root-run-*.mjs "$guest_repo/$runtime/"
cp "$source_root/$runtime/workspace/process-birth.mjs" "$guest_repo/$runtime/workspace/"
cp "$source_root/$tests/root-run-supervisor.guest.ts" "$source_root/$tests/root-run-supervisor-peer.mjs" "$guest_repo/$tests/"
