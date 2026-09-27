---
title: Grok Build 原生 ACP 接入
status: active
summary: 说明 Grok Build 原生 ACP 的启动、无头鉴权、会话恢复、模型配置、用量归一化及验证边界。
---

# Remi ACP Grok via native Grok Build

## Decision

Integrate Grok Build as a third `AgentAdapter` behind Remi's existing
`AcpProvider`. Do not create a Grok-specific Provider: the official CLI already
speaks ACP over stdio.

## Runtime contract

- Launch: `grok --no-auto-update agent [custom args] stdio`.
- Authentication: call `authenticate` after `initialize`; honor Grok's
  headless `defaultAuthMethodId`, otherwise use `xai.api_key` when
  `XAI_API_KEY` is present or `cached_token` from `grok login`. Interactive
  `grok.com` browser authentication is not valid for a daemon.
- Instructions: send the assembled Remi system prompt as `initialize._meta.rules`.
- Permissions: map Remi bypass mode to `session/new._meta.yoloMode=true`;
  Grok's prompt modes are not used as permission modes.
- Restore: use `session/load`, not `session/resume`.
- Model selection: prefer standard `configOptions` and
  `session/set_config_option`; fall back to Grok's `session/set_model` extension
  with optional `_meta.reasoningEffort` for older dialects. Discover
  model-specific effort values from the live session catalog.
- Metering: normalize prompt result `_meta.usage`, `_meta.modelId`, and
  `costUsdTicks` into Remi's provider-neutral response.
- Skills and MCP: materialize task skills under `.grok/skills`; pass configured
  MCP servers through the standard ACP session payload.

## Deliberate limits

- Grok is native ACP, so Remi does not provision or update an external ACP
  bridge for it.
- Grok does not use Remi's Claude/Codex Agent Plugin bundle formats.
- Grok authentication and native history remain in its normal CLI home; Remi
  creates only daemon-owned task context/private-temp state and does not replace
  `GROK_HOME`. Canonical task/session events remain stored by Multiremi.
- A real CLI smoke requires Grok Build installed and authenticated on the
  runtime machine. The deterministic fake-agent contract test remains the CI
  gate when those credentials are unavailable.

## Acceptance

- Grok can be selected in the CLI, API, daemon fleet, and web agent editor.
- Startup, headless authentication, new/load session, model/effort selection,
  streaming text/tool updates, cancellation, and usage settlement preserve the
  shared Provider contract.
- Existing Claude and Codex tests and type checks remain green.
