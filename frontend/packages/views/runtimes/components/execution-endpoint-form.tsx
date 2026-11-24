"use client";

import { useId, useRef, useState } from "react";
import {
  ChevronRight,
  FileCode2,
  Globe,
  KeyRound,
  Share2,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import {
  importEndpointSnippet,
  type ExecutionEndpoint,
  type ExecutionEndpointInput,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import {
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@multiremi/ui/components/ui/sheet";
import { useT } from "../../i18n";
import { EndpointModels } from "./endpoint-models";
import { ENDPOINT_PROTOCOLS } from "./execution-config-shared";

function normalizeEndpointUrl(url: string, protocol?: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.search = "";
    parsed.hash = "";
    let path = parsed.pathname
      .replace(/\/+$/, "")
      .replace(
        /\/(?:chat\/completions|responses|messages|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)$/,
        "",
      );
    if (protocol === "anthropic-messages") path = path.replace(/\/v1$/, "");
    if (protocol === "google-generative") {
      path = path.replace(/\/v1(?:beta)?$/, "");
    }
    parsed.pathname = path || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function EndpointForm({
  initial,
  pending,
  sharedGroupCount = 0,
  errorMessage,
  inSheet = false,
  onSave,
  onCancel,
}: {
  initial?: ExecutionEndpoint;
  pending: boolean;
  sharedGroupCount?: number;
  errorMessage?: string | null;
  inSheet?: boolean;
  onSave(input: ExecutionEndpointInput): void;
  onCancel(): void;
}) {
  const { t } = useT("runtimes");
  const baseUrlInputId = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [connection, setConnection] = useState<
    ExecutionEndpointInput["connection"]
  >(
    initial?.connection ?? {
      base_url: "",
      protocols: ["openai-responses"],
      auth_mode: "api_key",
      env_key: "",
      auth_header: "bearer",
    },
  );
  const [key, setKey] = useState("");
  const manualInput = useRef<HTMLTextAreaElement>(null);
  const optionalSection = useRef<HTMLDetailsElement>(null);
  const [manual, setManual] = useState(
    (initial?.connection.options?.manual_models ?? [])
      .map((model) =>
        [
          model.id,
          model.name ?? "",
          model.context_window ?? "",
          model.max_output_tokens ?? "",
        ]
          .join(" | ")
          .replace(/(?: \| )+$/, ""),
      )
      .join("\n"),
  );
  const [headers, setHeaders] = useState(
    JSON.stringify(initial?.connection.options?.headers ?? {}, null, 2),
  );
  const [snippet, setSnippet] = useState("");
  const [importError, setImportError] = useState("");
  const [validation, setValidation] = useState("");

  const options = connection.options ?? {};
  const setOptions = (patch: Partial<NonNullable<typeof connection.options>>) =>
    setConnection({ ...connection, options: { ...options, ...patch } });

  function setManualModels(text: string) {
    setManual(text);
    const models = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, displayName, context, output] = line
          .split("|")
          .map((value) => value.trim());
        return {
          id: id!,
          ...(displayName ? { name: displayName } : {}),
          ...(context ? { context_window: Number(context) } : {}),
          ...(output ? { max_output_tokens: Number(output) } : {}),
          source: "manual" as const,
        };
      });
    setOptions({ manual_models: models });
  }

  const HeaderTag = inSheet ? SheetHeader : "div";
  const TitleTag = inSheet ? SheetTitle : "h3";
  const DescriptionTag = inSheet ? SheetDescription : "p";
  const FooterTag = inSheet ? SheetFooter : "div";

  const hasCustomProtocolAddresses =
    (!!connection.protocol_paths &&
      Object.values(connection.protocol_paths).some((v) => v !== undefined)) ||
    (!!connection.protocol_urls &&
      Object.values(connection.protocol_urls).some((v) => !!v));

  const hasInitialOptionalSettings =
    initial?.connection.options?.fetch_models === false ||
    !!initial?.connection.options?.models_url ||
    !!initial?.connection.options?.manual_models?.length ||
    !!(
      initial?.connection.options?.headers &&
      Object.keys(initial.connection.options.headers).length > 0
    );

  const isDirty =
    !!key || JSON.stringify(connection) !== JSON.stringify(initial?.connection);

  return (
    <form
      aria-label={t(($) => $.configuration.endpoints)}
      className={
        inSheet
          ? "flex min-h-0 flex-1 flex-col"
          : "rounded-xl border bg-card"
      }
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          name,
          connection,
          ...(key && connection.auth_mode === "api_key"
            ? { api_key: key }
            : {}),
        });
      }}
    >
      <HeaderTag className="shrink-0 border-b px-5 py-4 pr-12">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <Globe className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TitleTag className="truncate text-sm font-semibold text-foreground">
                {initial
                  ? t(($) => $.configuration.edit_endpoint)
                  : t(($) => $.configuration.add_endpoint)}
              </TitleTag>
              {initial && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  v{initial.revision}
                </span>
              )}
            </div>
            <DescriptionTag className="mt-0.5 text-xs text-muted-foreground">
              {t(($) => $.configuration.new_endpoint_description)}
            </DescriptionTag>
          </div>
        </div>
      </HeaderTag>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <fieldset disabled={pending} className="min-w-0 space-y-5">
          {initial && sharedGroupCount > 1 && (
            <div className="flex items-start gap-2 rounded-lg border border-brand/25 bg-brand/[0.05] px-3 py-2.5 text-xs text-foreground/90">
              <Share2
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand"
                aria-hidden="true"
              />
              <span>
                {t(($) => $.configuration.shared_connection, {
                  count: sharedGroupCount,
                })}
              </span>
            </div>
          )}

          {/* Quick Import from cURL / Environment Variables */}
          <details className="group rounded-xl border bg-muted/10">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-1.5">
                <FileCode2
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t(($) => $.endpoint_setup.import_snippet)}
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-2.5 border-t px-3.5 py-3">
              <textarea
                aria-label={t(($) => $.endpoint_setup.import_snippet)}
                rows={3}
                className="w-full rounded-lg border bg-background p-2.5 font-mono text-xs"
                value={snippet}
                onChange={(event) => setSnippet(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t(($) => $.endpoint_setup.import_hint)}
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="shrink-0 bg-background"
                  disabled={!snippet.trim()}
                  onClick={() => {
                    try {
                      const imported = importEndpointSnippet(snippet);
                      setConnection({
                        ...connection,
                        base_url: imported.base_url,
                        protocols: [imported.protocol],
                        protocol_paths: {},
                        protocol_urls: {},
                        auth_mode: "api_key",
                        env_key: "",
                        auth_header:
                          imported.auth_header ?? connection.auth_header,
                        ...(imported.model
                          ? {
                              options: {
                                ...options,
                                manual_models: [
                                  { id: imported.model, source: "manual" },
                                ],
                              },
                            }
                          : {}),
                      });
                      if (imported.api_key) setKey(imported.api_key);
                      if (imported.model) setManual(imported.model);
                      setSnippet("");
                      setImportError("");
                    } catch {
                      setImportError(t(($) => $.endpoint_setup.import_error));
                    }
                  }}
                >
                  {t(($) => $.endpoint_setup.import_apply)}
                </Button>
              </div>
              {importError && (
                <p role="alert" className="text-xs text-destructive">
                  {importError}
                </p>
              )}
            </div>
          </details>

          <div className="space-y-3.5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                {t(($) => $.configuration.name)}
              </span>
              <Input
                required
                value={name}
                maxLength={128}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor={baseUrlInputId}
                  className="text-xs font-medium text-foreground"
                >
                  {t(($) => $.codex_profile.base_url)}
                </label>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setConnection({
                      ...connection,
                      base_url: normalizeEndpointUrl(
                        connection.base_url,
                        connection.protocols.length === 1
                          ? connection.protocols[0]
                          : undefined,
                      ),
                    })
                  }
                >
                  <Wand2 className="h-3 w-3" aria-hidden="true" />
                  {t(($) => $.endpoint_setup.normalize_url)}
                </Button>
              </div>
              <Input
                id={baseUrlInputId}
                required
                type="url"
                placeholder="https://gateway.example.com"
                className="font-mono text-xs sm:text-sm"
                value={connection.base_url}
                onChange={(event) =>
                  setConnection({
                    ...connection,
                    base_url: event.target.value,
                  })
                }
              />
            </div>
          </div>

          <fieldset className="min-w-0 space-y-2">
            <legend className="text-xs font-medium text-foreground">
              {t(($) => $.configuration.endpoint_protocols)}
            </legend>
            <div className="space-y-2">
              {ENDPOINT_PROTOCOLS.map(({ id: protocol, providerHint }) => {
                const checked = connection.protocols.includes(protocol);
                return (
                  <div
                    key={protocol}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:bg-muted/30 has-[:checked]:border-brand/50 has-[:checked]:bg-brand/[0.04]"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 rounded accent-primary"
                        checked={checked}
                        onChange={(event) => {
                          const paths = connection.protocol_paths
                            ? { ...connection.protocol_paths }
                            : undefined;
                          const urls = connection.protocol_urls
                            ? { ...connection.protocol_urls }
                            : undefined;
                          if (paths && !event.target.checked) {
                            delete paths[protocol];
                          }
                          if (urls && !event.target.checked) {
                            delete urls[protocol];
                          }
                          setConnection({
                            ...connection,
                            ...(paths ? { protocol_paths: paths } : {}),
                            ...(urls ? { protocol_urls: urls } : {}),
                            protocols: event.target.checked
                              ? [...connection.protocols, protocol]
                              : connection.protocols.filter(
                                  (value) => value !== protocol,
                                ),
                          });
                        }}
                      />
                      <span className="min-w-0 break-all font-mono text-xs font-medium text-foreground">
                        {protocol}
                      </span>
                    </label>
                    <span
                      aria-hidden="true"
                      className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {providerHint}
                    </span>
                  </div>
                );
              })}
            </div>
          </fieldset>

          {connection.protocols.length > 0 && (
            <details
              className="group rounded-xl border bg-muted/10"
              open={hasCustomProtocolAddresses}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
                <span>{t(($) => $.endpoint_setup.protocol_addresses)}</span>
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
              </summary>
              <div className="space-y-3 border-t px-3.5 py-3">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(($) => $.endpoint_setup.protocol_addresses_hint)}
                </p>
                <div className="space-y-2.5">
                  {connection.protocols.map((protocol) => (
                    <div
                      key={`addr:${protocol}`}
                      className="grid gap-2.5 rounded-lg border bg-background p-2.5 sm:grid-cols-3"
                    >
                      <label className="block space-y-1 sm:col-span-2">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {protocol} · URL
                        </span>
                        <Input
                          type="url"
                          className="bg-background font-mono text-xs"
                          value={connection.protocol_urls?.[protocol] ?? ""}
                          placeholder={connection.base_url}
                          onBlur={(event) => {
                            if (event.target.value) {
                              setConnection({
                                ...connection,
                                protocol_urls: {
                                  ...connection.protocol_urls,
                                  [protocol]: normalizeEndpointUrl(
                                    event.target.value,
                                    protocol,
                                  ),
                                },
                              });
                            }
                          }}
                          onChange={(event) => {
                            const urls = { ...connection.protocol_urls };
                            if (event.target.value) {
                              urls[protocol] = event.target.value;
                            } else {
                              delete urls[protocol];
                            }
                            setConnection({
                              ...connection,
                              protocol_urls: urls,
                            });
                          }}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {protocol}
                        </span>
                        <Input
                          className="bg-background font-mono text-xs"
                          value={
                            connection.protocol_paths?.[protocol] ??
                            (protocol.startsWith("openai-") &&
                            !/\/v\d+$/.test(connection.base_url)
                              ? "/v1"
                              : "")
                          }
                          onChange={(event) =>
                            setConnection({
                              ...connection,
                              protocol_paths: {
                                ...connection.protocol_paths,
                                [protocol]: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}

          <div className="space-y-3.5 rounded-xl border bg-muted/15 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <label className="block min-w-0 flex-1 space-y-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <KeyRound
                    className="h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {t(($) => $.codex_profile.auth)}
                </span>
                <NativeSelect
                  className="w-full bg-background"
                  value={connection.auth_mode}
                  onChange={(event) => {
                    setKey("");
                    setConnection({
                      ...connection,
                      auth_mode: event.target.value as "api_key" | "env",
                    });
                  }}
                >
                  <NativeSelectOption value="api_key">
                    {t(($) => $.codex_profile.api_key)}
                  </NativeSelectOption>
                  <NativeSelectOption value="env">
                    {t(($) => $.codex_profile.environment)}
                  </NativeSelectOption>
                </NativeSelect>
              </label>
            </div>

            {connection.auth_mode === "api_key" ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.codex_profile.api_key)}
                </span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  className="bg-background"
                  required={!initial?.connection.credential_id}
                  placeholder={
                    initial?.connection.credential_id
                      ? t(($) => $.codex_profile.key_saved)
                      : ""
                  }
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.codex_profile.env_key)}
                </span>
                <Input
                  required
                  placeholder="REMI_ENDPOINT_KEY"
                  className="bg-background font-mono text-xs"
                  value={connection.env_key}
                  onChange={(event) =>
                    setConnection({
                      ...connection,
                      env_key: event.target.value,
                    })
                  }
                />
              </label>
            )}

            {connection.protocols.includes("anthropic-messages") && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.claude_profile.auth_header)}
                </span>
                <NativeSelect
                  className="w-full bg-background"
                  value={connection.auth_header}
                  onChange={(event) =>
                    setConnection({
                      ...connection,
                      auth_header: event.target.value as "bearer" | "x-api-key",
                    })
                  }
                >
                  <NativeSelectOption value="bearer">Bearer</NativeSelectOption>
                  <NativeSelectOption value="x-api-key">
                    x-api-key
                  </NativeSelectOption>
                </NativeSelect>
              </label>
            )}
          </div>

          {/* Optional Endpoint Inventory & Request Settings */}
          <details
            ref={optionalSection}
            className="group rounded-xl border bg-muted/10"
            open={hasInitialOptionalSettings}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal
                  className="h-3.5 w-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t(($) => $.endpoint_setup.optional)}
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-3.5 border-t px-3.5 py-3.5">
              <div className="space-y-1">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 rounded accent-primary"
                    checked={options.fetch_models !== false}
                    onChange={(event) =>
                      setOptions({ fetch_models: event.target.checked })
                    }
                  />
                  <span>{t(($) => $.endpoint_setup.auto_fetch)}</span>
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(($) => $.endpoint_setup.auto_fetch_hint)}
                </p>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.endpoint_setup.models_url)}
                </span>
                <Input
                  type="url"
                  className="bg-background font-mono text-xs"
                  value={options.models_url ?? ""}
                  placeholder="https://example.com/v1/models"
                  onChange={(event) =>
                    setOptions({ models_url: event.target.value })
                  }
                />
              </label>

              <div className="space-y-1">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t(($) => $.endpoint_setup.manual_models)}
                  </span>
                  <textarea
                    ref={manualInput}
                    rows={4}
                    className="w-full rounded-lg border bg-background p-2.5 font-mono text-xs"
                    value={manual}
                    onChange={(event) => setManualModels(event.target.value)}
                  />
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(($) => $.endpoint_setup.manual_hint)}
                </p>
              </div>

              <div className="space-y-1">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t(($) => $.endpoint_setup.headers)}
                  </span>
                  <textarea
                    rows={3}
                    className="w-full rounded-lg border bg-background p-2.5 font-mono text-xs"
                    value={headers}
                    onChange={(event) => {
                      setHeaders(event.target.value);
                      try {
                        const value = JSON.parse(event.target.value || "{}");
                        if (
                          !value ||
                          typeof value !== "object" ||
                          Array.isArray(value) ||
                          Object.values(value).some(
                            (item) => typeof item !== "string",
                          )
                        ) {
                          throw new Error();
                        }
                        setOptions({ headers: value });
                        setValidation("");
                      } catch {
                        setValidation(t(($) => $.endpoint_setup.headers_invalid));
                      }
                    }}
                  />
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t(($) => $.endpoint_setup.headers_hint)}
                </p>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t(($) => $.endpoint_setup.timeout)}
                </span>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  className="max-w-36 bg-background font-mono text-xs"
                  value={(options.timeout_ms ?? 15000) / 1000}
                  onChange={(event) =>
                    setOptions({
                      timeout_ms: Number(event.target.value) * 1000,
                    })
                  }
                />
              </label>
            </div>
          </details>

          {validation && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {validation}
            </p>
          )}

          {!validation && (
            <EndpointModels
              endpointId={initial?.id}
              revision={initial?.revision}
              dirty={isDirty}
              connection={connection}
              apiKey={key}
              onAddManual={() => {
                if (optionalSection.current) {
                  optionalSection.current.open = true;
                }
                manualInput.current?.focus();
                manualInput.current?.scrollIntoView?.({
                  block: "center",
                  behavior: "smooth",
                });
              }}
              onAddModel={(id, display) => {
                if (options.manual_models?.some((model) => model.id === id)) {
                  return;
                }
                setManualModels(
                  [manual, display && display !== id ? `${id} | ${display}` : id]
                    .filter(Boolean)
                    .join("\n"),
                );
              }}
            />
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(($) => $.configuration.endpoint_hint)}
          </p>
        </fieldset>
      </div>

      {errorMessage && (
        <div className="shrink-0 px-5 pb-2">
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {errorMessage}
          </p>
        </div>
      )}

      <FooterTag className="mt-0 shrink-0 flex-row items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onCancel}
        >
          {t(($) => $.configuration.cancel)}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || !connection.protocols.length || !!validation}
        >
          {t(($) => $.configuration.save_endpoint)}
        </Button>
      </FooterTag>
    </form>
  );
}
