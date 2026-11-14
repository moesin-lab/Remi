"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import type {
  EndpointCatalogs,
  EndpointInspectionResponse,
  ExecutionEndpointInput,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

export function EndpointModels({
  endpointId,
  revision,
  dirty,
  connection,
  apiKey,
  onAddModel,
  onAddManual,
}: {
  endpointId?: string;
  revision?: number;
  dirty?: boolean;
  connection: ExecutionEndpointInput["connection"];
  apiKey: string;
  onAddModel(id: string, name?: string): void;
  onAddManual?(): void;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const [inspection, setInspection] =
    useState<EndpointInspectionResponse | null>(null);
  const catalogQuery = useQuery({
    queryKey: ["execution-endpoint-catalog", wsId, endpointId, revision],
    queryFn: () => api.getExecutionEndpointCatalog(wsId, endpointId!),
    enabled: !!endpointId,
  });
  const catalogs: EndpointCatalogs["catalogs"] =
    catalogQuery.data?.catalogs ?? [];
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [testResult, setTestResult] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const identity = JSON.stringify([wsId, endpointId, connection, apiKey]);

  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setBusy("");
    setInspection(null);
    setError("");
    setTestResult(null);
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [identity]);

  async function inspect(
    operation: "models" | "detect" | "test",
    protocol?: string,
    model?: string,
  ) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    setBusy(operation);
    setError("");
    try {
      const response = await api.inspectExecutionEndpoint(
        wsId,
        {
          endpoint_id: endpointId,
          connection,
          ...(apiKey ? { api_key: apiKey } : {}),
          operation,
          protocol,
          model,
        },
        abort.signal,
      );
      if (current !== generation.current) return;
      if (operation === "test") {
        const result = response.inspection.results[0]!;
        const ok = result.state === "ok";
        setTestResult({
          ok,
          text: `${model}: ${ok ? t(($) => $.endpoint_setup.test_ok) : (result.message ?? result.error_code)} · ${result.duration_ms}ms`,
        });
      } else {
        setInspection(response);
      }
      if (response.persisted && endpointId) {
        await catalogQuery.refetch();
      }
    } catch (cause) {
      if (current === generation.current && !abort.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : t(($) => $.configuration.load_error),
        );
      }
    } finally {
      if (current === generation.current) setBusy("");
    }
  }

  const rows = new Map<
    string,
    {
      id: string;
      name?: string;
      protocol: string;
      source?: string;
      context_window?: number;
      max_output_tokens?: number;
    }
  >();

  for (const catalog of catalogs.filter((c) =>
    connection.protocols.includes(
      c.protocol as (typeof connection.protocols)[number],
    ),
  )) {
    for (const model of catalog.models) {
      rows.set(`${catalog.protocol}:${model.id}`, {
        ...model,
        protocol: catalog.protocol,
      });
    }
  }

  if (
    inspection?.inspection.results.some((result) => result.operation === "models")
  ) {
    for (const result of inspection.inspection.results) {
      if (result.state === "ok" || result.state === "manual") {
        for (const [key, value] of rows) {
          if (value.protocol === result.protocol) rows.delete(key);
        }
        for (const model of result.models) {
          rows.set(`${result.protocol}:${model.id}`, {
            ...model,
            protocol: result.protocol,
          });
        }
      }
    }
  }

  for (const protocol of connection.protocols) {
    for (const model of connection.options?.manual_models ?? []) {
      rows.set(`${protocol}:${model.id}`, {
        ...model,
        protocol,
        source: "manual",
      });
    }
  }

  const visible = [...rows.values()].filter((model) =>
    `${model.id} ${model.name ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  const canInspect =
    !busy && !!connection.base_url.trim() && connection.protocols.length > 0;

  return (
    <section className="space-y-3 rounded-xl border bg-muted/10 p-3.5">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Sparkles
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="text-xs font-semibold text-foreground">
            {t(($) => $.endpoint_setup.catalog)}
          </h3>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(($) => $.endpoint_setup.inspect_hint)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="gap-1.5 bg-background"
          disabled={!canInspect}
          onClick={() => void inspect("models")}
        >
          {busy === "models" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          )}
          {busy === "models"
            ? t(($) => $.endpoint_setup.loading)
            : t(($) => $.endpoint_setup.fetch_models)}
        </Button>

        <Button
          type="button"
          size="xs"
          variant="outline"
          className="gap-1.5 bg-background"
          disabled={!canInspect}
          onClick={() => void inspect("detect")}
        >
          {busy === "detect" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Route className="h-3 w-3" aria-hidden="true" />
          )}
          {t(($) => $.endpoint_setup.detect)}
        </Button>

        {onAddManual && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="gap-1 bg-background"
            onClick={onAddManual}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t(($) => $.endpoint_setup.add_model)}
          </Button>
        )}

        {busy && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              generation.current++;
              controller.current?.abort();
              setBusy("");
            }}
          >
            {t(($) => $.configuration.cancel)}
          </Button>
        )}
      </div>

      {catalogQuery.isError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          {t(($) => $.endpoint_setup.cache_failed)}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      {inspection && inspection.inspection.results.length > 0 && (
        <div className="space-y-1.5">
          {inspection.inspection.results.map((result) => {
            const isErr = result.state === "error";
            const isOk = result.state === "ok";
            return (
              <div
                key={result.protocol}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-xs",
                  isErr
                    ? "border-destructive/30 bg-destructive/[0.05]"
                    : isOk
                      ? "border-success/30 bg-success/[0.04]"
                      : "bg-background",
                )}
              >
                <div className="flex items-start gap-1.5">
                  {isErr ? (
                    <AlertCircle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2
                      className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0",
                        isOk ? "text-success" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <span
                      className={cn(
                        "font-medium",
                        isErr ? "text-destructive" : "text-foreground/90",
                      )}
                    >
                      {result.protocol} ·{" "}
                      {result.state === "ok"
                        ? t(($) => $.endpoint_setup.list_ok)
                        : result.state === "recognized"
                          ? t(($) => $.endpoint_setup.recognized)
                          : result.state === "manual"
                            ? t(($) => $.endpoint_setup.manual_only)
                            : (result.message ?? result.error_code)}
                      {result.http_status !== null &&
                        ` · HTTP ${result.http_status}`}{" "}
                      · {result.duration_ms}ms
                    </span>
                    <div className="break-all font-mono text-[11px] text-muted-foreground">
                      {result.url}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {catalogs.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(($) => $.endpoint_setup.last_success)}{" "}
          {catalogs
            .map((catalog) =>
              catalog.last_success_at
                ? new Date(catalog.last_success_at).toLocaleString()
                : "—",
            )
            .join(" · ")}
          {(dirty ||
            catalogs.some(
              (catalog) =>
                catalog.error_code || catalog.models_revision !== revision,
            )) &&
            ` · ${t(($) => $.endpoint_setup.stale)}`}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={t(($) => $.endpoint_setup.search)}
            placeholder={t(($) => $.endpoint_setup.search)}
            className="h-8 bg-background pl-8 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {t(($) => $.endpoint_setup.model_count, { count: visible.length })}
        </p>
      </div>

      {visible.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-lg border bg-background">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 border-b bg-muted/50 text-[11px] font-medium text-muted-foreground backdrop-blur-xs">
              <tr>
                <th className="px-2.5 py-2">{t(($) => $.endpoint_setup.model)}</th>
                <th className="px-2.5 py-2">
                  {t(($) => $.endpoint_setup.protocol)}
                </th>
                <th className="px-2.5 py-2">
                  {t(($) => $.endpoint_setup.context)}
                </th>
                <th className="px-2.5 py-2 text-right">
                  {t(($) => $.endpoint_setup.actions)}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.slice(0, 200).map((model) => (
                <tr
                  key={`${model.protocol}:${model.id}`}
                  className="transition-colors hover:bg-muted/25"
                >
                  <td className="max-w-60 break-all px-2.5 py-2 align-top">
                    <span className="font-mono font-medium text-foreground">
                      {model.id}
                    </span>
                    {model.name && model.name !== model.id && (
                      <div className="mt-0.5 text-[11px] text-foreground/80">
                        {model.name}
                      </div>
                    )}
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {model.source === "manual"
                        ? t(($) => $.endpoint_setup.manual_source)
                        : t(($) => $.endpoint_setup.remote_source)}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 align-top font-mono text-[11px] text-muted-foreground">
                    {model.protocol}
                  </td>
                  <td className="px-2.5 py-2 align-top font-mono text-[11px] tabular-nums text-muted-foreground">
                    {model.context_window?.toLocaleString() ?? "—"}
                    {model.max_output_tokens && (
                      <div className="text-[10px]">
                        {t(($) => $.endpoint_setup.output)}{" "}
                        {model.max_output_tokens.toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="px-2.5 py-2 text-right align-top">
                    <div className="flex flex-wrap justify-end gap-1">
                      {model.source !== "manual" && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => onAddModel(model.id, model.name)}
                        >
                          {t(($) => $.endpoint_setup.keep_manual)}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="gap-1"
                        disabled={!!busy}
                        onClick={() =>
                          void inspect("test", model.protocol, model.id)
                        }
                      >
                        <Play className="h-2.5 w-2.5" aria-hidden="true" />
                        {t(($) => $.endpoint_setup.test)}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {visible.length > 200 && (
        <p className="text-[11px] text-muted-foreground">
          {t(($) => $.endpoint_setup.search_more)}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(($) => $.endpoint_setup.test_hint)}
      </p>

      {testResult && (
        <p
          role="status"
          className={cn(
            "rounded-lg border px-2.5 py-2 font-mono text-xs",
            testResult.ok
              ? "border-success/30 bg-success/[0.05] text-foreground"
              : "border-destructive/30 bg-destructive/[0.05] text-destructive",
          )}
        >
          {testResult.text}
        </p>
      )}
    </section>
  );
}
