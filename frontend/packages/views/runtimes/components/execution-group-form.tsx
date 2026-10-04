"use client";

import { useState } from "react";
import type {
  ExecutionGroupList,
  ExecutionGroupInput,
  ExecutionProfile,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import { useT } from "../../i18n";
import {
  ConnectionFields,
  connectionDraft,
  connectionInput,
} from "./execution-profile-form";

type Group = ExecutionGroupList["groups"][number];

export function GroupForm({
  initial,
  profiles,
  groups,
  runtimes,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Group;
  profiles: ExecutionProfile[];
  groups: Group[];
  runtimes: Array<{ id: string; name: string; provider: string }>;
  pending: boolean;
  onSave: (input: ExecutionGroupInput) => void;
  onCancel: () => void;
}) {
  const { t } = useT("runtimes");
  const [input, setInput] = useState<ExecutionGroupInput>({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    provider: initial?.provider ?? "codex",
    profile_id: initial?.profile_id ?? null,
    runtime_ids: initial?.runtime_ids ?? [],
  });
  const [connectionMode, setConnectionMode] = useState(
    initial?.profile_id ?? "native",
  );
  const [editingConnection, setEditingConnection] = useState(false);
  const [draft, setDraft] = useState(() => connectionDraft());
  const profile = profiles.find((p) => p.id === input.profile_id);
  const compatibleRuntimes = runtimes.filter(
    (r) => r.provider === input.provider || r.provider === "any",
  );
  const missingMembers = input.runtime_ids.filter(
    (id) => !compatibleRuntimes.some((r) => r.id === id),
  );
  const customSupported =
    input.provider === "codex" || input.provider === "claude";
  const selectConnection = (mode: string) => {
    setConnectionMode(mode);
    setInput({
      ...input,
      profile_id: mode === "native" || mode === "new" ? null : mode,
    });
    setEditingConnection(mode === "new");
    setDraft(connectionDraft());
  };
  const sharedCount = profile
    ? groups.filter((g) => g.profile_id === profile.id).length
    : 0;

  return (
    <form
      aria-label={t(($) => $.configuration.groups)}
      className="rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...input,
          ...(editingConnection ? { connection: connectionInput(draft) } : {}),
        });
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        <label className="block text-sm">
          {t(($) => $.configuration.name)}
          <Input
            required
            maxLength={128}
            value={input.name}
            onChange={(e) => setInput({ ...input, name: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          {t(($) => $.configuration.group_description)}
          <textarea
            maxLength={2000}
            value={input.description}
            onChange={(e) =>
              setInput({ ...input, description: e.target.value })
            }
            className="mt-1 min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          {t(($) => $.configuration.provider)}
          <NativeSelect
            className="max-w-full"
            aria-label={t(($) => $.configuration.provider)}
            value={input.provider}
            disabled={!!initial}
            onChange={(e) => {
              setInput({
                ...input,
                provider: e.target.value,
                profile_id: null,
                runtime_ids: [],
              });
              setConnectionMode("native");
              setEditingConnection(false);
              setDraft(connectionDraft());
            }}
          >
            {[
              ...new Set([
                "codex",
                "claude",
                "antigravity",
                ...(initial ? [initial.provider] : []),
              ]),
            ].map((provider) => (
              <NativeSelectOption key={provider} value={provider}>
                {provider === "claude"
                  ? "Claude Code"
                  : provider === "codex"
                    ? "Codex"
                    : provider === "antigravity"
                      ? "Antigravity"
                      : provider}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <section className="space-y-3 rounded-md border p-3">
          <h3 className="text-sm font-medium">
            {t(($) => $.configuration.provider_models)}
          </h3>
          <label className="block text-sm">
            {t(($) => $.configuration.connection)}
            <NativeSelect
              className="max-w-full"
              aria-label={t(($) => $.configuration.connection)}
              value={connectionMode}
              onChange={(e) => selectConnection(e.target.value)}
            >
              <NativeSelectOption value="native">
                {t(($) => $.configuration.native)}
              </NativeSelectOption>
              {customSupported && (
                <NativeSelectOption value="new">
                  {t(($) => $.configuration.new_connection)}
                </NativeSelectOption>
              )}
              {profiles
                .filter((p) => p.provider === input.provider)
                .map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              {input.profile_id && !profile && (
                <NativeSelectOption value={input.profile_id} disabled>
                  {t(($) => $.configuration.unavailable_connection)}
                </NativeSelectOption>
              )}
            </NativeSelect>
          </label>
          {editingConnection ? (
            <>
              {sharedCount > 1 && (
                <p role="status" className="text-sm text-warning">
                  {t(($) => $.configuration.shared_connection, {
                    count: sharedCount,
                  })}
                </p>
              )}
              <ConnectionFields
                value={draft}
                onChange={setDraft}
                provider={input.provider}
              />
              {profile && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingConnection(false);
                    setDraft(connectionDraft());
                  }}
                >
                  {t(($) => $.configuration.discard_connection)}
                </Button>
              )}
            </>
          ) : profile ? (
            <>
              <p className="break-all text-sm text-muted-foreground">
                {t(($) => $.configuration.default_model, {
                  model: profile.profile.model,
                })}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {profile.profile.models?.join(" · ") ??
                  t(($) => $.configuration.discovered_models)}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft(connectionDraft(profile));
                  setEditingConnection(true);
                }}
              >
                {t(($) => $.configuration.edit_connection)}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(($) => $.configuration.native_models)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t(($) => $.configuration.model_selection_hint)}
          </p>
        </section>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {t(($) => $.configuration.members)}
          </legend>
          {compatibleRuntimes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.configuration.no_compatible_runtimes)}
            </p>
          )}
          {compatibleRuntimes.map((runtime) => (
            <label className="flex items-center gap-2 text-sm" key={runtime.id}>
              <input
                type="checkbox"
                checked={input.runtime_ids.includes(runtime.id)}
                onChange={(e) =>
                  setInput({
                    ...input,
                    runtime_ids: e.target.checked
                      ? [...input.runtime_ids, runtime.id]
                      : input.runtime_ids.filter((id) => id !== runtime.id),
                  })
                }
              />
              <span className="truncate" title={runtime.id}>
                {runtime.name}
              </span>
            </label>
          ))}
          {missingMembers.map((id) => (
            <label className="flex items-center gap-2 text-sm" key={id}>
              <input
                type="checkbox"
                checked
                onChange={() =>
                  setInput({
                    ...input,
                    runtime_ids: input.runtime_ids.filter(
                      (member) => member !== id,
                    ),
                  })
                }
              />
              <span className="break-all">{id}</span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            {t(($) => $.configuration.members_hint)}
          </p>
        </fieldset>
        <Button type="submit" disabled={!!input.profile_id && !profile}>
          {t(($) => $.configuration.save_group)}
        </Button>{" "}
        <Button type="button" variant="outline" onClick={onCancel}>
          {t(($) => $.configuration.cancel)}
        </Button>
      </fieldset>
    </form>
  );
}
