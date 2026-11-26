export function foldFeishuWakeWord(value: string): string {
  return value.replace(/[A-Z]/g, character => character.toLowerCase());
}

export function normalizeFeishuWakeWords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("wake_words must be an array of at most 32 strings");
  const words = new Map<string, string>();
  for (const entry of value) {
    const word = typeof entry === "string" ? entry.trim() : "";
    if (!word || [...word].length > 64 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(word)) {
      throw new Error("Each wake_words entry must contain 1–64 code points without internal controls or line breaks");
    }
    const folded = foldFeishuWakeWord(word);
    if (!words.has(folded)) words.set(folded, word);
  }
  return [...words.values()];
}
