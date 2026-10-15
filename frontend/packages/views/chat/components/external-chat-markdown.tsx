"use client";

import { MemoizedMarkdown } from "@multiremi/ui/markdown";
import { ImageOff } from "lucide-react";
import { useT } from "../../i18n";

function ExternalChatImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useT("chat");

  // Native paths belong to the source machine, not the Remi web origin.
  if (!/^https?:\/\//i.test(src)) {
    return <span className="my-2 flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block">{alt || t(($) => $.external.local_image)}</span>
        <span className="block">{t(($) => $.external.local_image_hint)}</span>
        {src && <code className="block break-all">{src}</code>}
      </span>
    </span>;
  }

  return <img src={src} alt={alt} className="my-2 h-auto max-w-full rounded-md" loading="lazy" />;
}

const renderImage = (props: { src: string; alt: string }) => <ExternalChatImage {...props} />;

export function ExternalChatMarkdown({ children }: { children: string }) {
  return <MemoizedMarkdown renderImage={renderImage}>{children}</MemoizedMarkdown>;
}
