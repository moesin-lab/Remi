import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import en from "../../locales/en/runtimes.json";
import { EndpointModels } from "./endpoint-models";
const api = vi.hoisted(() => ({ getExecutionEndpointCatalog: vi.fn(), inspectExecutionEndpoint: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
const connection = { base_url: "https://example.invalid", protocols: ["openai-responses" as const], auth_mode: "api_key" as const, env_key: "", auth_header: "bearer" as const };
function result(id: string) { return { persisted: false, inspection: { checked_at: "2026-11-14T00:00:00Z", location: "server", results: [{ protocol: "openai-responses", operation: "models", state: "ok", url: "https://example.invalid/v1/models", http_status: 200, duration_ms: 2, models: [{ id }] }] } }; }
const wrap = ({ children }: { children: React.ReactNode }) => <I18nProvider locale="en" resources={{ en: { runtimes: en } }}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></I18nProvider>;
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [] }); });
it.each([
  { endpointId: "ep", dirty: false, apiKey: "", persists: true },
  { endpointId: "ep", dirty: true, apiKey: "", persists: false },
  { endpointId: "ep", dirty: false, apiKey: "temporary", persists: false },
  { endpointId: undefined, dirty: false, apiKey: "new-key", persists: false },
])("inspects endpoint $endpointId dirty=$dirty key='$apiKey' and reopens the saved catalog", async ({ endpointId, dirty, apiKey, persists }) => {
  let saved = "old-model";
  api.getExecutionEndpointCatalog.mockImplementation(async () => ({ catalogs: [{ protocol: "openai-responses", models_revision: 1, models: [{ id: saved }] }] }));
  api.inspectExecutionEndpoint.mockImplementation(async (_ws, request) => {
    const persisted = !!request.endpoint_id && request.connection == null && !request.api_key;
    if (persisted) saved = "found-model";
    return { ...result("found-model"), persisted };
  });
  const open = (id?: string) => render(<EndpointModels endpointId={id} revision={1} dirty={dirty} connection={connection} apiKey={apiKey} onAddModel={vi.fn()} />, { wrapper: wrap });
  const editor = open(endpointId);
  if (endpointId) await screen.findByText("old-model");
  fireEvent.click(screen.getByRole("button", { name: "Fetch / refresh models" }));
  await screen.findByText("found-model");
  const payload = JSON.parse(JSON.stringify(api.inspectExecutionEndpoint.mock.calls[0]![1]));
  expect(payload).toEqual({ ...(endpointId && { endpoint_id: endpointId }), operation: "models",
    ...(!persists && { connection }), ...(apiKey && { api_key: apiKey }) });
  editor.unmount();
  open("ep");
  await screen.findByText(persists ? "found-model" : "old-model");
  expect(screen.queryByText(persists ? "old-model" : "found-model")).not.toBeInTheDocument();
});
it("ignores a request that finishes after the draft changes", async () => {
  let resolve!: (value: unknown) => void;
  api.inspectExecutionEndpoint.mockReturnValue(new Promise(done => { resolve = done; }));
  const props = { connection, apiKey: "key", onAddModel: vi.fn() };
  const view = render(<EndpointModels {...props} />, { wrapper: wrap });
  fireEvent.click(screen.getByRole("button", { name: "Fetch / refresh models" }));
  await waitFor(() => expect(api.inspectExecutionEndpoint).toHaveBeenCalled());
  view.rerender(<EndpointModels {...props} connection={{ ...connection, base_url: "https://new.invalid" }} />);
  await act(async () => { resolve(result("old-response")); });
  expect(screen.queryByText("old-response")).not.toBeInTheDocument();
  expect(api.inspectExecutionEndpoint.mock.calls[0]?.[2].aborted).toBe(true);
});
it("preserves cached rows on failed refresh and never invokes a model automatically", async () => {
  api.getExecutionEndpointCatalog.mockResolvedValue({ catalogs: [{ protocol: "openai-responses", models_revision: 1, models: [{ id: "cached-model" }], last_success_at: "2026-11-14T00:00:00Z", error_code: null }] });
  const response = result("unused");
  Object.assign(response.inspection.results[0]!, { state: "error", models: [], message: "Refresh failed" });
  api.inspectExecutionEndpoint.mockResolvedValue(response);
  render(<EndpointModels endpointId="ep" revision={1} dirty connection={connection} apiKey="" onAddModel={vi.fn()} />, { wrapper: wrap });
  await screen.findByText("cached-model");
  expect(api.inspectExecutionEndpoint).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Fetch / refresh models" }));
  await screen.findByText(/Refresh failed/);
  expect(screen.getByText("cached-model")).toBeInTheDocument();
  expect(screen.getByText(/Previous catalog for reference/)).toBeInTheDocument();
  expect(api.inspectExecutionEndpoint).toHaveBeenCalledWith("ws", expect.objectContaining({ operation: "models" }), expect.any(AbortSignal));
});
