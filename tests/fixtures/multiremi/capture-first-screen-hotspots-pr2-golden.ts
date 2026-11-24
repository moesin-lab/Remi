import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capturePr2Responses, capturePr2QueryCounts } from "./first-screen-hotspots-pr2-fixture.js";

// Copy this file and its fixture dependencies to main@7bd32800, then run the
// identical command there and on the PR branch. No post-processing is required.
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? join(import.meta.dir, "first-screen-hotspots-pr2-golden.json") : process.argv[outIndex + 1]!;
const reportRoot = mkdtempSync(join(tmpdir(), "mul473-pr2-golden-reports-"));
const previousReportDir = process.env.MULTIREMI_MIGRATION_REPORT_DIR;
process.env.MULTIREMI_MIGRATION_REPORT_DIR = reportRoot;
try {
  const golden = process.argv.includes("--dbq") ? await capturePr2QueryCounts() : await capturePr2Responses();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  if (previousReportDir === undefined) delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
  else process.env.MULTIREMI_MIGRATION_REPORT_DIR = previousReportDir;
  rmSync(reportRoot, { recursive: true, force: true });
}
