import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import type { ExecutionEndpointInput } from "@multiremi/core/runtimes";
import type { EndpointInspectionResponse, EndpointCatalogs } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

export function EndpointModels({ endpointId, revision, dirty, connection, apiKey, onAddModel, onAddManual }: {
  endpointId?: string; revision?: number; dirty?: boolean; connection: ExecutionEndpointInput["connection"]; apiKey: string;
  onAddModel(id: string, name?: string): void;
  onAddManual?(): void;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const [inspection, setInspection] = useState<EndpointInspectionResponse | null>(null);
  const catalogQuery = useQuery({ queryKey: ["execution-endpoint-catalog", wsId, endpointId, revision],
    queryFn: () => api.getExecutionEndpointCatalog(wsId, endpointId!), enabled: !!endpointId });
  const catalogs: EndpointCatalogs["catalogs"] = catalogQuery.data?.catalogs ?? [];
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [testResult, setTestResult] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const identity = JSON.stringify([wsId, endpointId, connection, apiKey]);
  useEffect(() => {
    generation.current++;
    controller.current?.abort(); setBusy(""); setInspection(null); setError(""); setTestResult("");
    return () => { generation.current++; controller.current?.abort(); };
  }, [identity]);
  async function inspect(operation: "models" | "detect" | "test", protocol?: string, model?: string) {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const current = ++generation.current;
    setBusy(operation); setError("");
    try {
      const response = await api.inspectExecutionEndpoint(wsId, {
        endpoint_id: endpointId, connection, ...(apiKey ? { api_key: apiKey } : {}), operation, protocol, model,
      }, abort.signal);
      if (current !== generation.current) return;
      if (operation === "test") {
        const result = response.inspection.results[0]!;
        setTestResult(`${model}: ${result.state === "ok" ? t($ => $.endpoint_setup.test_ok) : result.message ?? result.error_code} · ${result.duration_ms}ms`);
      } else setInspection(response);
      if (response.persisted && endpointId) {
        await catalogQuery.refetch();
      }
    } catch (cause) {
      if (current === generation.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : t($ => $.configuration.load_error));
    } finally { if (current === generation.current) setBusy(""); }
  }
  const rows = new Map<string, { id: string; name?: string; protocol: string; source?: string; context_window?: number; max_output_tokens?: number }>();
  for (const catalog of catalogs.filter(catalog => connection.protocols.includes(catalog.protocol as typeof connection.protocols[number]))) for (const model of catalog.models) rows.set(`${catalog.protocol}:${model.id}`, { ...model, protocol: catalog.protocol });
  if (inspection?.inspection.results.some(result => result.operation === "models")) {
    for (const result of inspection.inspection.results) {
      if (result.state === "ok" || result.state === "manual") {
        for (const [key, value] of rows) if (value.protocol === result.protocol) rows.delete(key);
        for (const model of result.models) rows.set(`${result.protocol}:${model.id}`, { ...model, protocol: result.protocol });
      }
    }
  }
  for (const protocol of connection.protocols) for (const model of connection.options?.manual_models ?? [])
    rows.set(`${protocol}:${model.id}`, { ...model, protocol, source: "manual" });
  const visible = [...rows.values()].filter(model => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="space-y-3 rounded-md border p-3">
    <h3 className="text-sm font-medium">{t($ => $.endpoint_setup.catalog)}</h3>
    <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.inspect_hint)}</p>
    <div className="flex flex-wrap gap-2">
      {onAddManual && <Button type="button" variant="outline" onClick={onAddManual}>{t($ => $.endpoint_setup.add_model)}</Button>}
      <Button type="button" variant="outline" disabled={!!busy || !connection.base_url || !connection.protocols.length}
        onClick={() => void inspect("models")}>{busy === "models" ? t($ => $.endpoint_setup.loading) : t($ => $.endpoint_setup.fetch_models)}</Button>
      <Button type="button" variant="outline" disabled={!!busy || !connection.base_url || !connection.protocols.length}
        onClick={() => void inspect("detect")}>{t($ => $.endpoint_setup.detect)}</Button>
      {busy && <Button type="button" variant="ghost" onClick={() => { generation.current++; controller.current?.abort(); setBusy(""); }}>{t($ => $.configuration.cancel)}</Button>}
    </div>
    {catalogQuery.isError && <p role="alert" className="text-sm text-destructive">{t($ => $.endpoint_setup.cache_failed)}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {inspection?.inspection.results.map(result => <div key={result.protocol} className="rounded border px-2 py-1 text-xs">
      <span className={result.state === "error" ? "text-destructive" : "text-muted-foreground"}>
        {result.protocol} · {result.state === "ok" ? t($ => $.endpoint_setup.list_ok) : result.state === "recognized" ? t($ => $.endpoint_setup.recognized)
          : result.state === "manual" ? t($ => $.endpoint_setup.manual_only) : result.message ?? result.error_code}
        {result.http_status !== null && ` · HTTP ${result.http_status}`} · {result.duration_ms}ms
      </span>
      <div className="break-all text-muted-foreground">{result.url}</div>
    </div>)}
    {!!catalogs.length && <p className="text-xs text-muted-foreground">
      {t($ => $.endpoint_setup.last_success)} {catalogs.map(catalog => catalog.last_success_at ? new Date(catalog.last_success_at).toLocaleString() : "—").join(" · ")}
      {(dirty || catalogs.some(catalog => catalog.error_code || catalog.models_revision !== revision)) && ` · ${t($ => $.endpoint_setup.stale)}`}
    </p>}
    <Input aria-label={t($ => $.endpoint_setup.search)} placeholder={t($ => $.endpoint_setup.search)} value={query} onChange={event => setQuery(event.target.value)} />
    <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.model_count, { count: visible.length })}</p>
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead><tr><th className="p-2">{t($ => $.endpoint_setup.model)}</th><th className="p-2">{t($ => $.endpoint_setup.protocol)}</th>
          <th className="p-2">{t($ => $.endpoint_setup.context)}</th><th className="p-2">{t($ => $.endpoint_setup.actions)}</th></tr></thead>
        <tbody>{visible.slice(0, 200).map(model => <tr key={`${model.protocol}:${model.id}`} className="border-t">
          <td className="max-w-72 break-all p-2"><span className="font-mono">{model.id}</span>{model.name && model.name !== model.id && <div>{model.name}</div>}
            <div className="text-muted-foreground">{model.source === "manual" ? t($ => $.endpoint_setup.manual_source) : t($ => $.endpoint_setup.remote_source)}</div></td>
          <td className="p-2">{model.protocol}</td><td className="p-2">{model.context_window?.toLocaleString() ?? "—"}
            {model.max_output_tokens && <div>{t($ => $.endpoint_setup.output)} {model.max_output_tokens.toLocaleString()}</div>}</td>
          <td className="p-2"><div className="flex flex-wrap gap-1">
            {model.source !== "manual" && <Button type="button" size="xs" variant="ghost" onClick={() => onAddModel(model.id, model.name)}>{t($ => $.endpoint_setup.keep_manual)}</Button>}
            <Button type="button" size="xs" variant="outline" disabled={!!busy} onClick={() => void inspect("test", model.protocol, model.id)}>{t($ => $.endpoint_setup.test)}</Button>
          </div></td></tr>)}</tbody>
      </table>
    </div>
    {visible.length > 200 && <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.search_more)}</p>}
    <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.test_hint)}</p>
    {testResult && <p role="status" className="text-sm">{testResult}</p>}
  </section>;
}
