"use client";
import { useRef, useState } from "react";
import { importEndpointSnippet } from "@multiremi/core/runtimes";
import type { ExecutionEndpoint, ExecutionEndpointInput } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";
import { EndpointModels } from "./endpoint-models";

export function EndpointForm({ initial, pending, onSave, onCancel }: {
  initial?: ExecutionEndpoint; pending: boolean;
  onSave(input: ExecutionEndpointInput): void; onCancel(): void;
}) {
  const { t } = useT("runtimes");
  const [name, setName] = useState(initial?.name ?? "");
  const [connection, setConnection] = useState<ExecutionEndpointInput["connection"]>(initial?.connection ?? {
    base_url: "", protocols: ["openai-responses"], auth_mode: "api_key", env_key: "", auth_header: "bearer",
  });
  const [key, setKey] = useState("");
  const manualInput = useRef<HTMLTextAreaElement>(null);
  const optionalSection = useRef<HTMLDetailsElement>(null);
  const [manual, setManual] = useState((initial?.connection.options?.manual_models ?? []).map(model =>
    [model.id, model.name ?? "", model.context_window ?? "", model.max_output_tokens ?? ""].join(" | ").replace(/(?: \| )+$/, "")).join("\n"));
  const [headers, setHeaders] = useState(JSON.stringify(initial?.connection.options?.headers ?? {}, null, 2));
  const [snippet, setSnippet] = useState("");
  const [importError, setImportError] = useState("");
  const [validation, setValidation] = useState("");
  const options = connection.options ?? {};
  const setOptions = (patch: Partial<NonNullable<typeof connection.options>>) => setConnection({ ...connection, options: { ...options, ...patch } });
  function setManualModels(text: string) {
    setManual(text);
    const models = text.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
      const [id, name, context, output] = line.split("|").map(value => value.trim());
      return { id: id!, ...(name ? { name } : {}), ...(context ? { context_window: Number(context) } : {}),
        ...(output ? { max_output_tokens: Number(output) } : {}), source: "manual" as const };
    });
    setOptions({ manual_models: models });
  }
  function normalize(url: string, protocol?: string) {
    try {
      const parsed = new URL(url.trim());
      parsed.search = ""; parsed.hash = "";
      let path = parsed.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)$/, "");
      if (protocol === "anthropic-messages") path = path.replace(/\/v1$/, "");
      if (protocol === "google-generative") path = path.replace(/\/v1(?:beta)?$/, "");
      parsed.pathname = path || "/";
      return parsed.toString().replace(/\/$/, "");
    } catch { return url; }
  }
  return <form className="space-y-4 rounded-lg border p-4" aria-label={t($ => $.configuration.endpoints)}
    onSubmit={event => { event.preventDefault(); onSave({ name, connection, ...(key && connection.auth_mode === "api_key" ? { api_key: key } : {}) }); }}>
    <fieldset disabled={pending} className="space-y-3">
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm">{t($ => $.endpoint_setup.import_snippet)}</summary>
        <textarea aria-label={t($ => $.endpoint_setup.import_snippet)} rows={3} className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          value={snippet} onChange={event => setSnippet(event.target.value)} autoComplete="off" spellCheck={false} />
        <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.import_hint)}</p>
        <Button type="button" variant="outline" disabled={!snippet.trim()} onClick={() => {
          try {
            const imported = importEndpointSnippet(snippet);
            setConnection({ ...connection, base_url: imported.base_url, protocols: [imported.protocol], protocol_paths: {}, protocol_urls: {},
              auth_mode: "api_key", env_key: "", auth_header: imported.auth_header ?? connection.auth_header, ...(imported.model ? { options: { ...options, manual_models: [{ id: imported.model, source: "manual" }] } } : {}) });
            if (imported.api_key) setKey(imported.api_key);
            if (imported.model) setManual(imported.model);
            setSnippet(""); setImportError("");
          } catch { setImportError(t($ => $.endpoint_setup.import_error)); }
        }}>{t($ => $.endpoint_setup.import_apply)}</Button>
        {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
      </details>
      <label className="block text-sm">{t($ => $.configuration.name)}
        <Input required value={name} maxLength={128} onChange={event => setName(event.target.value)} />
      </label>
      <label className="block text-sm">{t($ => $.codex_profile.base_url)}
        <Input required type="url" value={connection.base_url} onChange={event => setConnection({ ...connection, base_url: event.target.value })} />
      </label>
      <Button type="button" size="xs" variant="ghost" onClick={() => setConnection({ ...connection,
        base_url: normalize(connection.base_url, connection.protocols.length === 1 ? connection.protocols[0] : undefined) })}>
        {t($ => $.endpoint_setup.normalize_url)}
      </Button>
      <fieldset className="space-y-2">
        <legend className="text-sm">{t($ => $.configuration.endpoint_protocols)}</legend>
        {(["openai-responses", "openai-chat-completions", "anthropic-messages", "google-generative"] as const).map(protocol =>
          <label key={protocol} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={connection.protocols.includes(protocol)} onChange={event => {
              const paths = connection.protocol_paths ? { ...connection.protocol_paths } : undefined;
              const urls = connection.protocol_urls ? { ...connection.protocol_urls } : undefined;
              if (paths && !event.target.checked) delete paths[protocol];
              if (urls && !event.target.checked) delete urls[protocol];
              setConnection({ ...connection, ...(paths ? { protocol_paths: paths } : {}), ...(urls ? { protocol_urls: urls } : {}),
                protocols: event.target.checked ? [...connection.protocols, protocol] : connection.protocols.filter(value => value !== protocol) });
            }} />{protocol}
          </label>)}
      </fieldset>
      <details className="space-y-2">
        <summary className="text-sm">{t($ => $.endpoint_setup.protocol_addresses)}</summary>
        <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.protocol_addresses_hint)}</p>
        {connection.protocols.map(protocol => <label key={`url:${protocol}`} className="block text-xs">{protocol} · URL
          <Input type="url" value={connection.protocol_urls?.[protocol] ?? ""}
            placeholder={connection.base_url}
            onBlur={event => {
              if (event.target.value) setConnection({ ...connection, protocol_urls: { ...connection.protocol_urls,
                [protocol]: normalize(event.target.value, protocol) } });
            }}
            onChange={event => {
              const urls = { ...connection.protocol_urls };
              if (event.target.value) urls[protocol] = event.target.value; else delete urls[protocol];
              setConnection({ ...connection, protocol_urls: urls });
            }} />
        </label>)}
        {connection.protocols.map(protocol => <label key={protocol} className="block text-xs">{protocol}
          <Input value={connection.protocol_paths?.[protocol] ?? (protocol.startsWith("openai-") && !/\/v\d+$/.test(connection.base_url) ? "/v1" : "")}
            onChange={event => setConnection({ ...connection, protocol_paths: {
              ...connection.protocol_paths, [protocol]: event.target.value,
            } })} />
        </label>)}
      </details>
      <label className="block text-sm">{t($ => $.codex_profile.auth)}
        <NativeSelect value={connection.auth_mode} onChange={event => {
          setKey(""); setConnection({ ...connection, auth_mode: event.target.value as "api_key" | "env" });
        }}>
          <NativeSelectOption value="api_key">{t($ => $.codex_profile.api_key)}</NativeSelectOption>
          <NativeSelectOption value="env">{t($ => $.codex_profile.environment)}</NativeSelectOption>
        </NativeSelect>
      </label>
      {connection.auth_mode === "api_key"
        ? <label className="block text-sm">{t($ => $.codex_profile.api_key)}
          <Input type="password" autoComplete="new-password" required={!initial?.connection.credential_id}
            placeholder={initial?.connection.credential_id ? t($ => $.codex_profile.key_saved) : ""}
            value={key} onChange={event => setKey(event.target.value)} />
        </label>
        : <label className="block text-sm">{t($ => $.codex_profile.env_key)}
          <Input required placeholder="REMI_ENDPOINT_KEY" value={connection.env_key}
            onChange={event => setConnection({ ...connection, env_key: event.target.value })} />
        </label>}
      {connection.protocols.includes("anthropic-messages") && <label className="block text-sm">
        {t($ => $.claude_profile.auth_header)}
        <NativeSelect value={connection.auth_header} onChange={event => setConnection({ ...connection, auth_header: event.target.value as "bearer" | "x-api-key" })}>
          <NativeSelectOption value="bearer">Bearer</NativeSelectOption>
          <NativeSelectOption value="x-api-key">x-api-key</NativeSelectOption>
        </NativeSelect>
      </label>}
      <details ref={optionalSection} className="space-y-3" open={initial?.connection.options?.fetch_models === false || !!initial?.connection.options?.models_url}>
        <summary className="cursor-pointer text-sm font-medium">{t($ => $.endpoint_setup.optional)}</summary>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={options.fetch_models !== false}
          onChange={event => setOptions({ fetch_models: event.target.checked })} />{t($ => $.endpoint_setup.auto_fetch)}</label>
        <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.auto_fetch_hint)}</p>
        <label className="block text-sm">{t($ => $.endpoint_setup.models_url)}
          <Input type="url" value={options.models_url ?? ""} placeholder="https://example.com/v1/models"
            onChange={event => setOptions({ models_url: event.target.value })} /></label>
        <label className="block text-sm">{t($ => $.endpoint_setup.manual_models)}
          <textarea ref={manualInput} rows={4} className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs"
            value={manual} onChange={event => setManualModels(event.target.value)} /></label>
        <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.manual_hint)}</p>
        <label className="block text-sm">{t($ => $.endpoint_setup.headers)}
          <textarea rows={3} className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs" value={headers}
            onChange={event => { setHeaders(event.target.value);
              try { const value = JSON.parse(event.target.value || "{}");
                if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(item => typeof item !== "string")) throw new Error();
                setOptions({ headers: value }); setValidation("");
              } catch { setValidation(t($ => $.endpoint_setup.headers_invalid)); }
            }} /></label>
        <p className="text-xs text-muted-foreground">{t($ => $.endpoint_setup.headers_hint)}</p>
        <label className="block text-sm">{t($ => $.endpoint_setup.timeout)}
          <Input type="number" min={1} max={120} value={(options.timeout_ms ?? 15000) / 1000}
            onChange={event => setOptions({ timeout_ms: Number(event.target.value) * 1000 })} /></label>
      </details>
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
      {!validation && <EndpointModels endpointId={initial?.id} revision={initial?.revision} dirty={!!key || JSON.stringify(connection) !== JSON.stringify(initial?.connection)} connection={connection} apiKey={key}
        onAddManual={() => {
          if (optionalSection.current) optionalSection.current.open = true;
          manualInput.current?.focus();
          manualInput.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
        }}
        onAddModel={(id, display) => {
          if (options.manual_models?.some(model => model.id === id)) return;
          setManualModels([manual, display && display !== id ? `${id} | ${display}` : id].filter(Boolean).join("\n"));
        }} />}
      <p className="text-xs text-muted-foreground">{t($ => $.configuration.endpoint_hint)}</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={!connection.protocols.length || !!validation}>{t($ => $.configuration.save_endpoint)}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>{t($ => $.configuration.cancel)}</Button>
      </div>
    </fieldset>
  </form>;
}
