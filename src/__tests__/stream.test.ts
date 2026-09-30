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

// Pi 0.99.1's extension loader maps pi-ai to compat. Use that real host API
// while retaining the older development SDK for the legacy Context contract.
vi.mock("@earendil-works/pi-ai", () => import("pi-ai-transcript/compat"));

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

  it("replays transcript prompt sections and tool changes into a leading system message", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta: { content: "pong" } }] }), "[DONE]"));
    const transcript = {
      systemPrompt: "Stale legacy prompt",
      tools: [{ name: "stale", description: "Stale tool", parameters: {} }],
      messages: [
        {
          role: "system",
          content: "Base prompt",
          sections: { rules: "old rules", temporary: "obsolete section" },
          toolsAdded: [{ name: "removed", description: "Old tool", parameters: {} }],
          timestamp: 0,
        },
        { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 1 },
        {
          role: "system",
          content: "Later instructions",
          sections: { rules: "Use 兼容测试✓", temporary: null },
          toolsRemoved: [{ name: "removed" }],
          toolsAdded: [{ name: "echo_probe", description: "Echo", parameters: { type: "object" } }],
          timestamp: 2,
        },
      ],
    } as unknown as Context;

    await streamQoder({ ...model, id: "GLM-5.3" }, transcript, options).result();
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body.toString());
    expect(payload.system).toContain("Base prompt");
    expect(payload.system).toContain("Later instructions");
    expect(payload.system).toContain("Use 兼容测试✓");
    expect(payload.system).not.toContain("old rules");
    expect(payload.system).not.toContain("obsolete section");
    expect(payload.system).not.toContain("Stale legacy prompt");
    expect(payload.messages).toEqual([
      { role: "system", content: payload.system },
      { role: "user", content: "ping" },
    ]);
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "echo_probe", description: "Echo", parameters: { type: "object" } } },
    ]);
    expect(payload.chat_context.text).toBe("ping");
  });

  it("preserves legacy Context prompts and tools without system transcript messages", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta: { content: "pong" } }] }), "[DONE]"));
    await streamQoder(
      model,
      {
        ...context,
        systemPrompt: "Legacy instructions",
        tools: [{ name: "noop", description: "No-op", parameters: { type: "object" } }],
      },
      options,
    ).result();
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body.toString());
    expect(payload.system).toBe("Legacy instructions");
    expect(payload.messages).toEqual([
      { role: "system", content: "Legacy instructions" },
      { role: "user", content: "ping" },
    ]);
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "noop", description: "No-op", parameters: { type: "object" } } },
    ]);
  });

  it("does not resurrect legacy state when transcript sections and tools are removed", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta: { content: "pong" } }] }), "[DONE]"));
    const transcript = {
      systemPrompt: "Stale instructions",
      tools: [{ name: "removed", description: "Stale tool", parameters: {} }],
      messages: [
        {
          role: "system",
          content: "",
          sections: { rules: "temporary rules" },
          toolsAdded: [{ name: "removed", description: "Old tool", parameters: {} }],
          timestamp: 0,
        },
        {
          role: "system",
          content: "",
          sections: { rules: null },
          toolsRemoved: [{ name: "removed" }],
          timestamp: 1,
        },
        { role: "user", content: "ping", timestamp: 2 },
      ],
    } as unknown as Context;
    await streamQoder(model, transcript, options).result();
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body.toString());
    expect(payload.system).toBe("");
    expect(payload.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(payload.tools).toEqual([]);
  });

  it.each([
    false,
    "high",
  ])("emits executable DSML calls with reasoning=%s without leaking markup", async (reasoning) => {
    const markup = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="bash"><｜｜DSML｜｜ parameter name="command" string="true">echo "DSML_OK"; id</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="timeout" string="false">120</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { reasoning_content: "Use the shell." } }] }),
        ...Array.from(markup, (content) => envelope({ choices: [{ delta: { content } }] })),
        envelope({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "native_1", function: { name: "noop", arguments: "{}" } }] } },
          ],
        }),
        "[DONE]",
      ),
    );

    const stream = streamQoder(model, context, { ...options, reasoning } as unknown as SimpleStreamOptions);
    const completedCalls = [];
    let streamedText = "";
    for await (const event of stream) {
      if (event.type === "toolcall_end") completedCalls.push(event.toolCall);
      if (event.type === "text_delta") streamedText += event.delta;
    }
    const result = await stream.result();
    const calls = [
      {
        type: "toolCall",
        id: "dsml_call_1",
        name: "bash",
        arguments: { command: 'echo "DSML_OK"; id', timeout: 120 },
      },
      { type: "toolCall", id: "native_1", name: "noop", arguments: {} },
    ];
    expect(result.stopReason).toBe("toolUse");
    expect(completedCalls).toEqual(calls);
    expect(result.content).toEqual([{ type: "thinking", thinking: "Use the shell." }, ...calls]);
    expect(streamedText).toBe("");
  });

  it("finalizes a truncated DSML invoke into a tool call instead of transcript text", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                content:
                  '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="path" string="true">/tmp/example</｜｜DSML｜｜ parameter>',
              },
            },
          ],
        }),
        "[DONE]",
      ),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "dsml_call_1", name: "read", arguments: { path: "/tmp/example" } },
    ]);
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
