export function v1BaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function chatCompletionsUrl(baseUrl: string, exactBase: boolean): string {
  const base = exactBase ? baseUrl.replace(/\/+$/, "") : v1BaseUrl(baseUrl);
  return `${base}/chat/completions`;
}
