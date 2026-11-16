#!/usr/bin/env bun
/**
 * Remi CLI entry point.
 *
 * Dispatches to subcommands via apps/remi/cli/index.ts.
 * See `remi --help` for available commands.
 */

// Must be first import — swaps macOS system SQLite before any Database instance is created
import "@shared/db/sqlite-custom.js";

import { dispatch } from "./cli/index.js";
import { configureCliStdio, flushCliStdio } from "./cli/core/stdio.js";

configureCliStdio();
try {
  await dispatch(process.argv.slice(2));
} catch (e) {
  process.exitCode = 1;
  const error = e instanceof Error ? e : new Error(String(e));
  if (error.message.startsWith("已移除：")) console.error(error.message);
  else console.error("Fatal:", error.message);
} finally {
  await flushCliStdio();
}
