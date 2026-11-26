import { expect, spyOn } from 'bun:test';
import type { MultiremiStore } from '@multiremi/store.js';
import { DEFAULT_SYSTEM_PROMPT_CONTENT } from '@multiremi/contracts/system-prompt-policy.js';
import { CURRENT_SYSTEM_PROMPT_DEFAULT, hashSystemPromptContent, LEGACY_BASELINE_DEFAULT_REVISION } from '@shared/system-prompt-policy-hash.js';

export function useHistoricalCatalog(store: MultiremiStore) {
  const current = DEFAULT_SYSTEM_PROMPT_CONTENT;
  const content = { ...current, code_delivery: current.code_delivery.replace('Give the PR/MR a title describing the change without an Issue Key prefix.', 'Include the issue key in the PR/MR title or description so Multiremi can associate it automatically.') };
  const revision = hashSystemPromptContent(content);
  expect(revision).toBe(LEGACY_BASELINE_DEFAULT_REVISION);
  return spyOn(store.systemPromptsRepo() as unknown as { catalog(): typeof CURRENT_SYSTEM_PROMPT_DEFAULT }, 'catalog').mockReturnValue({ content, revision, contentHash: revision });
}
