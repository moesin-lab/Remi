import { createHash } from 'node:crypto';
import { assertFrozenBusinessPayloadHasNoTransportSecrets } from '@multiremi/contracts/root-delivery.js';

export function frozenPayload(value: Readonly<Record<string, unknown>>): string {
  assertFrozenBusinessPayloadHasNoTransportSecrets(value);
  const projected: Record<string, unknown> = {};
  for (const [field, member] of Object.entries(value)) {
    switch (field) {
      case 'turn_id': case 'attempt_id': case 'task': case 'prompt':
        if (typeof member !== 'string') throw new Error(`Invalid receipt payload field ${field}`);
        break;
      case 'input_revision': case 'input_from_seq': case 'input_to_seq':
        if (!Number.isSafeInteger(member)) throw new Error(`Invalid receipt payload field ${field}`);
        break;
      case 'input_messages': case 'recovered_questions':
        if (!Array.isArray(member)) throw new Error(`Invalid receipt payload field ${field}`);
        break;
      case 'input':
        if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error(`Invalid receipt payload field ${field}`);
        break;
      default: throw new Error(`Unknown receipt payload field ${field}`);
    }
    projected[field] = member;
  }
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([field, member]) => [field, sorted(member)]));
    }
    if (input !== null && typeof input !== 'string' && typeof input !== 'boolean' && !Number.isFinite(input)) throw new Error('Invalid receipt payload');
    return input;
  }
  const snapshot = sorted(projected);
  assertFrozenBusinessPayloadHasNoTransportSecrets(snapshot);
  return JSON.stringify(snapshot);
}

export function rootBusinessPayloadDigest(payload: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256').update(frozenPayload(payload)).digest('hex')}`;
}
