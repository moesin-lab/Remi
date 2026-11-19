export interface DeploymentSchema { historical: boolean; expandLevel: number; contractLevel: number }
export const SCHEMA_INVENTORY_SQL: string;
export const SCHEMA_METADATA_SQL: string;
export const PREPARE_REQUIRED: string;
export function readDeploymentSchema(query: (sql: string) => string | Promise<string>): Promise<DeploymentSchema>;
export function assertDeploymentSchema(target: unknown, current: DeploymentSchema): void;
