import { afterEach, beforeEach } from "bun:test";

/** Legacy Relay writes now use the encrypted endpoint store. Keep a fixture-owned key. */
export function useEndpointEncryptionKey(): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    if (!previous) process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 63).toString("base64");
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = previous;
  });
}
