import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import legacyInputs from './data-schema-inputs.json' with { type: 'json' };

/** New releases fingerprint declared schema levels, independent of source text.
 * Legacy archives retain their original verification algorithm. Missing files
 * in a modern archive cannot match its expected level fingerprint. */
export async function schemaLevelFingerprint(root) {
  let contract;
  try { contract = JSON.parse(await readFile(join(root, 'packages/server/src/store/schema-compatibility.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let value;
  if (contract !== undefined) {
    value = canonicalSchemaLevel(contract);
  } else {
    value = (await Promise.all(legacyInputs.map(path => readFile(join(root, path), 'utf8')))).join('').replaceAll('\r\n', '\n');
  }
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSchemaLevel(contract) {
  const { format, expandLevel, contractLevel, minLevel, maxLevel } = contract ?? {};
  if (format !== 1 || ![expandLevel, contractLevel, minLevel, maxLevel].every(n => Number.isSafeInteger(n) && n >= 0)
      || contractLevel > expandLevel || minLevel > maxLevel || minLevel > expandLevel || contractLevel > maxLevel) {
    throw new Error('Invalid schema compatibility declaration');
  }
  return JSON.stringify({ format, expandLevel, contractLevel });
}
