"use client";

import { useState } from "react";
import type { ExternalChatRequest } from "@multiremi/core/chat";
import { Button } from "@multiremi/ui/components/ui/button";
import { Markdown } from "@multiremi/ui/markdown";
import { useT } from "../../i18n";

export function ExternalChatRequestCard({ request, disabled, onRespond }: {
  request: ExternalChatRequest;
  disabled: boolean;
  onRespond: (input: { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> }) => void;
}) {
  const { t } = useT("chat");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const approval = ["command_approval", "file_approval", "permissions_approval"].includes(request.kind);
  const questions = request.questions ?? [];

  return (
    <section className="space-y-2 rounded-md border bg-card p-3">
      <p className="text-xs font-medium">{approval ? t(($) => $.human_requests.permission_title) : request.kind === "user_input" ? t(($) => $.human_requests.question_title) : request.kind}</p>
      <Markdown mode="minimal">{request.text}</Markdown>
      {approval ? (
        <div className="flex flex-wrap gap-2">
          {(["accept", "decline", "cancel"] as const).map(decision => (
            <Button type="button" variant="outline" disabled={disabled} key={decision} onClick={() => onRespond({ decision })}>
              {t(($) => $.external[decision])}
            </Button>
          ))}
        </div>
      ) : request.kind === "user_input" && questions.length > 0 ? (
        <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          if (disabled || questions.some(question => !answers[question.id]?.trim())) return;
          onRespond({ answers: Object.fromEntries(questions.map(question => [question.id, [answers[question.id]!]])) });
        }}>
          {questions.map(question => (
            <fieldset key={question.id} disabled={disabled} className="space-y-2">
              <legend className="text-sm font-medium">{question.header}</legend>
              <p className="text-sm">{question.question}</p>
              {question.options?.map(option => (
                <label className="flex items-start gap-2 text-sm" key={option.label}>
                  <input type="radio" name={`${request.id}:${question.id}`} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} />
                  <span>{option.label}<span className="block text-xs text-muted-foreground">{option.description}</span></span>
                </label>
              ))}
              <input aria-label={question.question} type={question.is_secret ? "password" : "text"} autoComplete="off"
                placeholder={t(($) => $.external.answer)} value={answers[question.id] ?? ""}
                className="w-full rounded-md border bg-background p-2 text-sm"
                onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />
            </fieldset>
          ))}
          <Button type="submit" disabled={disabled || questions.some(question => !answers[question.id]?.trim())}>{t(($) => $.external.submit_answer)}</Button>
        </form>
      ) : <p role="status" className="text-sm text-muted-foreground">{t(($) => $.external.native_client)}</p>}
    </section>
  );
}
