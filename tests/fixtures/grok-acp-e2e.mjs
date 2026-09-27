#!/usr/bin/env node

/** Deterministic native-Grok ACP stand-in for the provider-neutral E2E harness. */
import readline from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = readline.createInterface({ input: process.stdin });

input.on("line", line => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const reply = result => send({ jsonrpc: "2.0", id: message.id, result });

  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        authMethods: [{ id: "cached_token", name: "Cached login" }],
        _meta: { defaultAuthMethodId: "cached_token" },
        agentCapabilities: { loadSession: true },
      });
      break;
    case "authenticate":
      reply({});
      break;
    case "session/new":
      reply({
        sessionId: "fake-grok-e2e-session",
        models: {
          currentModelId: "grok-e2e",
          availableModels: [{ modelId: "grok-e2e", name: "Fake Grok E2E" }],
        },
      });
      break;
    case "session/load":
      reply({ sessionId: message.params.sessionId });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "__E2E_OK__" }],
          },
        },
      });
      reply({
        stopReason: "end_turn",
        _meta: {
          modelId: "grok-e2e",
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsdTicks: 100 },
        },
      });
      break;
    case "session/cancel":
    case "session/close":
      reply({});
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported fake Grok method: ${message.method}` },
      });
  }
});
