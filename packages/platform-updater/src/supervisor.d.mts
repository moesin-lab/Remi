export function readJson<T = any>(path: string): Promise<T | null>;
export function writeJson(path: string, value: unknown): Promise<void>;
export function syncDirectory(path: string): Promise<void>;
export function schemaFingerprint(root: string): Promise<string>;
export function syncTree(root: string): Promise<void>;
export function baseFingerprints(root: string): Promise<{ apiBase: string; nativeTools: string }>;
export function releaseDirectory(root: string, id: string): string;
export function supervise(): Promise<void>;
