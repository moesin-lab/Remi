import type {
  BotMenuAudienceTarget,
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuIcon,
  BotMenuItemConfig,
  BotMenuUserConfig,
  BotMenuUserIdType,
  MultiremiUser,
  MultiremiWorkspaceMember,
  ResolvedBotMenuConfig,
} from "@multiremi/contracts/types.js";

const USER_ID_TYPES = new Set<BotMenuUserIdType>(["open_id", "union_id", "user_id"]);
const ROLES = new Set(["owner", "admin", "member"] as const);
const BEHAVIOR_TYPES = new Set<BotMenuBehavior["type"]>(["target", "event_key", "send_message"]);

export class BotMenuConfigError extends Error {
  readonly code = "bot_menu_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "BotMenuConfigError";
  }
}

export function parseBotMenuConfig(value: unknown): BotMenuConfig {
  if (!isRecord(value)) throw new BotMenuConfigError("botMenu must be an object");
  const config: BotMenuConfig = {};
  if (value.default !== undefined) config.default = parseItems(value.default, "default", 0);
  if (value.users !== undefined) {
    if (!Array.isArray(value.users)) throw new BotMenuConfigError("botMenu.users must be an array");
    config.users = value.users.map((entry, index) => parseAudience(entry, index));
  }
  return config;
}

/** The original workspace menu belongs only to the default bot. */
export function readWorkspaceBotMenu(settings: Record<string, unknown>, botId = "default"): BotMenuConfig {
  const menus = isRecord(settings.feishuBotMenus) ? settings.feishuBotMenus : {};
  const value = botId === "default" ? settings.botMenu
    : Object.hasOwn(menus, botId) ? menus[botId] : undefined;
  return value === undefined ? {} : parseBotMenuConfig(value);
}

export function parseUnifiedBotMenuConfig(value: unknown): BotMenuConfig {
  const config = parseBotMenuConfig(value);
  if (config.users?.length) {
    throw new BotMenuConfigError("personalized menus are retired; configure one menu per bot");
  }
  return { default: config.default ?? [] };
}

export function botMenuView(settings: Record<string, unknown>, botId = "default") {
  const config = readWorkspaceBotMenu(settings, botId);
  return {
    bot_menu: { default: config.default ?? [] },
    legacy_target_count: config.users?.length ?? 0,
  };
}

export function writeWorkspaceBotMenu(
  settings: Record<string, unknown>, botId: string, menu: BotMenuConfig,
): Record<string, unknown> {
  // Keep retired targets as a cleanup record. They are never published as menus.
  const previous = readWorkspaceBotMenu(settings, botId);
  const next = { ...menu, ...(previous.users?.length ? { users: previous.users } : {}) };
  if (botId === "default") return { ...settings, botMenu: next };
  const menus = isRecord(settings.feishuBotMenus) ? settings.feishuBotMenus : {};
  return { ...settings, feishuBotMenus: { ...menus, [botId]: next } };
}

/** Resolve historical identities only to remove their old personalized menus.
 * Missing/deleted members never block the bot's shared menu. */
export function resolveBotMenuConfig(
  config: BotMenuConfig,
  workspaceId: string,
  members: readonly MultiremiWorkspaceMember[],
  getUser: (userId: string) => MultiremiUser | null,
): ResolvedBotMenuConfig {
  const targets = new Map<string, { userId: string; userIdType: BotMenuUserIdType }>();
  let unresolved = 0;
  const add = (userId: string, userIdType: BotMenuUserIdType) => {
    targets.set(`${userIdType}:${userId}`, { userId, userIdType });
  };
  for (const audience of config.users ?? []) {
    const target = audience.target;
    if (target.type === "external") {
      add(target.userId, target.userIdType);
      continue;
    }
    // A former role recipient may now have a different role or be archived.
    // Every known workspace identity should receive the same bot menu now.
    const matching = members.filter(member => member.workspaceId === workspaceId
      && (target.type === "role" || member.id === target.memberId));
    if (!matching.length) unresolved += 1;
    for (const member of matching) {
      const externalId = member.userId ? cleanString(getUser(member.userId)?.externalId) : null;
      if (externalId) add(externalId, "open_id");
      else unresolved += 1;
    }
  }
  return {
    default: config.default ?? [],
    ...(targets.size ? { clearUsers: [...targets.values()] } : {}),
    ...(unresolved ? { unresolvedLegacyTargetCount: unresolved } : {}),
  };
}

function parseAudience(value: unknown, index: number): BotMenuUserConfig {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.users[${index}] must be an object`);
  return {
    target: parseTarget(value.target, index),
    ...(cleanString(value.label) ? { label: cleanString(value.label)! } : {}),
    items: parseItems(value.items, `users[${index}].items`, 0),
  };
}

function parseTarget(value: unknown, index: number): BotMenuAudienceTarget {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.users[${index}].target must be an object`);
  if (value.type === "member") {
    const memberId = cleanString(value.memberId);
    if (!memberId) throw new BotMenuConfigError(`botMenu.users[${index}].target.memberId is required`);
    return { type: "member", memberId };
  }
  if (value.type === "role") {
    if (!ROLES.has(value.role as "owner" | "admin" | "member")) {
      throw new BotMenuConfigError(`botMenu.users[${index}].target.role is invalid`);
    }
    return { type: "role", role: value.role as "owner" | "admin" | "member" };
  }
  if (value.type === "external") {
    const userId = cleanString(value.userId);
    if (!userId) throw new BotMenuConfigError(`botMenu.users[${index}].target.userId is required`);
    if (!USER_ID_TYPES.has(value.userIdType as BotMenuUserIdType)) {
      throw new BotMenuConfigError(`botMenu.users[${index}].target.userIdType is invalid`);
    }
    return { type: "external", userId, userIdType: value.userIdType as BotMenuUserIdType };
  }
  throw new BotMenuConfigError(`botMenu.users[${index}].target.type is invalid`);
}

function parseItems(value: unknown, path: string, depth: number): BotMenuItemConfig[] {
  if (!Array.isArray(value)) throw new BotMenuConfigError(`botMenu.${path} must be an array`);
  if (depth > 1) throw new BotMenuConfigError(`botMenu.${path} exceeds two menu levels`);
  return value.map((entry, index) => parseItem(entry, `${path}[${index}]`, depth));
}

function parseItem(value: unknown, path: string, depth: number): BotMenuItemConfig {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.${path} must be an object`);
  const name = cleanString(value.name);
  if (!name) throw new BotMenuConfigError(`botMenu.${path}.name is required`);
  const children = value.children === undefined ? undefined : parseItems(value.children, `${path}.children`, depth + 1);
  const behaviors = value.behaviors === undefined ? undefined : parseBehaviors(value.behaviors, path);
  const i18nName = parseStringMap(value.i18nName);
  const icon = parseIcon(value.icon, path);
  const tag = cleanString(value.tag);
  if (children?.length && behaviors?.length) {
    throw new BotMenuConfigError(`botMenu.${path} cannot define both children and behaviors`);
  }
  return {
    name,
    ...(i18nName ? { i18nName } : {}),
    ...(icon ? { icon } : {}),
    ...(tag ? { tag } : {}),
    ...(behaviors ? { behaviors } : {}),
    ...(children ? { children } : {}),
  };
}

function parseBehaviors(value: unknown, path: string): BotMenuBehavior[] {
  if (!Array.isArray(value)) throw new BotMenuConfigError(`botMenu.${path}.behaviors must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || !BEHAVIOR_TYPES.has(entry.type as BotMenuBehavior["type"])) {
      throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].type is invalid`);
    }
    const type = entry.type as BotMenuBehavior["type"];
    const url = cleanString(entry.url);
    const eventKey = cleanString(entry.eventKey);
    if (type === "target" && !url) throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].url is required`);
    if (type === "event_key" && !eventKey) throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].eventKey is required`);
    return {
      type,
      ...(url ? { url } : {}),
      ...(eventKey ? { eventKey } : {}),
      ...(typeof entry.isPrimary === "boolean" ? { isPrimary: entry.isPrimary } : {}),
    };
  });
}

function parseIcon(value: unknown, path: string): BotMenuIcon | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.${path}.icon must be an object`);
  const token = cleanString(value.token);
  const color = cleanString(value.color);
  const fileKey = cleanString(value.fileKey);
  return token || color || fileKey ? {
    ...(token ? { token } : {}),
    ...(color ? { color } : {}),
    ...(fileKey ? { fileKey } : {}),
  } : undefined;
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new BotMenuConfigError("bot menu i18nName must be an object");
  const entries = Object.entries(value)
    .map(([key, entry]) => [key.trim(), cleanString(entry)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
