import type { PostgresCaseDatabase } from "./postgres-store-template.js";
import { createReusableStoreDatabase } from "./reusable-store-database.js";

/** Placement-only entrypoint: no schema changes, subscriptions or background work. */
export function createRoutingMatrixDatabase(dialect: "sqlite" | "postgres", postgresUrl?: string, postgresDatabase?: PostgresCaseDatabase) {
  return createReusableStoreDatabase(dialect, postgresUrl, {
    fixture: "placement-invariant-matrix", label: "Routing matrix", strictStoreState: true, postgresDatabase,
  });
}
