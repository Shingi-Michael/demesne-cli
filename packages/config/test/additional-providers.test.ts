import { expect, test } from "bun:test";
import { assertProviderUrl, validateConfigDocument, parseConfigDocument } from "../src/index.ts";
import { OpenAICompatibleProvider } from "../../providers/src/index.ts";

const endpoint = "http://100.115.125.89:8081/v1";
test("additional provider accepts an explicit exact Tailscale endpoint", () => {
  expect(() => validateConfigDocument(parseConfigDocument(`
[additional_providers.home-qwen]
url = "${endpoint}"
allow_http_endpoint = "${endpoint}"
model = "qwen3.8-27b"
context_window = 262144
max_output_tokens = 1536
`))).not.toThrow();
  expect(() => new OpenAICompatibleProvider({ baseUrl: endpoint, allowHttpEndpoint: endpoint })).not.toThrow();
});

test("HTTP exceptions are exact and restricted to the tailnet address range", () => {
  for (const url of [endpoint, "http://100.115.125.90:8081/v1", "http://100.115.125.89:8082/v1", "http://192.168.1.1/v1", "http://example.com/v1"]) {
    expect(() => assertProviderUrl(url)).toThrow();
    expect(() => new OpenAICompatibleProvider({ baseUrl: url })).toThrow();
    if (url !== endpoint) {
      expect(() => assertProviderUrl(url, "provider.url", endpoint)).toThrow();
      expect(() => new OpenAICompatibleProvider({ baseUrl: url, allowHttpEndpoint: endpoint })).toThrow();
    }
  }
  expect(() => assertProviderUrl("http://example.com/v1", "provider.url", "http://example.com/v1")).toThrow();
  expect(() => validateConfigDocument({ additional_providers: { pc: { model: "qwen" } } })).toThrow("requires");
});
