import { describe, expect, it } from "vitest";
import { importEndpointSnippet } from "./endpoint-import";
describe("endpoint snippet import", () => {
  it("reads cURL headers and JSON without executing commands", () => {
    expect(importEndpointSnippet(`curl https://example.invalid/v1/chat/completions -H 'Authorization: Bearer test-key' -d '{"model":"my-model"}'`))
      .toEqual({ base_url: "https://example.invalid/v1", protocol: "openai-chat-completions", api_key: "test-key", model: "my-model" });
  });
  it("normalizes Anthropic environment variables and ignores variable references", () => {
    expect(importEndpointSnippet('export ANTHROPIC_BASE_URL="https://example.invalid/v1/messages"\nexport ANTHROPIC_API_KEY="$KEY"'))
      .toEqual({ base_url: "https://example.invalid", protocol: "anthropic-messages", auth_header: "x-api-key" });
  });
  it("extracts Gemini query credentials into the secret field", () => {
    expect(importEndpointSnippet("curl 'https://example.invalid/v1beta/models/gemini:generateContent?key=test-key'"))
      .toEqual({ base_url: "https://example.invalid", protocol: "google-generative", api_key: "test-key" });
  });
  it("rejects unsafe or absent URLs", () => {
    expect(() => importEndpointSnippet("curl file:///etc/passwd")).toThrow();
    expect(() => importEndpointSnippet("curl https://user:pass@example.invalid")).toThrow();
  });
});
