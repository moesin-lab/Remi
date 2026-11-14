"use client";

import { workspaceOperatorUser } from "@multiremi/core/workspace/operator";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  Filter,
  Globe,
  History,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { AgentRuntime } from "@multiremi/core/types";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  executionEndpointListOptions,
  executionGroupListOptions,
  runtimeListOptions,
  useExecutionConfigMutation,
  useExecutionTargetModels,
  type ExecutionEndpoint,
} from "@multiremi/core/runtimes";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multiremi/ui/components/ui/native-select";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { EmptyState } from "../../common/empty-state";
import { PageHeader } from "../../layout/page-header";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import {
  BindingStateBadge,
  formatEngineLabel,
  formatProtocolShortLabel,
  getGroupEndpointId,
  GroupRuntimeRow,
  isLegacyGroupConnection,
  type CapabilityGroup,
} from "./execution-config-shared";
import { EndpointForm } from "./execution-endpoint-form";
import { GroupForm } from "./execution-group-form";
import { ProviderLogo } from "./provider-logo";

const COLLAPSED_MODEL_LIMIT = 4;

export function ExecutionConfigPage() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const user = workspaceOperatorUser;

  const members = useQuery(memberListOptions(wsId));
  const canManage =
    members.data?.some(
      (m) =>
        m.user_id === user?.id && (m.role === "owner" || m.role === "admin"),
    ) ?? false;

  const profiles = useQuery(executionEndpointListOptions(wsId));
  const groups = useQuery({
    ...executionGroupListOptions(wsId),
    refetchInterval: 10_000,
  });
  const runtimes = useQuery(runtimeListOptions(wsId));
  const mutation = useExecutionConfigMutation(wsId);

  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [connectionFilter, setConnectionFilter] = useState<string>("all");
  const [mobilePane, setMobilePane] = useState<"groups" | "endpoints">(
    "groups",
  );
  const [editProfile, setEditProfile] = useState<
    ExecutionEndpoint | "new" | null
  >(null);
  const [editGroup, setEditGroup] = useState<CapabilityGroup | "new" | null>(
    null,
  );

  const allGroups = groups.data?.groups ?? [];
  const allEndpoints = profiles.data?.endpoints ?? [];
  const allRuntimes = runtimes.data ?? [];

  const runtimeById = useMemo(
    () => new Map(allRuntimes.map((r) => [r.id, r])),
    [allRuntimes],
  );
  const endpointById = useMemo(
    () => new Map(allEndpoints.map((e) => [e.id, e])),
    [allEndpoints],
  );

  const groupCountByEndpoint = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of allGroups) {
      const epId = getGroupEndpointId(group);
      if (epId) {
        counts.set(epId, (counts.get(epId) ?? 0) + 1);
      }
    }
    return counts;
  }, [allGroups]);

  const engineOptions = useMemo(
    () =>
      [
        ...new Set([
          ...allGroups.map((group) => group.provider),
          ...(providerFilter === "all" ? [] : [providerFilter]),
        ]),
      ].sort(),
    [allGroups, providerFilter],
  );

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(
    () =>
      allGroups
        .filter((group) => {
          if (providerFilter !== "all" && group.provider !== providerFilter) {
            return false;
          }
          const epId = getGroupEndpointId(group);
          if (connectionFilter === "native") {
            if (epId || isLegacyGroupConnection(group)) return false;
          } else if (connectionFilter !== "all" && epId !== connectionFilter) {
            return false;
          }
          if (!normalizedSearch) return true;
          const endpointName = epId ? endpointById.get(epId)?.name : undefined;
          return [group.name, group.description, group.provider, endpointName].some(
            (value) => value?.toLocaleLowerCase().includes(normalizedSearch),
          );
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allGroups, providerFilter, connectionFilter, normalizedSearch, endpointById],
  );

  const hasActiveFilters =
    normalizedSearch.length > 0 ||
    providerFilter !== "all" ||
    connectionFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setProviderFilter("all");
    setConnectionFilter("all");
  };

  const hasLoadError = profiles.isError || groups.isError || runtimes.isError;
  const isInitialLoading =
    groups.isPending ||
    runtimes.isPending ||
    (canManage && profiles.isPending);

  const groupWriteLocked =
    mutation.isPending ||
    groups.isPending ||
    runtimes.isPending ||
    profiles.isPending ||
    groups.isError ||
    runtimes.isError ||
    profiles.isError;

  const endpointWriteLocked =
    mutation.isPending || profiles.isPending || profiles.isError;

  const activeEndpointFilter =
    connectionFilter !== "all" && connectionFilter !== "native"
      ? endpointById.get(connectionFilter)
      : undefined;

  const run = (command: () => Promise<unknown>, done?: () => void) =>
    mutation.mutate(command, { onSuccess: done });

  const retryAll = () => {
    void Promise.all([
      groups.refetch(),
      runtimes.refetch(),
      ...(canManage ? [profiles.refetch()] : []),
    ]);
  };

  const mutationErrorMessage =
    mutation.isError && mutation.error instanceof Error
      ? mutation.error.message
      : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between gap-3 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="shrink-0 text-sm font-medium">
            {t(($) => $.configuration.groups)}
          </h1>
          {allGroups.length > 0 && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
              {allGroups.length}
            </span>
          )}
          <p className="ml-2 hidden min-w-0 truncate text-xs text-muted-foreground xl:block">
            {t(($) => $.configuration.description)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!canManage && !members.isPending && (
            <Badge
              variant="secondary"
              role="status"
              className="gap-1 font-normal text-muted-foreground"
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t(($) => $.detail.read_only)}
            </Badge>
          )}
          {canManage && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={endpointWriteLocked}
                onClick={() => {
                  setEditProfile("new");
                  setEditGroup(null);
                  mutation.reset();
                }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t(($) => $.configuration.add_endpoint)}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={groupWriteLocked}
                onClick={() => {
                  setEditGroup("new");
                  setEditProfile(null);
                  mutation.reset();
                }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t(($) => $.configuration.add_group)}
              </Button>
            </>
          )}
        </div>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
          {hasLoadError && (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-destructive/10 px-4 py-2.5 text-xs text-destructive"
            >
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t(($) => $.configuration.load_error)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={retryAll}
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {t(($) => $.configuration.retry)}
              </Button>
            </div>
          )}

          {mutationErrorMessage && !editGroup && !editProfile && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-4 py-2.5 text-xs text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{mutationErrorMessage}</span>
            </div>
          )}

          {isInitialLoading && (
            <p role="status" className="sr-only">
              {t(($) => $.codex_profile.loading)}
            </p>
          )}

          {canManage && (
            <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 p-1.5 lg:hidden">
              <button
                type="button"
                onClick={() => setMobilePane("groups")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  mobilePane === "groups"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t(($) => $.configuration.groups)}</span>
                <span className="font-mono text-[11px] tabular-nums opacity-70">
                  {allGroups.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMobilePane("endpoints")}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  mobilePane === "endpoints"
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t(($) => $.configuration.endpoints)}</span>
                <span className="font-mono text-[11px] tabular-nums opacity-70">
                  {allEndpoints.length}
                </span>
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1">
            {/* Left Main Column: Capability Groups */}
            <section
              aria-label={t(($) => $.configuration.groups)}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                canManage && mobilePane !== "groups" && "hidden lg:flex",
              )}
            >
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
                <div className="relative w-full sm:w-56">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    aria-label={t(($) => $.configuration.search)}
                    placeholder={t(($) => $.configuration.search)}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-8 w-full pl-8 text-sm"
                  />
                </div>

                <NativeSelect
                  className="shrink-0"
                  aria-label={t(($) => $.configuration.provider_filter)}
                  value={providerFilter}
                  onChange={(event) => setProviderFilter(event.target.value)}
                >
                  <NativeSelectOption value="all">
                    {t(($) => $.configuration.all_providers)}
                  </NativeSelectOption>
                  {engineOptions.map((provider) => (
                    <NativeSelectOption key={provider} value={provider}>
                      {formatEngineLabel(provider)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setConnectionFilter(
                        connectionFilter === "native" ? "all" : "native",
                      )
                    }
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
                      connectionFilter === "native"
                        ? "border-brand/50 bg-brand/10 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <Terminal className="h-3 w-3" aria-hidden="true" />
                    <span>{t(($) => $.configuration.native)}</span>
                  </button>

                  {activeEndpointFilter && (
                    <button
                      type="button"
                      onClick={() => setConnectionFilter("all")}
                      className="inline-flex h-8 max-w-48 items-center gap-1.5 rounded-lg border border-brand/50 bg-brand/10 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-brand/15"
                    >
                      <Globe className="h-3 w-3 shrink-0 text-brand" aria-hidden="true" />
                      <span className="truncate">
                        {activeEndpointFilter.name}
                      </span>
                      <X className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                    </button>
                  )}

                  {hasActiveFilters && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs text-muted-foreground"
                      onClick={clearFilters}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      {t(($) => $.configuration.clear_filters)}
                    </Button>
                  )}
                </div>

                <AppLink
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  href={paths.agents()}
                >
                  <span>{t(($) => $.configuration.assign_agents)}</span>
                  <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                </AppLink>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-muted/[0.12] p-3 sm:p-4">
                {groups.isPending || runtimes.isPending ? (
                  <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton
                        key={index}
                        className="h-36 w-full rounded-xl"
                      />
                    ))}
                  </div>
                ) : allGroups.length === 0 ? (
                  <EmptyState
                    icon={Layers}
                    title={t(($) => $.configuration.no_groups)}
                    description={t(
                      ($) => $.configuration.no_groups_description,
                    )}
                  />
                ) : visibleGroups.length === 0 ? (
                  <EmptyState
                    variant="status"
                    icon={Search}
                    title={t(($) => $.configuration.no_matches)}
                    action={
                      hasActiveFilters ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={clearFilters}
                        >
                          {t(($) => $.configuration.clear_filters)}
                        </Button>
                      ) : null
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    {visibleGroups.map((group) => {
                      const epId = getGroupEndpointId(group);
                      const endpoint = epId
                        ? endpointById.get(epId)
                        : undefined;
                      return (
                        <CapabilityGroupCard
                          key={group.id}
                          wsId={wsId}
                          group={group}
                          endpoint={endpoint}
                          runtimeById={runtimeById}
                          canManage={canManage}
                          pending={mutation.isPending}
                          isFilteredEndpoint={
                            !!epId && connectionFilter === epId
                          }
                          onToggleEndpointFilter={(targetId) =>
                            setConnectionFilter((prev) =>
                              prev === targetId ? "all" : targetId,
                            )
                          }
                          onEdit={() => {
                            setEditGroup(group);
                            setEditProfile(null);
                            mutation.reset();
                          }}
                          onDelete={() =>
                            run(() => api.deleteExecutionGroup(wsId, group.id))
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Right Sidebar Column: Gateway Endpoints */}
            {canManage && (
              <section
                aria-label={t(($) => $.configuration.endpoints)}
                className={cn(
                  "flex min-h-0 w-full shrink-0 flex-col bg-muted/[0.06] lg:w-[22rem] lg:border-l xl:w-[25rem]",
                  mobilePane !== "endpoints" && "hidden lg:flex",
                )}
              >
                <div className="flex h-[53px] shrink-0 items-center justify-between gap-2 border-b px-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <Globe
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <h2 className="truncate text-xs font-semibold tracking-wide text-foreground">
                      {t(($) => $.configuration.endpoints)}
                    </h2>
                    {allEndpoints.length > 0 && (
                      <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
                        {allEndpoints.length}
                      </span>
                    )}
                  </div>
                  {activeEndpointFilter && (
                    <button
                      type="button"
                      onClick={() => setConnectionFilter("all")}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-brand hover:bg-brand/10"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      {t(($) => $.configuration.clear_filters)}
                    </button>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
                  {profiles.isPending ? (
                    <div className="space-y-2.5">
                      {Array.from({ length: 2 }).map((_, index) => (
                        <Skeleton
                          key={index}
                          className="h-28 w-full rounded-xl"
                        />
                      ))}
                    </div>
                  ) : allEndpoints.length === 0 ? (
                    <EmptyState
                      variant="status"
                      icon={Globe}
                      title={t(($) => $.configuration.endpoints)}
                      description={t(($) => $.configuration.no_endpoints)}
                      className="py-12"
                    />
                  ) : (
                    <div className="space-y-2.5">
                      {allEndpoints.map((endpoint) => {
                        const refCount =
                          groupCountByEndpoint.get(endpoint.id) ?? 0;
                        const isSelectedFilter =
                          connectionFilter === endpoint.id;
                        return (
                          <EndpointCard
                            key={endpoint.id}
                            endpoint={endpoint}
                            refCount={refCount}
                            isSelectedFilter={isSelectedFilter}
                            pending={mutation.isPending}
                            onToggleFilter={() => {
                              setConnectionFilter((prev) =>
                                prev === endpoint.id ? "all" : endpoint.id,
                              );
                              setMobilePane("groups");
                            }}
                            onEdit={() => {
                              setEditProfile(endpoint);
                              setEditGroup(null);
                              mutation.reset();
                            }}
                            onDelete={() => {
                              if (connectionFilter === endpoint.id) {
                                setConnectionFilter("all");
                              }
                              run(() =>
                                api.deleteExecutionEndpoint(wsId, endpoint.id),
                              );
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Capability Group Slide-Over Drawer */}
      <Sheet
        open={!!editGroup}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setEditGroup(null);
            mutation.reset();
          }
        }}
      >
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          {editGroup && (
            <GroupForm
              key={editGroup === "new" ? "new" : editGroup.id}
              inSheet
              initial={editGroup === "new" ? undefined : editGroup}
              endpoints={allEndpoints}
              runtimes={allRuntimes}
              pending={groupWriteLocked}
              errorMessage={mutationErrorMessage}
              onCancel={() => {
                setEditGroup(null);
                mutation.reset();
              }}
              onSave={(input) =>
                run(
                  () =>
                    api.saveExecutionGroup(
                      wsId,
                      editGroup === "new" ? undefined : editGroup.id,
                      input,
                    ),
                  () => {
                    setEditGroup(null);
                    setMobilePane("groups");
                  },
                )
              }
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Gateway Endpoint Slide-Over Drawer */}
      <Sheet
        open={!!editProfile}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setEditProfile(null);
            mutation.reset();
          }
        }}
      >
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        >
          {editProfile && (
            <EndpointForm
              key={
                editProfile === "new"
                  ? "new"
                  : `${editProfile.id}:${editProfile.revision}`
              }
              inSheet
              initial={editProfile === "new" ? undefined : editProfile}
              sharedGroupCount={
                editProfile === "new"
                  ? 0
                  : (groupCountByEndpoint.get(editProfile.id) ?? 0)
              }
              pending={mutation.isPending}
              errorMessage={mutationErrorMessage}
              onCancel={() => {
                setEditProfile(null);
                mutation.reset();
              }}
              onSave={(input) =>
                run(
                  () =>
                    api.saveExecutionEndpoint(
                      wsId,
                      editProfile === "new" ? undefined : editProfile.id,
                      input,
                    ),
                  () => {
                    setEditProfile(null);
                  },
                )
              }
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CapabilityGroupCard({
  wsId,
  group,
  endpoint,
  runtimeById,
  canManage,
  pending,
  isFilteredEndpoint,
  onToggleEndpointFilter,
  onEdit,
  onDelete,
}: {
  wsId: string;
  group: CapabilityGroup;
  endpoint?: ExecutionEndpoint;
  runtimeById: Map<string, AgentRuntime>;
  canManage: boolean;
  pending: boolean;
  isFilteredEndpoint: boolean;
  onToggleEndpointFilter: (target: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("runtimes");
  const endpointId = getGroupEndpointId(group);
  const isLegacy = isLegacyGroupConnection(group);
  const needsEndpoint = !endpointId && group.provider === "antigravity";

  const readyCount = group.runtime_ids.filter(
    (id) => group.members?.find((m) => m.runtime_id === id)?.status === "ready",
  ).length;
  const hasBindingError = group.runtime_ids.some(
    (id) => group.members?.find((m) => m.runtime_id === id)?.status === "error",
  );
  const allReady =
    group.runtime_ids.length > 0 && readyCount === group.runtime_ids.length;

  return (
    <article
      aria-label={group.name}
      className={cn(
        "overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/15",
        (needsEndpoint || hasBindingError) && "border-warning/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/35">
            <ProviderLogo provider={group.provider} className="h-4 w-4" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {group.name}
              </h3>

              <span className="inline-flex items-center rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {formatEngineLabel(group.provider)}
              </span>

              {endpoint ? (
                <button
                  type="button"
                  onClick={() => onToggleEndpointFilter(endpoint.id)}
                  title={t(($) => $.configuration.filter_by_endpoint)}
                  className={cn(
                    "inline-flex max-w-52 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                    isFilteredEndpoint
                      ? "border-brand/50 bg-brand/10 text-foreground"
                      : "border-border bg-background text-foreground/85 hover:bg-muted/60",
                  )}
                >
                  <Globe
                    className="h-3 w-3 shrink-0 text-brand"
                    aria-hidden="true"
                  />
                  <span className="truncate">{endpoint.name}</span>
                </button>
              ) : endpointId ? (
                <span className="inline-flex max-w-52 items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{endpointId}</span>
                </span>
              ) : isLegacy ? (
                <span className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <History className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{t(($) => $.configuration.legacy)}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onToggleEndpointFilter("native")}
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <Terminal className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{t(($) => $.configuration.native)}</span>
                </button>
              )}
            </div>

            {group.description && (
              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                {group.description}
              </p>
            )}

            {needsEndpoint && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t(($) => $.configuration.endpoint_required)}</span>
              </p>
            )}
          </div>
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={pending}
              onClick={onEdit}
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              {t(($) => $.configuration.edit)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={pending}
              onClick={onDelete}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              {t(($) => $.configuration.delete)}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 border-t bg-muted/[0.16] px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Left Zone: Model Strategy & Discovered Catalog */}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
              {t(($) => $.configuration.model_catalog)}
            </span>
            {group.model_policy?.model && (
              <span className="inline-flex max-w-full items-center truncate rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">
                {t(($) => $.configuration.default_model, {
                  model: group.model_policy!.model!,
                })}
              </span>
            )}
            {!!group.model_policy?.models?.length && (
              <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t(($) => $.configuration.allowlist_count, {
                  count: group.model_policy!.models!.length,
                })}
              </span>
            )}
          </div>

          {group.runtime_ids.length > 0 ? (
            <GroupModelCatalog wsId={wsId} group={group} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(($) => $.configuration.catalog_needs_machines)}
            </p>
          )}
        </div>

        {/* Right Zone: Assigned Machines & Sync State */}
        <div className="min-w-0 space-y-2 md:border-l md:pl-3">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
              {t(($) => $.configuration.members)}
            </span>
            {group.runtime_ids.length > 0 && (
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums",
                  allReady ? "text-success" : "text-muted-foreground",
                )}
              >
                {t(($) => $.configuration.ready_summary, {
                  ready: readyCount,
                  total: group.runtime_ids.length,
                })}
              </span>
            )}
          </div>

          {group.runtime_ids.length === 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-warning/35 bg-warning/[0.05] px-2.5 py-2 text-xs text-muted-foreground">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>{t(($) => $.configuration.no_members)}</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {group.runtime_ids.map((id) => (
                <GroupRuntimeRow
                  key={id}
                  group={group}
                  runtime={runtimeById.get(id)}
                  runtimeId={id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function EndpointCard({
  endpoint,
  refCount,
  isSelectedFilter,
  pending,
  onToggleFilter,
  onEdit,
  onDelete,
}: {
  endpoint: ExecutionEndpoint;
  refCount: number;
  isSelectedFilter: boolean;
  pending: boolean;
  onToggleFilter: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("runtimes");

  return (
    <article
      aria-label={endpoint.name}
      className={cn(
        "rounded-xl border bg-card p-3.5 transition-all hover:border-foreground/15",
        isSelectedFilter && "border-brand bg-brand/[0.02] ring-1 ring-brand/25",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {endpoint.name}
          </h3>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            v{endpoint.revision}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={pending}
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            {t(($) => $.configuration.edit)}
          </Button>
          <span
            title={
              refCount > 0
                ? t(($) => $.configuration.endpoint_in_use_hint)
                : undefined
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={pending || refCount > 0}
              onClick={onDelete}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              {t(($) => $.configuration.delete)}
            </Button>
          </span>
        </div>
      </div>

      <p
        className="mt-1 truncate font-mono text-xs text-muted-foreground"
        title={endpoint.connection.base_url}
      >
        {endpoint.connection.base_url}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {endpoint.connection.protocols.map((protocol) => (
          <span
            key={protocol}
            title={protocol}
            className="inline-flex items-center rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-foreground/80"
          >
            {formatProtocolShortLabel(protocol)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 rounded-md bg-muted/65 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <KeyRound className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
          <span className="max-w-28 truncate font-mono text-[10px]">
            {endpoint.connection.auth_mode === "env"
              ? endpoint.connection.env_key || "ENV"
              : "API Key"}
          </span>
        </span>
      </div>

      <div className="mt-2.5 border-t pt-2">
        <button
          type="button"
          onClick={onToggleFilter}
          title={t(($) => $.configuration.filter_by_endpoint)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors",
            isSelectedFilter
              ? "bg-brand/10 font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span className="min-w-0 flex-1">
            {refCount > 1
              ? t(($) => $.configuration.shared_connection, {
                  count: refCount,
                })
              : refCount === 1
                ? t(($) => $.configuration.single_group_connection)
                : t(($) => $.configuration.unused_endpoint)}
          </span>
          <Filter
            className={cn(
              "h-3 w-3 shrink-0",
              isSelectedFilter ? "text-brand" : "opacity-50",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
    </article>
  );
}

function GroupModelCatalog({
  wsId,
  group,
}: {
  wsId: string;
  group: CapabilityGroup;
}) {
  const { t } = useT("runtimes");
  const [expanded, setExpanded] = useState(false);
  const { models, modelCatalogStatus, isLoading, isError } =
    useExecutionTargetModels(wsId, group.provider, null, group.id);
  const availableModels = models.filter(
    (model) =>
      model.execution_status === undefined ||
      model.execution_status === "available",
  );

  if (isError || modelCatalogStatus === "error") {
    return (
      <section
        aria-label={t(($) => $.configuration.model_catalog)}
        className="text-xs"
      >
        <p role="alert" className="text-destructive">
          {t(($) => $.configuration.catalog_error)}
        </p>
      </section>
    );
  }

  if (isLoading || modelCatalogStatus === "unknown") {
    return (
      <section
        aria-label={t(($) => $.configuration.model_catalog)}
        className="text-xs text-muted-foreground"
      >
        <p role="status" className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t(($) => $.configuration.catalog_loading)}
        </p>
      </section>
    );
  }

  if (availableModels.length === 0) {
    return (
      <section
        aria-label={t(($) => $.configuration.model_catalog)}
        className="text-xs text-muted-foreground"
      >
        <p>{t(($) => $.configuration.catalog_empty)}</p>
      </section>
    );
  }

  const displayed = expanded
    ? availableModels
    : availableModels.slice(0, COLLAPSED_MODEL_LIMIT);
  const hasMore = availableModels.length > COLLAPSED_MODEL_LIMIT;

  return (
    <section
      aria-label={t(($) => $.configuration.model_catalog)}
      className="space-y-1.5 text-xs text-muted-foreground"
    >
      <p className="text-[11px] text-muted-foreground">
        {t(($) => $.configuration.catalog_count, {
          count: availableModels.length,
        })}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {displayed.map((model) => (
          <li
            key={model.id}
            title={
              model.label && model.label !== model.id
                ? `${model.label} · ${model.id}`
                : model.id
            }
            className="max-w-full truncate rounded-md border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground/85"
          >
            {model.label && model.label !== model.id
              ? `${model.label} · ${model.id}`
              : model.id}
          </li>
        ))}
        {hasMore && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {expanded
                ? t(($) => $.configuration.collapse_models)
                : t(($) => $.configuration.show_all_models, {
                    count: availableModels.length,
                  })}
            </button>
          </li>
        )}
      </ul>
    </section>
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
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(($) => $.configuration.groups)}
        </span>
        <AppLink
          className="inline-flex items-center gap-0.5 text-xs text-foreground underline-offset-4 hover:underline"
          href={paths.executionGroups()}
        >
          {t(($) => $.configuration.title)}
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </AppLink>
      </div>
      {query.isError ? (
        <p role="alert" className="text-destructive">
          {t(($) => $.configuration.load_error)}
        </p>
      ) : query.isPending ? (
        <p role="status" className="text-muted-foreground">
          {t(($) => $.codex_profile.loading)}
        </p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground">
          {t(($) => $.configuration.no_groups)}
        </p>
      ) : (
        <div className="space-y-1.5">
          {groups.map((group) => (
            <div
              className="flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-2.5 py-1.5"
              key={group.id}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <ProviderLogo
                  provider={group.provider}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="truncate font-medium text-foreground">
                  {group.name}
                </span>
              </span>
              <BindingStateBadge group={group} runtimeId={runtimeId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
