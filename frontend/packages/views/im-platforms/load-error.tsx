import { Button } from "@multiremi/ui/components/ui/button";
import { useT } from "../i18n";

export function ImLoadError({ retry }: { retry?: () => void }) {
  const { t } = useT("im-platforms");
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 p-4 text-sm">
    <p className="text-destructive">{t($ => $.page.loadError)}</p>
    {retry && <Button variant="outline" size="sm" onClick={retry}>{t($ => $.page.retry)}</Button>}
  </div>;
}
