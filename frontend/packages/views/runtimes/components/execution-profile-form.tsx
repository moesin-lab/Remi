"use client";

import { useState } from "react";
import type {
  ExecutionProfile,
  ExecutionProfileInput,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";

export interface ConnectionDraft {
  name: string;
  profile: ExecutionProfileInput["profile"];
  apiKey: string;
  models: string;
}

export function connectionDraft(initial?: ExecutionProfile): ConnectionDraft {
  return {
    name: initial?.name ?? "",
    profile: initial?.profile ?? {
      name: "custom",
      base_url: "",
      model: "",
      env_key: "",
      auth_mode: "api_key",
    },
    apiKey: "",
    models: initial?.profile.models?.join("\n") ?? "",
  };
}

export function connectionInput(
  draft: ConnectionDraft,
): Omit<ExecutionProfileInput, "provider"> {
  const models = [
    ...new Set(
      draft.models
        .split(/[,\n]/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const { models: _previousModels, ...profile } = draft.profile;
  return {
    name: draft.name,
    profile: {
      ...profile,
      ...(models.length
        ? {
            models: [
              profile.model.trim(),
              ...models.filter((id) => id !== profile.model.trim()),
            ],
          }
        : {}),
    },
    ...(draft.apiKey && profile.auth_mode === "api_key"
      ? { api_key: draft.apiKey }
      : {}),
  };
}

/** Shared controlled fields, also embedded in a group's single atomic save. */
export function ConnectionFields({
  value,
  onChange,
  provider,
}: {
  value: ConnectionDraft;
  onChange: (value: ConnectionDraft) => void;
  provider: string;
}) {
  const { t } = useT("runtimes");
  const profile = value.profile;
  const change = (patch: Partial<typeof profile>) =>
    onChange({ ...value, profile: { ...profile, ...patch } });
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        {t(($) => $.configuration.connection_name)}
        <Input
          required
          maxLength={128}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      {(["name", "base_url", "model"] as const).map((key) => (
        <label className="block text-sm" key={key}>
          {t(($) => $.codex_profile[key])}
          <Input
            required
            value={profile[key]}
            onChange={(e) => change({ [key]: e.target.value })}
          />
        </label>
      ))}
      <label className="block text-sm">
        {t(($) => $.codex_profile.models)}
        <textarea
          value={value.models}
          onChange={(e) => onChange({ ...value, models: e.target.value })}
          className="mt-1 min-h-24 w-full rounded-md border bg-background p-2 text-sm"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(($) => $.codex_profile.models_hint)}
        </span>
      </label>
      <label className="block text-sm">
        {t(($) => $.codex_profile.auth)}
        <NativeSelect
          className="max-w-full"
          aria-label={t(($) => $.codex_profile.auth)}
          value={profile.auth_mode ?? "env"}
          onChange={(e) =>
            onChange({
              ...value,
              apiKey: "",
              profile: {
                ...profile,
                auth_mode: e.target.value as "api_key" | "env",
              },
            })
          }
        >
          <NativeSelectOption value="api_key">
            {t(($) => $.codex_profile.api_key)}
          </NativeSelectOption>
          <NativeSelectOption value="env">
            {t(($) => $.codex_profile.environment)}
          </NativeSelectOption>
        </NativeSelect>
      </label>
      {profile.auth_mode === "api_key" ? (
        <label className="block text-sm">
          {t(($) => $.codex_profile.api_key)}
          <Input
            type="password"
            autoComplete="new-password"
            required={!profile.credential_id}
            value={value.apiKey}
            placeholder={
              profile.credential_id ? t(($) => $.codex_profile.key_saved) : ""
            }
            onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
          />
        </label>
      ) : (
        <label className="block text-sm">
          {t(($) => $.codex_profile.env_key)}
          <Input
            required
            value={profile.env_key}
            onChange={(e) => change({ env_key: e.target.value })}
          />
        </label>
      )}
      {provider === "claude" && (
        <label className="block text-sm">
          {t(($) => $.claude_profile.auth_header)}
          <NativeSelect
            className="max-w-full"
            aria-label={t(($) => $.claude_profile.auth_header)}
            value={profile.auth_header ?? "bearer"}
            onChange={(e) =>
              change({ auth_header: e.target.value as "bearer" | "x-api-key" })
            }
          >
            <NativeSelectOption value="bearer">Bearer Token</NativeSelectOption>
            <NativeSelectOption value="x-api-key">
              API Key (x-api-key)
            </NativeSelectOption>
          </NativeSelect>
        </label>
      )}
      <p className="text-xs text-muted-foreground">
        {t(($) => $.codex_profile.sessions_hint)}
      </p>
    </div>
  );
}

export function ProfileForm({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: ExecutionProfile;
  pending: boolean;
  onSave: (input: ExecutionProfileInput) => void;
  onCancel: () => void;
}) {
  const { t } = useT("runtimes");
  const [provider, setProvider] = useState<"claude" | "codex">(
    initial?.provider ?? "codex",
  );
  const [draft, setDraft] = useState(() => connectionDraft(initial));
  return (
    <form
      aria-label={t(($) => $.configuration.profiles)}
      className="rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...connectionInput(draft), provider });
      }}
    >
      <fieldset disabled={pending} className="space-y-3">
        <label className="block text-sm">
          {t(($) => $.configuration.provider)}
          <NativeSelect
            className="max-w-full"
            aria-label={t(($) => $.configuration.provider)}
            value={provider}
            disabled={!!initial}
            onChange={(e) => {
              setProvider(e.target.value as "claude" | "codex");
              setDraft(connectionDraft());
            }}
          >
            <NativeSelectOption value="codex">Codex</NativeSelectOption>
            <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
          </NativeSelect>
        </label>
        <ConnectionFields
          value={draft}
          onChange={setDraft}
          provider={provider}
        />
        <Button type="submit">{t(($) => $.codex_profile.save)}</Button>{" "}
        <Button type="button" variant="outline" onClick={onCancel}>
          {t(($) => $.configuration.cancel)}
        </Button>
      </fieldset>
    </form>
  );
}
