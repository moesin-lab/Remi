import { createHash } from 'node:crypto';
import type { FeishuCommandSemantic } from '@multiremi/contracts/types.js';
import { isUnknownFeishuCommand, resolveFeishuCommand } from './feishu-commands.js';

export function describeFeishuCommand(input: Omit<FeishuCommandSemantic, 'kind' | 'name' | 'args' | 'target'>): FeishuCommandSemantic {
  const command = resolveFeishuCommand(input.raw_content);
  const unknown = isUnknownFeishuCommand(input.raw_content);
  return { ...input, kind: command ? 'command' : unknown ? 'unknown' : 'message',
    name: command?.name ?? (unknown ? input.raw_content.trim().slice(1).toLowerCase() : ''),
    args: command?.args ?? '', target: command?.name === 'stop' && command.args ? command.args : null };
}

export function feishuCommandDigest(value: FeishuCommandSemantic): string {
  const fields = [1, value.domain, value.app_id, value.external_message_id, value.sender_open_id,
    value.chat_id, value.external_session_key, value.kind, value.name, value.args, value.target, value.raw_content];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
