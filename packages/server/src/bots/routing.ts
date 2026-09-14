import type { Bot, BotRoute, BotTarget, SubmitBotMessageInput } from "@multiremi/contracts/bots.js";
import { BotError } from "./errors.js";

export function resolveBotTarget(target: BotTarget, defaults?: BotTarget): BotTarget {
  if (!target || target.kind !== "agent" || typeof target.agent_id !== "string" || !target.agent_id.trim()) {
    throw new BotError("An Agent target is required", 400, "invalid_target");
  }
  const resolved: BotTarget = { kind: "agent", agent_id: target.agent_id.trim() };
  for (const field of ["runtime_id", "project_id", "runtime_workspace_id"] as const) {
    const value = target[field] === undefined ? defaults?.[field] ?? null : target[field];
    if (value !== null && (typeof value !== "string" || !value.trim())) throw new BotError(`Invalid ${field}`);
    resolved[field] = value === null ? null : value.trim();
  }
  // Choosing one location replaces the inherited location of the other kind.
  if (target.project_id) resolved.runtime_workspace_id = null;
  if (target.runtime_workspace_id) resolved.project_id = null;
  if (target.project_id && target.runtime_workspace_id) throw new BotError("Choose a project or a Runtime workspace");
  return resolved;
}

export function botRouteMatches(route: BotRoute, bindingId: string, input: SubmitBotMessageInput): boolean {
  const match = route.match;
  return (!match.platform_binding_ids?.length || match.platform_binding_ids.includes(bindingId))
    && (!match.chat_types?.length || Boolean(input.chatType && match.chat_types.includes(input.chatType)))
    && (!match.chat_ids?.length || Boolean(input.chatId && match.chat_ids.includes(input.chatId)))
    && (!match.commands?.length || Boolean(input.command && match.commands.includes(input.command)));
}

export function selectBotTarget(bot: Bot, bindingId: string, input: SubmitBotMessageInput): BotTarget {
  const route = bot.routes.find((candidate) => botRouteMatches(candidate, bindingId, input));
  return resolveBotTarget(input.target ?? route?.target ?? bot.default_target, bot.default_target);
}

/** Only the resolved execution configuration participates in conversation identity. */
export function botTargetKey(target: BotTarget): string {
  return JSON.stringify([target.kind, target.agent_id, target.runtime_id ?? null, target.project_id ?? null, target.runtime_workspace_id ?? null]);
}
