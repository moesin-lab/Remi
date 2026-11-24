import { readFileSync } from 'node:fs';

// Read at build time so Bun can embed the source without assigning its text
// loader to the same module that safety.ts imports as executable JavaScript.
export function schemaFingerprintSource(): string {
  return readFileSync(new URL('./schema-fingerprint.mjs', import.meta.url), 'utf8');
}
