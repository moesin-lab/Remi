/**
 * Assistant slash-command policy facade, shared with the legacy Feishu entry (MUL-21).
 *
 * Pure command parsing primitives live in `@shared/feishu-commands.js` so
 * `@connectors` durable history intake and live Assistant routing share a single
 * source of truth without creating a reverse dependency into `@multiremi/*`.
 */
export {
  FEISHU_COMMANDS,
  availableCommandList,
  isUnknownFeishuCommand,
  resolveFeishuCommand,
  unknownCommandMessage,
  type FeishuCommand,
} from "@shared/feishu-commands.js";
