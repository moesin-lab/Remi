/** Parse copied connection snippets as text. Never execute shell commands or expand variables. */
export function importEndpointSnippet(text: string): {
  base_url: string; protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages" | "google-generative";
  api_key?: string; model?: string; auth_header?: "bearer" | "x-api-key";
} {
  if (text.length > 32000) throw new Error("Connection snippet is too large");
  const tokens = [...text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  const env = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s\n]+))/g)) env.set(match[1]!, match[2] ?? match[3] ?? match[4]!);
  let address = env.get("ANTHROPIC_BASE_URL") ?? env.get("OPENAI_BASE_URL") ?? env.get("GOOGLE_GEMINI_BASE_URL") ?? tokens.find(token => /^https?:\/\//.test(token));
  if (!address) throw new Error("No HTTP(S) endpoint URL found");
  const url = new URL(address);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid endpoint URL");
  const protocol = env.has("ANTHROPIC_BASE_URL") || /\/messages\/?$/.test(url.pathname) ? "anthropic-messages"
    : env.has("GOOGLE_GEMINI_BASE_URL") || /generateContent|\/v1beta/.test(url.pathname) ? "google-generative"
    : /\/chat\/completions\/?$/.test(url.pathname) ? "openai-chat-completions" : "openai-responses";
  let authHeader: "bearer" | "x-api-key" = env.has("ANTHROPIC_API_KEY") && !env.has("ANTHROPIC_AUTH_TOKEN") ? "x-api-key" : "bearer";
  let key = env.get("ANTHROPIC_API_KEY") ?? env.get("ANTHROPIC_AUTH_TOKEN") ?? env.get("OPENAI_API_KEY") ?? env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY") ?? url.searchParams.get("key") ?? undefined;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (!["-H", "--header"].includes(tokens[index]!)) continue;
    const header = tokens[index + 1]!.match(/^(Authorization|x-api-key|x-goog-api-key)\s*:\s*(?:Bearer\s+)?(.+)$/i);
    if (header) { key = header[2]!.trim(); authHeader = header[1]!.toLowerCase() === "x-api-key" ? "x-api-key" : "bearer"; }
  }
  // A pasted variable reference is not a credential.
  if (key && /\$|`|\r|\n/.test(key)) key = undefined;
  let model: string | undefined;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (!["-d", "--data", "--data-raw", "--data-binary"].includes(tokens[index]!)) continue;
    try { const body = JSON.parse(tokens[index + 1]!); if (typeof body.model === "string") model = body.model; } catch { /* Non-JSON request bodies do not supply model metadata. */ }
  }
  url.search = ""; url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)$/, "");
  if (protocol === "anthropic-messages") url.pathname = url.pathname.replace(/\/v1$/, "");
  if (protocol === "google-generative") url.pathname = url.pathname.replace(/\/v1(?:beta)?$/, "");
  return { base_url: url.toString().replace(/\/$/, ""), protocol, ...(key ? { api_key: key } : {}), ...(protocol === "anthropic-messages" ? { auth_header: authHeader } : {}), ...(model ? { model } : {}) };
}
