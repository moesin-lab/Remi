export function extractArchive(archive: string, destination: string, compressed?: boolean, subtree?: string): Promise<void>;
export const DATA_SCHEMA_INPUTS: string[];
export const API_BASE_INPUTS: string[];
export function restoreMigrationReports(archive: string, destination: string): Promise<string>;
export function rehearseStoreMigration(apiRoot: string, archive: string, scratch: string): Promise<void>;
