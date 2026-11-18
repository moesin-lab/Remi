import { schemaLevelFingerprint } from '../packages/platform-updater/src/schema-fingerprint.mjs';
console.log(await schemaLevelFingerprint(process.argv[2] ?? '.'));
