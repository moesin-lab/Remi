#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const home = args[args.indexOf('--gemini-dir') + 1];
if (args[0] !== 'acp' || home !== process.env.GEMINI_HOME || process.env.AGY_LLM_GATEWAY_URL
  || readFileSync(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8') !== 'fake-native-login') process.exit(2);
let model = 'native-model';
let effort = 'medium';
const configs = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'native-model', name: 'Native' }, { value: 'other-model', name: 'Other' }] },
  { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: effort, options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
];
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'native-fake', version: '1.5.9' }, agentCapabilities: { loadSession: true }, authMethods: [] };
  else if (['session/new', 'session/load', 'session/resume'].includes(r.method)) result = { sessionId: 'native-session', configOptions: configs(), modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }] } };
  else if (r.method === 'session/set_config_option') {
    if (r.params.configId === 'model') model = r.params.value;
    else effort = r.params.value;
    result = { configOptions: configs() };
  } else if (r.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${model}:${effort}:native-ok` } } } });
    result = { stopReason: 'end_turn' };
  }
  if (r.id !== undefined) send({ jsonrpc: '2.0', id: r.id, result });
}
