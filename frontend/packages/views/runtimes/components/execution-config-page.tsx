"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  executionProfileListOptions,
  executionGroupListOptions,
  runtimeListOptions,
  useExecutionConfigMutation,
  type ExecutionProfile,
  type ExecutionGroupList,
} from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { ProfileForm } from "./execution-profile-form";
import { GroupForm } from "./execution-group-form";

type Group = ExecutionGroupList["groups"][number];

export function ExecutionConfigPage() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const user = useAuthStore((s) => s.user);
  const members = useQuery(memberListOptions(wsId));
  const canManage =
    members.data?.some(
      (m) =>
        m.user_id === user?.id && (m.role === "owner" || m.role === "admin"),
    ) ?? false;
  const profiles = useQuery(executionProfileListOptions(wsId));
  const groups = useQuery({
    ...executionGroupListOptions(wsId),
    refetchInterval: 10_000,
  });
  const runtimes = useQuery(runtimeListOptions(wsId));
  const mutation = useExecutionConfigMutation(wsId);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [editProfile, setEditProfile] = useState<
    ExecutionProfile | "new" | null
  >(null);
  const [editGroup, setEditGroup] = useState<Group | "new" | null>(null);
  const visibleGroups = (groups.data?.groups ?? [])
    .filter(
      (group) =>
        (providerFilter === "all" || group.provider === providerFilter) &&
        [group.name, group.description, group.provider].some((value) =>
          value
            ?.toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase()),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const run = (command: () => Promise<unknown>, done?: () => void) =>
    mutation.mutate(command, { onSuccess: done });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BreadcrumbHeader segments={[]} leaf={t(($) => $.configuration.groups)} />
      <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          {t(($) => $.configuration.description)}
        </p>
        {!canManage && <p role="status">{t(($) => $.detail.read_only)}</p>}
        {mutation.isError && (
          <p role="alert" className="text-destructive">
            {mutation.error.message}
          </p>
        )}
        {(profiles.isError || groups.isError || runtimes.isError) && (
          <p role="alert" className="text-destructive">
            {t(($) => $.configuration.load_error)}
          </p>
        )}
        {(groups.isPending ||
          runtimes.isPending ||
          (canManage && profiles.isPending)) && (
          <p role="status">{t(($) => $.codex_profile.loading)}</p>
        )}
        <section
          aria-label={t(($) => $.configuration.groups)}
          className="space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">
              {t(($) => $.configuration.groups)}
            </h2>
            {canManage && (
              <Button
                disabled={
                  mutation.isPending ||
                  profiles.isPending ||
                  runtimes.isPending ||
                  profiles.isError ||
                  runtimes.isError
                }
                onClick={() => {
                  setEditGroup("new");
                  setEditProfile(null);
                  mutation.reset();
                }}
              >
                {t(($) => $.configuration.add_group)}
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label={t(($) => $.configuration.search)}
              placeholder={t(($) => $.configuration.search)}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <NativeSelect
              className="shrink-0"
              aria-label={t(($) => $.configuration.provider_filter)}
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value)}
            >
              <NativeSelectOption value="all">
                {t(($) => $.configuration.all_providers)}
              </NativeSelectOption>
              {[
                ...new Set([
                  ...(groups.data?.groups ?? []).map((group) => group.provider),
                  ...(providerFilter === "all" ? [] : [providerFilter]),
                ]),
              ]
                .sort()
                .map((provider) => (
                  <NativeSelectOption key={provider} value={provider}>
                    {provider}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          {editGroup && (
            <GroupForm
              key={editGroup === "new" ? "new" : editGroup.id}
              initial={editGroup === "new" ? undefined : editGroup}
              profiles={profiles.data?.profiles ?? []}
              groups={groups.data?.groups ?? []}
              runtimes={runtimes.data ?? []}
              pending={
                mutation.isPending ||
                profiles.isPending ||
                runtimes.isPending ||
                profiles.isError ||
                runtimes.isError
              }
              onCancel={() => setEditGroup(null)}
              onSave={(input) =>
                run(
                  () =>
                    api.saveExecutionGroup(
                      wsId,
                      editGroup === "new" ? undefined : editGroup.id,
                      input,
                    ),
                  () => setEditGroup(null),
                )
              }
            />
          )}
          {visibleGroups.length === 0 && !!groups.data?.groups.length && (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.configuration.no_matches)}
            </p>
          )}
          {groups.data?.groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t(($) => $.configuration.no_groups)}
            </p>
          )}
          {visibleGroups.map((group) => (
            <article
              aria-label={group.name}
              className="space-y-2 rounded-lg border p-3"
              key={group.id}
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{group.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {group.provider} ·{" "}
                    {profiles.data?.profiles.find(
                      (p) => p.id === group.profile_id,
                    )?.name ??
                      (group.profile_id ||
                        t(($) =>
                          group.managed === false
                            ? $.configuration.legacy
                            : $.configuration.native,
                        ))}
                  </p>
                </div>
                {canManage && (
                  <>
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => {
                        setEditGroup(group);
                        setEditProfile(null);
                        mutation.reset();
                      }}
                    >
                      {t(($) => $.configuration.edit)}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() =>
                        run(() => api.deleteExecutionGroup(wsId, group.id))
                      }
                    >
                      {t(($) => $.configuration.delete)}
                    </Button>
                  </>
                )}
              </div>
              {group.description && (
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {group.description}
                </p>
              )}
              {profiles.data?.profiles.find(
                (profile) => profile.id === group.profile_id,
              )?.profile.model && (
                <p className="break-all text-xs text-muted-foreground">
                  {t(($) => $.configuration.default_model, {
                    model: profiles.data.profiles.find(
                      (profile) => profile.id === group.profile_id,
                    )!.profile.model,
                  })}
                </p>
              )}
              {group.runtime_ids.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.configuration.no_members)}
                </p>
              )}
              {group.runtime_ids.map((id) => (
                <div
                  className="flex items-center justify-between gap-3 text-sm"
                  key={id}
                >
                  <span className="truncate">
                    {runtimes.data?.find((r) => r.id === id)?.name ?? id}
                  </span>
                  <BindingState group={group} runtimeId={id} />
                </div>
              ))}
            </article>
          ))}
          <AppLink
            className="inline-block text-sm text-primary underline"
            href={paths.agents()}
          >
            {t(($) => $.configuration.assign_agents)}
          </AppLink>
        </section>
        {canManage && (
          <section
            aria-label={t(($) => $.configuration.profiles)}
            className="space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">
                {t(($) => $.configuration.profiles)}
              </h2>
              <Button
                disabled={mutation.isPending}
                onClick={() => {
                  setEditProfile("new");
                  setEditGroup(null);
                  mutation.reset();
                }}
              >
                {t(($) => $.configuration.add_profile)}
              </Button>
            </div>
            {profiles.data?.profiles.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t(($) => $.configuration.no_profiles)}
              </p>
            )}
            {profiles.data?.profiles.map((profile) => (
              <article
                key={profile.id}
                aria-label={profile.name}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{profile.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {profile.provider} · {profile.profile.model} · v
                    {profile.revision}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={mutation.isPending}
                  onClick={() => {
                    setEditProfile(profile);
                    setEditGroup(null);
                    mutation.reset();
                  }}
                >
                  {t(($) => $.configuration.edit)}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    mutation.isPending ||
                    groups.data?.groups.some((g) => g.profile_id === profile.id)
                  }
                  onClick={() =>
                    run(() => api.deleteExecutionProfile(wsId, profile.id))
                  }
                >
                  {t(($) => $.configuration.delete)}
                </Button>
              </article>
            ))}
            {editProfile && (
              <ProfileForm
                key={
                  editProfile === "new"
                    ? "new"
                    : `${editProfile.id}:${editProfile.revision}`
                }
                initial={editProfile === "new" ? undefined : editProfile}
                pending={mutation.isPending}
                onCancel={() => setEditProfile(null)}
                onSave={(input) =>
                  run(
                    () =>
                      api.saveExecutionProfile(
                        wsId,
                        editProfile === "new" ? undefined : editProfile.id,
                        input,
                      ),
                    () => setEditProfile(null),
                  )
                }
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function BindingState({
  group,
  runtimeId,
}: {
  group: Group;
  runtimeId: string;
}) {
  const { t } = useT("runtimes");
  const member = group.members?.find((m) => m.runtime_id === runtimeId);
  const status = member?.status;
  return (
    <span
      className="shrink-0 text-xs text-muted-foreground"
      title={member?.error ?? undefined}
    >
      {status === "ready"
        ? t(($) => $.configuration.applied)
        : status === "error"
          ? t(($) => $.configuration.failed)
          : status === "pending"
            ? t(($) => $.configuration.pending)
            : t(($) => $.configuration.unknown)}
    </span>
  );
}

export function RuntimeExecutionBindings({ runtimeId }: { runtimeId: string }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const query = useQuery({
    ...executionGroupListOptions(wsId),
    refetchInterval: 10_000,
  });
  const groups =
    query.data?.groups.filter((g) => g.runtime_ids.includes(runtimeId)) ?? [];
  return (
    <div className="space-y-2 text-sm">
      <AppLink
        className="text-primary underline"
        href={paths.executionGroups()}
      >
        {t(($) => $.configuration.title)}
      </AppLink>
      {query.isError ? (
        <p role="alert">{t(($) => $.configuration.load_error)}</p>
      ) : query.isPending ? (
        <p role="status">{t(($) => $.codex_profile.loading)}</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">
          {t(($) => $.configuration.no_groups)}
        </p>
      ) : (
        groups.map((group) => (
          <div className="flex justify-between gap-2" key={group.id}>
            <span className="truncate">{group.name}</span>
            <BindingState group={group} runtimeId={runtimeId} />
          </div>
        ))
      )}
    </div>
  );
}
