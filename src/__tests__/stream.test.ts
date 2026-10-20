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
  resolveRequestedThinkingEffort: (reasoning: unknown) =>
    typeof reasoning === "string" && reasoning !== "off" && reasoning.length > 0 ? reasoning : undefined,
  qoderSupportsThinkingEffort: () => false,
  withQoderThinkingEffort: (config: unknown) => config,
}));

vi.mock("../oauth.js", () => ({
  resolveQoderIdentity: mocks.resolveQoderIdentity,
}));

vi.mock("../qoder-encoding.js", () => ({
  qoderEncodeBody: (body: Buffer) => body.toString("utf8"),
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

describe("streamQoder SSE handling", () => {
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

  function mockTextResponse() {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta: { content: "pong" } }] }), "[DONE]"));
  }

  function requestBody() {
    return JSON.parse(mocks.fetch.mock.calls[0][1].body.toString("utf8"));
  }

  const bashTool = {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  };

  it("sends prompt sections and tool declarations from the transcript to Qoder", async () => {
    mockTextResponse();
    const transcript = {
      messages: [
        {
          role: "system",
          content: "You are a coding agent.",
          sections: { tools: "Use bash to execute commands.", rules: "Do not invent output." },
          toolsAdded: [bashTool],
          timestamp: 0,
        },
        { role: "user", content: [{ type: "text", text: "Run pwd" }], timestamp: 1 },
      ],
    } as unknown as Context;

    const result = await streamQoder(model, transcript, options).result();

    expect(result.stopReason).toBe("stop");
    expect(requestBody()).toMatchObject({
      system: "You are a coding agent.\n\nUse bash to execute commands.\n\nDo not invent output.",
      tools: [{ type: "function", function: bashTool }],
      messages: [{ role: "user", content: "Run pwd" }],
    });
  });

  it("replays prompt changes and tool additions, replacements and removals", async () => {
    mockTextResponse();
    const updatedBash = { ...bashTool, description: "Run a read-only command" };
    const readTool = { ...bashTool, name: "read", description: "Read a file" };
    const transcript = {
      messages: [
        {
          role: "system",
          content: "Base prompt",
          sections: { rules: "Old rules", obsolete: "Remove this" },
          toolsAdded: [bashTool, readTool],
          timestamp: 0,
        },
        { role: "user", content: "Run pwd", timestamp: 1 },
        {
          role: "system",
          content: [{ type: "text", text: "Additional instructions" }],
          sections: { rules: "New rules", obsolete: null },
          toolsRemoved: [{ name: "bash" }, { name: "read" }],
          toolsAdded: [updatedBash],
          timestamp: 2,
        },
      ],
    } as unknown as Context;

    await streamQoder(model, transcript, options).result();

    expect(requestBody()).toMatchObject({
      system: "Base prompt\n\nAdditional instructions\n\nNew rules",
      tools: [{ type: "function", function: updatedBash }],
      messages: [{ role: "user", content: "Run pwd" }],
    });
  });

  it("does not resurrect legacy tools after the transcript removes every tool", async () => {
    mockTextResponse();
    const transcript = {
      systemPrompt: "Stale legacy prompt",
      tools: [bashTool],
      messages: [
        { role: "system", content: "Current prompt", toolsAdded: [bashTool], timestamp: 0 },
        { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 1 },
        { role: "user", content: "ping", timestamp: 2 },
      ],
    } as unknown as Context;

    await streamQoder(model, transcript, options).result();

    expect(requestBody().system).toBe("Current prompt");
    expect(requestBody().tools).toEqual([]);
  });

  it("keeps supporting the legacy top-level prompt and tools", async () => {
    mockTextResponse();
    const legacy = { ...context, systemPrompt: "Legacy instructions", tools: [bashTool] } as unknown as Context;

    await streamQoder(model, legacy, options).result();

    expect(requestBody()).toMatchObject({
      system: "Legacy instructions",
      tools: [{ type: "function", function: bashTool }],
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("preserves tool calls and results on the follow-up transcript request", async () => {
    mockTextResponse();
    const transcript = {
      messages: [
        { role: "system", content: "Use bash", toolsAdded: [bashTool], timestamp: 0 },
        { role: "user", content: "Run pwd", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_pwd", name: "bash", arguments: { command: "pwd" } }],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_pwd",
          toolName: "bash",
          content: [{ type: "text", text: "/test/project" }],
          isError: false,
          timestamp: 3,
        },
      ],
    } as unknown as Context;

    await streamQoder(model, transcript, options).result();

    expect(requestBody().tools).toEqual([{ type: "function", function: bashTool }]);
    expect(requestBody().messages).toEqual([
      { role: "user", content: "Run pwd" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_pwd", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
      },
      { role: "tool", tool_call_id: "call_pwd", content: "/test/project" },
    ]);
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

  it("preserves a no-argument tool call whose first delta has empty arguments", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "noop", arguments: "" } }],
              },
            },
          ],
        }),
        "[DONE]",
      ),
    );

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([{ type: "toolCall", id: "call_1", name: "noop", arguments: {} }]);
  });

  it("assembles chunked tool arguments after an empty metadata delta", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "" } }],
              },
            },
          ],
        }),
        envelope({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp/test"}' } }] } }],
        }),
        "[DONE]",
      ),
    );

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "call_1", name: "write_file", arguments: { path: "/tmp/test" } },
    ]);
  });

  it("surfaces malformed tool arguments instead of invoking the tool with an empty object", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":' } }],
              },
            },
          ],
        }),
        "[DONE]",
      ),
    );

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Qoder tool call arguments are not valid JSON (write_file)");
  });
});
