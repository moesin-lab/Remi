"use client";

import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, GripVertical, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { botMenuOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import type {
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuItem,
  BotMenuPublishResponse,
} from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import { useFeishuBotSelection } from "./bot-selection";
import { useImWorkspaceAccess } from "../workspace-access";
import { ImLoadError } from "../load-error";

type DraftItem = BotMenuItem & { _id: string; children?: DraftItem[] };
type DraftConfig = { default: DraftItem[] };

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${localId}`;
}

export function BotMenuSection() {
  const workspaceId = useWorkspaceId();
  const { botId } = useFeishuBotSelection();
  return <BotMenuEditor key={`${workspaceId}:${botId}`} workspaceId={workspaceId} botId={botId} />;
}

function BotMenuEditor({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const { t } = useT("im-platforms");
  const queryClient = useQueryClient();
  const access = useImWorkspaceAccess(workspaceId);
  const canManage = access.canManage;
  const menuQuery = useQuery(botMenuOptions(workspaceId, botId));
  const [draft, setDraft] = useState<DraftConfig>(() => fromConfig({}));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState<"dry" | "live" | null>(null);
  const [publishRequest, setPublishRequest] = useState<BotMenuPublishResponse | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  useEffect(() => {
    if (!menuQuery.data || dirty) return;
    setDraft(fromConfig(menuQuery.data.bot_menu));
  }, [menuQuery.data, dirty]);

  useEffect(() => {
    if (!publishRequest || !["pending", "running"].includes(publishRequest.status)) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.getBotMenuPublish(workspaceId, publishRequest.id, botId);
        if (active) setPublishRequest(response);
      } catch (error) {
        if (active) setPublishRequest({ ...publishRequest, status: "failed", error: error instanceof Error ? error.message : t(($) => $.feishu.botMenu.publish_failed) });
      }
    }, 750);
    return () => { active = false; window.clearTimeout(timer); };
  }, [publishRequest, t, workspaceId, botId]);

  useEffect(() => {
    if (!publishRequest || ["pending", "running"].includes(publishRequest.status)) return;
    setPublishing(null);
    if (publishRequest.status === "completed") {
      toast.success(publishRequest.dry_run
        ? t(($) => $.feishu.botMenu.validation_succeeded)
        : t(($) => $.feishu.botMenu.publish_succeeded));
    } else {
      toast.error(publishRequest.error || t(($) => $.feishu.botMenu.publish_failed));
    }
  }, [publishRequest, t]);

  const config = useMemo(() => toConfig(draft), [draft]);

  function change(next: DraftConfig) {
    setDraft(next);
    setDirty(true);
    setPublishRequest(null);
  }

  async function save(): Promise<boolean> {
    if (!canManage || saving) return false;
    setSaving(true);
    try {
      const response = await api.updateBotMenu(workspaceId, config, botId);
      queryClient.setQueryData(workspaceKeys.botMenu(workspaceId, botId), response);
      setDraft(fromConfig(response.bot_menu));
      setDirty(false);
      toast.success(t(($) => $.feishu.botMenu.saved));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.feishu.botMenu.save_failed));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function publish(dryRun: boolean) {
    if (!canManage || publishing) return;
    setPublishing(dryRun ? "dry" : "live");
    if (dirty && !(await save())) { setPublishing(null); return; }
    try {
      setPublishRequest(await api.publishBotMenu(workspaceId, dryRun, botId));
    } catch (error) {
      setPublishing(null);
      toast.error(error instanceof Error ? error.message : t(($) => $.feishu.botMenu.publish_failed));
    }
  }

  if (menuQuery.isPending || access.isPending) {
    return <div className="h-28 animate-pulse rounded border bg-muted/30" />;
  }

  if (menuQuery.isError || access.isError) return <ImLoadError retry={() => { void menuQuery.refetch(); void access.refetch(); }} />;

  return (
    <section>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><h2>{t(($) => $.feishu.botMenu.title)}</h2></CardTitle>
          <CardDescription>{t(($) => $.feishu.botMenu.description)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!canManage && (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {t(($) => $.feishu.botMenu.read_only)}
            </p>
          )}

          <MenuEditor
            title={t(($) => $.feishu.botMenu.default_title)}
            items={draft.default}
            disabled={!canManage || saving || Boolean(publishing)}
            onChange={(items) => change({ ...draft, default: items })}
          />

          {(menuQuery.data?.legacy_target_count ?? 0) > 0 && (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {t(($) => $.feishu.botMenu.legacy_notice)}
            </p>
          )}

          {publishRequest && (
            <div className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              publishRequest.status === "completed" ? "border-emerald-500/40 bg-emerald-500/5" :
                publishRequest.status === "failed" || publishRequest.status === "timeout" ? "border-destructive/40 bg-destructive/5" : "bg-muted/30",
            )}>
              {publishStatusText(publishRequest, t)}
              {Boolean(publishRequest.result?.unresolvedLegacyTargetCount) && <p className="mt-2">
                {t(($) => $.feishu.botMenu.legacy_unresolved, { count: publishRequest.result!.unresolvedLegacyTargetCount })}
              </p>}
            </div>
          )}
        </CardContent>
        {canManage && (
          <CardFooter className="flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={saving || Boolean(publishing)} onClick={() => void save()}>
              {saving ? t(($) => $.feishu.botMenu.saving) : t(($) => $.feishu.botMenu.save)}
            </Button>
            <Button variant="outline" size="sm" disabled={saving || Boolean(publishing)} onClick={() => void publish(true)}>
              <CheckCircle2 className="size-4" />
              {publishing === "dry" ? t(($) => $.feishu.botMenu.validating) : t(($) => $.feishu.botMenu.validate)}
            </Button>
            <Button size="sm" disabled={saving || Boolean(publishing)} onClick={() => setConfirmLive(true)}>
              <Send className="size-4" />
              {publishing === "live" ? t(($) => $.feishu.botMenu.publishing) : t(($) => $.feishu.botMenu.publish)}
            </Button>
          </CardFooter>
        )}
      </Card>

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.feishu.botMenu.confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.feishu.botMenu.confirm_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.feishu.botMenu.cancel)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void publish(false)}>{t(($) => $.feishu.botMenu.confirm_publish)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MenuEditor({ title, items, disabled, onChange, depth = 0 }: {
  title: string;
  items: DraftItem[];
  disabled: boolean;
  onChange: (items: DraftItem[]) => void;
  depth?: 0 | 1;
}) {
  const { t } = useT("im-platforms");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function dragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = items.findIndex((item) => item._id === event.active.id);
    const to = items.findIndex((item) => item._id === event.over!.id);
    if (from >= 0 && to >= 0) onChange(arrayMove(items, from, to));
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
        {!disabled && (
          <Button variant="ghost" size="sm" onClick={() => onChange([...items, newItem()])}>
            <Plus className="size-4" />
            {t(($) => $.feishu.botMenu.add_item)}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="rounded border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">{t(($) => $.feishu.botMenu.no_items)}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext items={items.map((item) => item._id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {items.map((item, index) => (
                <SortableMenuItem
                  key={item._id}
                  item={item}
                  disabled={disabled}
                  depth={depth}
                  onChange={(next) => onChange(items.map((entry, candidate) => candidate === index ? next : entry))}
                  onDelete={() => onChange(items.filter((_, candidate) => candidate !== index))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SortableMenuItem({ item, disabled, depth, onChange, onDelete }: {
  item: DraftItem;
  disabled: boolean;
  depth: 0 | 1;
  onChange: (item: DraftItem) => void;
  onDelete: () => void;
}) {
  const { t } = useT("im-platforms");
  const [expanded, setExpanded] = useState(false);
  const sortable = useSortable({ id: item._id, disabled });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const behavior = item.behaviors?.[0] ?? { type: "send_message" as const };
  const hasChildren = Boolean(item.children);
  return (
    <div ref={sortable.setNodeRef} style={style} className={cn("rounded border bg-background", sortable.isDragging && "opacity-60 shadow-sm")}>
      <div className="flex min-h-12 items-center gap-1 p-2">
        <Button variant="ghost" size="icon" className="size-8" aria-expanded={expanded} aria-label={t(($) => $.feishu.botMenu.item_details)} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </Button>
        <button
          type="button"
          className="flex size-8 shrink-0 cursor-grab items-center justify-center text-muted-foreground disabled:cursor-default"
          disabled={disabled}
          aria-label={t(($) => $.feishu.botMenu.drag_item)}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <Input
          className="min-w-0 flex-1"
          disabled={disabled}
          value={item.name}
          placeholder={t(($) => $.feishu.botMenu.item_name)}
          onChange={(event) => onChange({ ...item, name: event.target.value })}
        />
        {!disabled && (
          <Button variant="ghost" size="icon" title={t(($) => $.feishu.botMenu.delete_item)} onClick={onDelete}>
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="space-y-3 border-t p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.botMenu.item_tag)}</Label>
              <Input disabled={disabled} value={item.tag ?? ""} onChange={(event) => onChange({ ...item, tag: event.target.value || undefined })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.botMenu.item_kind)}</Label>
              <Select
                disabled={disabled}
                value={hasChildren ? "submenu" : behavior.type}
                onValueChange={(value) => {
                  if (!value) return;
                  if (value === "submenu") onChange({ ...item, behaviors: undefined, children: item.children ?? [] });
                  else onChange({ ...item, children: undefined, behaviors: [{ type: value as BotMenuBehavior["type"] }] });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="send_message">{t(($) => $.feishu.botMenu.kind_message)}</SelectItem>
                  <SelectItem value="target">{t(($) => $.feishu.botMenu.kind_link)}</SelectItem>
                  <SelectItem value="event_key">{t(($) => $.feishu.botMenu.kind_event)}</SelectItem>
                  {depth === 0 && <SelectItem value="submenu">{t(($) => $.feishu.botMenu.kind_submenu)}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!hasChildren && behavior.type === "target" && (
            <Input disabled={disabled} value={behavior.url ?? ""} placeholder="https://" onChange={(event) => onChange({ ...item, behaviors: [{ ...behavior, url: event.target.value }] })} />
          )}
          {!hasChildren && behavior.type === "event_key" && (
            <Input disabled={disabled} value={behavior.eventKey ?? ""} placeholder="event_key" onChange={(event) => onChange({ ...item, behaviors: [{ ...behavior, eventKey: event.target.value }] })} />
          )}
          {hasChildren && (
            <MenuEditor
              title={t(($) => $.feishu.botMenu.children)}
              items={item.children ?? []}
              disabled={disabled}
              depth={1}
              onChange={(children) => onChange({ ...item, children })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function newItem(): DraftItem {
  return { _id: nextId("menu"), name: "", behaviors: [{ type: "send_message" }] };
}

function fromConfig(config: BotMenuConfig): DraftConfig {
  const inflate = (items: BotMenuItem[] = []): DraftItem[] => items.map(({ children, ...item }) => ({
    ...item,
    _id: nextId("menu"),
    ...(children ? { children: inflate(children) } : {}),
  }));
  return {
    default: inflate(config.default),
  };
}

function toConfig(draft: DraftConfig): BotMenuConfig {
  const strip = (items: DraftItem[]): BotMenuItem[] => items.map(({ _id: _unused, children, ...item }) => ({
    ...item,
    ...(children ? { children: strip(children) } : {}),
  }));
  return {
    default: strip(draft.default),
  };
}

function publishStatusText(
  request: BotMenuPublishResponse,
  t: ReturnType<typeof useT<"im-platforms">>["t"],
): string {
  if (request.status === "pending" || request.status === "running") return t(($) => $.feishu.botMenu.publish_waiting);
  if (request.status !== "completed") return request.error || t(($) => $.feishu.botMenu.publish_failed);
  return request.dry_run
    ? t(($) => $.feishu.botMenu.validation_summary)
    : t(($) => $.feishu.botMenu.publish_summary);
}
