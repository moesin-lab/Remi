"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { agentListOptions, historicalActorListOptions, squadListOptions } from "@multiremi/core/workspace/queries";
import { resolvePublicFileUrl } from "@multiremi/core/workspace/avatar-url";
import { AppLink } from "../../navigation";
import { PageHeader } from "../../layout/page-header";
import { Users, Plus, Search, Bot, User } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { ActorAvatar as ActorAvatarBase } from "@multiremi/ui/components/common/actor-avatar";
import { useModalStore } from "@multiremi/core/modals";
import type { Agent, Squad } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";

export function SquadsPage() {
  const { t } = useT("squads");
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const p = useWorkspacePaths();
  const { data: squads = [], isLoading } = useQuery({
    ...squadListOptions(wsId),
    enabled: !!wsId,
  });
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(historicalActorListOptions(wsId));

  const agentsById = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const membersByUserId = useMemo(() => {
    const m = new Map<string, { name: string; avatar_url: string | null }>();
    for (const mem of members) m.set(mem.user_id, { name: mem.name, avatar_url: mem.avatar_url });
    return m;
  }, [members]);

  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return squads.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !matchesPinyin(s.name, q) && !s.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [squads, search]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {!isLoading && squads.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">{squads.length}</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => useModalStore.getState().open("create-squad")}>
          <Plus className="size-3.5 mr-1.5" />
          {t(($) => $.page.new_button)}
        </Button>
      </PageHeader>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {isLoading ? (
          <SquadsListSkeleton />
        ) : squads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Users className="size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t(($) => $.page.empty_no_squads)}</p>
          </div>
        ) : (
          <>
            <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
              <div className="relative flex-1 min-w-0 max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search squads..."
                  className="h-8 w-full pl-8 text-sm"
                />
              </div>
              <span className="hidden sm:inline font-mono text-xs tabular-nums text-muted-foreground/70">
                {filtered.length} / {squads.length}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <p className="text-sm text-muted-foreground">{t(($) => $.page.empty_no_match)}</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4">
                <div className="grid gap-3">
                  {filtered.map((squad) => (
                    <SquadCard key={squad.id} squad={squad} leader={agentsById.get(squad.leader_id)} creator={membersByUserId.get(squad.creator_id)} href={p.squadDetail(squad.id)} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SquadCard({ squad, leader, creator, href }: { squad: Squad; leader?: Agent; creator?: { name: string; avatar_url: string | null }; href: string }) {
  return (
    <AppLink
      href={href}
      className="flex items-center gap-3 sm:gap-4 rounded-lg border p-3 sm:p-4 hover:bg-accent/50 transition-colors w-full overflow-hidden"
    >
      <SquadAvatar squad={squad} />
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="font-medium truncate">{squad.name}</p>
        {squad.description && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">{squad.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          {leader && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <Bot className="size-3 shrink-0" />
              <span className="truncate">{leader.name}</span>
            </div>
          )}
          {creator && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <User className="size-3 shrink-0" />
              <span className="truncate">{creator.name}</span>
            </div>
          )}
        </div>
      </div>
    </AppLink>
  );
}

function SquadsListSkeleton() {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Skeleton className="h-8 w-full max-w-sm rounded-md" />
        <Skeleton className="h-7 w-32 rounded-md" />
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 sm:gap-4 rounded-lg border p-3 sm:p-4">
              <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/3 rounded" />
                <Skeleton className="h-3 w-2/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SquadAvatar({ squad }: { squad: Squad }) {
  const initials = squad.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  if (squad.avatar_url) {
    return (
      <ActorAvatarBase
        name={squad.name}
        initials={initials}
        avatarUrl={resolvePublicFileUrl(squad.avatar_url)}
        size={36}
        className="rounded-md"
      />
    );
  }
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      title={squad.name}
    >
      <Users className="h-4 w-4" />
    </div>
  );
}
