import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolveQoderIdentity: vi.fn(),
}));

vi.mock("../cosy.js", () => ({
  buildAuthHeaders: () => ({}),
  formatQoderHttpError: (_scope: string, status: number, statusText: string) => `${status} ${statusText}`,
  getMachineId: () => "machine-id",
  getQoderChatURL: () => "https://qoder.example.test/chat",
  getQoderCNDirectModel: (id: string) => id,
  getQoderMode: () => "cn",
  getQoderUserEmailFallback: () => "user@example.test",
  isQoderCNMode: (mode: string) => mode === "cn",
  logCosyRequest: vi.fn(),
  logCosyResponse: vi.fn(),
}));

vi.mock("../models.js", () => ({
  getCachedModelConfig: () => undefined,
  withQoderThinkingEffort: (config: unknown) => config,
}));

vi.mock("../oauth.js", () => ({
  resolveQoderIdentity: mocks.resolveQoderIdentity,
}));

vi.mock("../qoder-encoding.js", () => ({
  qoderEncodeBody: (body: Buffer) => body.toString("utf8"),
}));

vi.mock("../transform.js", () => ({
  transformMessagesForQoder: (messages: unknown) => messages,
  transformTools: (tools: unknown) => tools,
}));

import { streamQoder } from "../stream.js";

const model = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "qoder-api",
  provider: "qoder-cn",
  baseUrl: "https://qoder.example.test/",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 32_768,
} as unknown as Model<Api>;

const context = {
  systemPrompt: "",
  messages: [{ role: "user", content: "ping" }],
} as unknown as Context;

const options = {
  apiKey: "access-token",
  reasoning: false,
} as unknown as SimpleStreamOptions;

function responseWithSse(...data: string[]): Response {
  return new Response(data.map((value) => `data: ${value}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function envelope(body: unknown, statusCodeValue = 200): string {
  return JSON.stringify({ statusCodeValue, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("streamQoder SSE failures", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.resolveQoderIdentity.mockReset().mockResolvedValue({
      userID: "user-id",
      name: "User",
      email: "user@example.test",
      machineID: "machine-id",
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("surfaces an upstream error envelope instead of returning an empty stop", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope("rate limited", 429)));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Upstream status 429: rate limited");
    expect(result.content).toEqual([]);
  });

  it("surfaces malformed envelope JSON instead of returning an empty stop", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse("{not-json"));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Qoder SSE envelope is not valid JSON");
  });

  it("surfaces malformed inner JSON instead of returning an empty stop", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope("{not-json")));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Qoder SSE response body is not valid JSON");
  });

  it("rejects a successful stream that contains no assistant content", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse("[DONE]"));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Qoder upstream completed without assistant content");
  });

  it("still returns valid assistant text", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(envelope({ choices: [{ delta: { content: "pong" }, finish_reason: "stop" }] }), "[DONE]"),
    );

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
  });
});
