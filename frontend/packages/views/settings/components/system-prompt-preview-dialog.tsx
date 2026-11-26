"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Eye, Info, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import type { SystemPromptSlots } from "@multiremi/core/types";
import { Alert, AlertDescription, AlertTitle } from "@multiremi/ui/components/ui/alert";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { useCopyFeedback } from "@multiremi/ui/hooks/use-copy-feedback";
import { useT } from "../../i18n";
import { SYSTEM_PROMPT_SLOT_KEYS } from "../lib/system-prompt-utils";

type PreviewBlock = "instructions" | "input";

export interface SystemPromptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  draftContent: SystemPromptSlots;
  isDirty: boolean;
}

export function SystemPromptPreviewDialog({
  open,
  onOpenChange,
  workspaceId,
  draftContent,
  isDirty,
}: SystemPromptPreviewDialogProps) {
  const { t } = useT("settings");
  const [lastCopiedBlock, setLastCopiedBlock] = useState<PreviewBlock | null>(null);
  const [copied, markCopied] = useCopyFeedback(1_500);
  const copiedBlock = copied ? lastCopiedBlock : null;

  const contentSignature = JSON.stringify(draftContent);
  const preview = useQuery({
    queryKey: ["workspaces", workspaceId, "system-prompt", "preview", contentSignature],
    queryFn: () => api.previewWorkspaceSystemPrompt(workspaceId, { content: draftContent }),
    enabled: open && Boolean(workspaceId),
    staleTime: 0,
  });

  async function copyBlock(block: PreviewBlock) {
    const text = preview.data?.[block];
    if (!text) return;
    if (await copyText(text)) {
      setLastCopiedBlock(block);
      markCopied();
    } else {
      toast.error(t(($) => $.prompts.copy_failed));
    }
  }

  const blocks: { block: PreviewBlock; title: string; hint: string; label: string }[] = [
    {
      block: "instructions",
      title: t(($) => $.prompts.template_instructions_title),
      hint: t(($) => $.prompts.template_instructions_hint),
      label: t(($) => $.prompts.template_instructions_label),
    },
    {
      block: "input",
      title: t(($) => $.prompts.template_input_title),
      hint: t(($) => $.prompts.template_input_hint),
      label: t(($) => $.prompts.template_input_label),
    },
  ];

  const unavailable = preview.isError || (!preview.isPending && !preview.data?.instructions);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(85vh,52rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4 text-muted-foreground" />
            {t(($) => $.prompts.preview.title)}
          </DialogTitle>
          <DialogDescription>
            {t(($) => $.prompts.preview.description)}
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <div className="flex min-h-0 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : unavailable || !preview.data ? (
          <div className="flex min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{t(($) => $.prompts.template_load_failed)}</p>
            <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
              {t(($) => $.prompts.retry)}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
            <Alert>
              <Info className="size-4" />
              <AlertTitle>{t(($) => $.prompts.preview.synthetic_title)}</AlertTitle>
              <AlertDescription className="space-y-1 text-xs">
                <p>{t(($) => $.prompts.preview.synthetic_note, { scenario: preview.data.scenario })}</p>
                {isDirty && (
                  <p className="font-medium text-foreground">
                    {t(($) => $.prompts.preview.includes_unsaved_draft)}
                  </p>
                )}
              </AlertDescription>
            </Alert>

            <div className="grid gap-3 md:grid-cols-2">
              <section className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{t(($) => $.prompts.preview.editable_badge)}</Badge>
                  <h3 className="text-xs font-medium">{t(($) => $.prompts.preview.editable_slots_title)}</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.prompts.preview.editable_slots_hint)}
                </p>
                <ul className="space-y-1.5 text-xs">
                  {SYSTEM_PROMPT_SLOT_KEYS.map((slot) => {
                    const value = preview.data.content[slot];
                    const hasText = value.trim().length > 0;
                    return (
                      <li key={slot} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1">
                        <span className="truncate font-medium">{t(($) => $.prompts.slots[slot].label)}</span>
                        <Badge variant={hasText ? "outline" : "secondary"} className="shrink-0 text-[11px]">
                          {hasText
                            ? t(($) => $.prompts.preview.slot_active)
                            : t(($) => $.prompts.preview.slot_empty)}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-3.5 text-muted-foreground" />
                  <Badge variant="outline">{t(($) => $.prompts.preview.protected_badge)}</Badge>
                  <h3 className="text-xs font-medium">{t(($) => $.prompts.preview.protected_blocks_title)}</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.prompts.preview.protected_blocks_hint)}
                </p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>{t(($) => $.prompts.preview.protected_item_identity)}</li>
                  <li>{t(($) => $.prompts.preview.protected_item_auth)}</li>
                  <li>{t(($) => $.prompts.preview.protected_item_attachments)}</li>
                  <li>{t(($) => $.prompts.preview.protected_item_dynamic)}</li>
                </ul>
              </section>
            </div>

            {blocks.map(({ block, title, hint, label }) => (
              <section key={block} className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
                    {preview.data.sha256[block] && (
                      <p
                        className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80"
                        title={preview.data.sha256[block]}
                      >
                        {t(($) => $.prompts.template_sha256, { hash: preview.data.sha256[block] })}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void copyBlock(block)}
                  >
                    {copiedBlock === block ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copiedBlock === block ? t(($) => $.prompts.copied) : t(($) => $.prompts.copy)}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-md border bg-muted/30">
                  <pre
                    aria-label={label}
                    className="min-w-max p-4 font-mono text-xs leading-relaxed whitespace-pre"
                  >
                    {preview.data[block]}
                  </pre>
                </div>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
