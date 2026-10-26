import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Models from "../models.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolveQoderIdentity: vi.fn(),
  getCachedModelConfig: vi.fn(),
}));

vi.mock("../cosy.js", () => ({
  buildAuthHeaders: () => ({}),
  formatQoderHttpError: (_scope: string, status: number, statusText: string) => `${status} ${statusText}`,
  getMachineId: () => "machine-id",
  getQoderChatURL: () => "https://qoder.example.test/chat",
  getQoderBaseUrl: () => "https://qoder.example.test/",
  getQoderCNDirectModel: (id: string) => id,
  getQoderMode: () => "cn",
  getQoderUserEmailFallback: () => "user@example.test",
  isQoderCNMode: (mode: string) => mode === "cn",
  logCosyRequest: vi.fn(),
  logCosyResponse: vi.fn(),
}));

vi.mock("../models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Models>()),
  getCachedModelConfig: mocks.getCachedModelConfig,
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
    mocks.getCachedModelConfig.mockReset().mockReturnValue(undefined);
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
      tools: [{ type: "function", function: bashTool }],
      messages: [
        {
          role: "system",
          content: "You are a coding agent.\n\nUse bash to execute commands.\n\nDo not invent output.",
        },
        { role: "user", content: "Run pwd" },
      ],
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
      tools: [{ type: "function", function: updatedBash }],
      messages: [
        { role: "system", content: "Base prompt\n\nAdditional instructions\n\nNew rules" },
        { role: "user", content: "Run pwd" },
      ],
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

    expect(requestBody().messages[0]).toEqual({ role: "system", content: "Current prompt" });
    expect(requestBody().tools).toEqual([]);
  });

  it("keeps supporting the legacy top-level prompt and tools", async () => {
    mockTextResponse();
    const legacy = { ...context, systemPrompt: "Legacy instructions", tools: [bashTool] } as unknown as Context;

    await streamQoder(model, legacy, options).result();

    expect(requestBody()).toMatchObject({
      tools: [{ type: "function", function: bashTool }],
      messages: [
        { role: "system", content: "Legacy instructions" },
        { role: "user", content: "ping" },
      ],
    });
  });

  it("accepts OMP prompt sections without passing arrays into request hashing", async () => {
    mockTextResponse();
    const result = await streamQoder(
      model,
      { ...context, systemPrompt: ["Base instructions", "Workspace instructions"] },
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(requestBody().messages[0]).toEqual({
      role: "system",
      content: "Base instructions\n\nWorkspace instructions",
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
      { role: "system", content: "Use bash" },
      { role: "user", content: "Run pwd" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_pwd", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
      },
      { role: "tool", tool_call_id: "call_pwd", content: "/test/project" },
    ]);
  });

  const checkpoint = `<analysis>Review the conversation so far.</analysis>
<summary>
1. Primary Request and Intent: diagnose a skill collision.
2. Key Technical Concepts: skills.
3. Files and Code Sections: SKILL.md.
4. Pending Tasks: answer the user.
5. Current Work: investigation.
</summary>`;
  const agentContext = { ...context, tools: [bashTool] } as unknown as Context;

  function textResponse(text: string) {
    return responseWithSse(envelope({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }), "[DONE]");
  }

  it.each([
    { prompt: "继续执行任务", text: checkpoint, finish: "stop" },
    { prompt: "读取交接文件并汇总", text: checkpoint.slice(0, -10), finish: "length" },
    { prompt: "解释工具协议", text: "<｜｜DSML｜｜ calls>", finish: "stop" },
    { prompt: "查看协议前缀", text: "<｜DSML", finish: "stop" },
    { prompt: "解释这段XML", text: "```xml\n<think>literal example</think>\n```", finish: "stop" },
  ])("does not reinterpret streamed body content or regenerate it: $prompt", async ({ prompt, text, finish }) => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        ...Array.from(text, (content) => envelope({ choices: [{ delta: { content } }] })),
        envelope({ choices: [{ finish_reason: finish }] }),
        "[DONE]",
      ),
    );
    const stream = streamQoder(
      model,
      {
        ...agentContext,
        systemPrompt: "Follow the user.",
        messages: [{ role: "user", content: prompt }],
      } as unknown as Context,
      options,
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe(finish);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(text);
    expect(events.some((event) => event.type === "toolcall_start" || event.type === "error")).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(requestBody().messages).toEqual([
      { role: "system", content: "Follow the user." },
      { role: "user", content: prompt },
    ]);
  });

  it.each([
    { delta: { reasoning_content: "Only reasoning" }, expected: [{ type: "thinking", thinking: "Only reasoning" }] },
    { delta: {}, expected: [] },
  ])("preserves upstream termination without judging answer completeness: %j", async ({ delta, expected }) => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta, finish_reason: "stop" }] }), "[DONE]"));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual(expected);
    expect(result.errorMessage).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "The marker <｜｜DSML｜｜ calls> belongs to the tool protocol.",
    "```xml\n<｜DSML｜tool_calls>\n```",
    "<summary>DSML <｜｜DSML｜｜ calls> example</summary>",
    "<",
    " \n",
  ])("preserves protocol explanations and quoted examples: %s", async (text) => {
    mocks.fetch.mockResolvedValue(textResponse(text));
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text }]);
  });

  it("leaves tool-free host compaction requests alone", async () => {
    mocks.fetch.mockResolvedValue(textResponse(checkpoint));
    const result = await streamQoder(model, context, options).result();
    expect(result.content).toEqual([{ type: "text", text: checkpoint }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "Here is an XML example: <analysis>text</analysis><summary>example</summary>",
    "<analysis>Consider the evidence.</analysis>The first skill wins.",
    "<summary>A short ordinary summary.</summary>",
  ])("does not drop ordinary answers or XML examples: %s", async (text) => {
    mocks.fetch.mockResolvedValue(textResponse(text));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates remote conversations while retaining affinity inside one host session", async () => {
    mocks.fetch.mockImplementation(() => textResponse("pong"));
    for (const sessionId of ["chat-a", "chat-a", "chat-b", undefined, undefined]) {
      await streamQoder(model, agentContext, { ...options, sessionId }).result();
    }
    const ids = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")).session_id);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set([ids[0], ...ids.slice(2)]).size).toBe(4);
  });

  it("separates host compaction from tool-enabled chat even with the same sessionId", async () => {
    mocks.fetch.mockImplementation(() => textResponse("pong"));
    await streamQoder(model, agentContext, { ...options, sessionId: "chat-a" }).result();
    await streamQoder(model, context, { ...options, sessionId: "chat-a" }).result();
    const ids = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")).session_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("reads usage-only terminal chunks, splits cached input, and computes cost without double counting snapshots", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { content: "pong" } }], usage: { prompt_tokens: 100, completion_tokens: 2 } }),
        envelope({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
        "[DONE]",
      ),
    );
    const priced = { ...model, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } };
    const result = await streamQoder(priced, context, options).result();
    expect(result.usage).toMatchObject({ input: 60, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 110 });
    expect(result.usage.cost.total).toBeCloseTo(0.0001);
  });

  it("merges partial usage snapshots and supports DeepSeek cache fields", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [{ delta: { content: "pong" } }],
          usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 },
        }),
        envelope({ usage: { completion_tokens: 10 } }),
        "[DONE]",
      ),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.usage).toMatchObject({ input: 60, output: 10, cacheRead: 40, totalTokens: 110 });
  });

  it("preserves length termination rather than falsely reporting success", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(envelope({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }), "[DONE]"),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("length");
  });

  it("rejects an unsupported finish reason rather than reporting a normal stop", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { content: "partial" }, finish_reason: "content_filter" }] }),
        "[DONE]",
      ),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("content_filter");
  });

  it("processes the final SSE line without a trailing newline", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        `data: ${envelope({ choices: [{ delta: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}`,
      ),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(result.usage.totalTokens).toBe(10);
  });

  it("does not accept a disconnected stream as a successful answer", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ choices: [{ delta: { content: "partial" } }] })));
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("without a completion marker");
  });

  it("stops reading at DONE instead of parsing subsequent transport garbage", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(envelope({ choices: [{ delta: { content: "pong" } }] }), "[DONE]", "{invalid"),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("stop");
  });

  it("invokes host request/response/event inspection hooks without enabling provider logging", async () => {
    const inner = { choices: [{ delta: { content: "pong" }, finish_reason: "stop" }] };
    mocks.fetch.mockResolvedValue(responseWithSse(envelope(inner), "[DONE]"));
    const order: string[] = [];
    const onPayload = vi.fn((payload: unknown) => {
      order.push("payload");
      return { ...(payload as object), test_marker: true };
    });
    const onResponse = vi.fn(() => {
      order.push("response");
    });
    const onProviderStreamEvent = vi.fn(() => {
      order.push("event");
    });
    const result = await streamQoder(model, context, {
      ...options,
      onPayload,
      onResponse,
      onProviderStreamEvent,
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(requestBody().test_marker).toBe(true);
    expect(order).toEqual(["payload", "response", "event"]);
    expect(onProviderStreamEvent).toHaveBeenCalledWith(inner, model);
  });

  it("includes system prompt and tool-call arguments in request identity", async () => {
    mocks.fetch.mockImplementation(() => textResponse("pong"));
    for (const [systemPrompt, command] of [
      ["rules-a", "pwd"],
      ["rules-b", "pwd"],
      ["rules-b", "ls"],
    ]) {
      const ctx = {
        ...agentContext,
        systemPrompt,
        messages: [
          ...context.messages,
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }],
            stopReason: "toolUse",
          },
        ],
      } as unknown as Context;
      await streamQoder(model, ctx, { ...options, sessionId: "same-chat" }).result();
    }
    const ids = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")).chat_record_id);
    expect(new Set(ids).size).toBe(3);
  });

  it("decodes UTF-8 across byte boundaries and accepts an inner DONE sentinel", async () => {
    const bytes = new TextEncoder().encode(
      `data: ${envelope({ choices: [{ delta: { content: "正常答复" } }] })}\n\ndata: ${envelope("[DONE]")}`,
    );
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
      ),
    );
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "正常答复" }]);
  });

  it("surfaces an upstream error envelope instead of returning an empty stop", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse(envelope("rate limited", 429)));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Upstream status 429: rate limited");
    expect(result.content).toEqual([]);
  });

  it.each(["sse", "http"])("renews an expired login from %s once before returning content", async (transport) => {
    const body = JSON.stringify({ code: "105", message: "Login expired" });
    mocks.fetch.mockResolvedValueOnce(
      transport === "sse" ? responseWithSse(envelope(body, 403)) : new Response(body, { status: 403 }),
    );
    mocks.fetch.mockResolvedValueOnce(
      responseWithSse(envelope({ choices: [{ delta: { content: "recovered" } }] }), "[DONE]"),
    );
    const renew = vi.fn().mockResolvedValue("renewed-token");
    const stream = streamQoder(model, context, options, renew);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(mocks.resolveQoderIdentity.mock.calls.map((call) => call[0])).toEqual(["access-token", "renewed-token"]);
  });

  it("stops after a second expired-login response", async () => {
    mocks.fetch.mockImplementation(() => responseWithSse(envelope({ code: 105, message: "Login expired" }, 403)));
    const renew = vi.fn().mockResolvedValue("renewed-token");
    const result = await streamQoder(model, context, options, renew).result();
    expect(result.stopReason).toBe("error");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it.each([
    { content: "already delivered" },
    { reasoning_content: "already thinking" },
    { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{}" } }] },
  ])("does not replay a response after assistant output: %j", async (delta) => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(envelope({ choices: [{ delta }] }), envelope({ code: 105, message: "Login expired" }, 403)),
    );
    const renew = vi.fn();
    const result = await streamQoder(model, context, options, renew).result();
    expect(result.stopReason).toBe("error");
    expect(renew).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 503])("does not renew unrelated HTTP %s failures", async (status) => {
    mocks.fetch.mockResolvedValue(new Response("Permission denied", { status }));
    const renew = vi.fn();
    expect((await streamQoder(model, context, options, renew).result()).stopReason).toBe("error");
    expect(renew).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry if cancelled during renewal", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue(responseWithSse(envelope({ code: 105, message: "Login expired" }, 403)));
    const renew = vi.fn(async () => {
      controller.abort();
      return "renewed-token";
    });
    const result = await streamQoder(model, context, { ...options, signal: controller.signal }, renew).result();
    expect(result.stopReason).toBe("aborted");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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

  it("does not retry a cancelled thinking-only response", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue(textResponse("<thinking>Let me check."));
    const result = await streamQoder(model, agentContext, {
      ...options,
      signal: controller.signal,
      onProviderStreamEvent: () => controller.abort(),
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("aborted");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps native reasoning separate from literal tags across channel transitions", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { reasoning_content: "first reasoning" } }] }),
        ...Array.from("```xml\n<think>example</think>\n```", (content) =>
          envelope({ choices: [{ delta: { content } }] }),
        ),
        envelope({ choices: [{ delta: { reasoning_content: "second reasoning" } }] }),
        envelope({ choices: [{ delta: { content: "final answer" }, finish_reason: "stop" }] }),
        "[DONE]",
      ),
    );
    const stream = streamQoder(model, context, options);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.content).toEqual([
      { type: "thinking", thinking: "first reasoning" },
      { type: "text", text: "```xml\n<think>example</think>\n```" },
      { type: "thinking", thinking: "second reasoning" },
      { type: "text", text: "final answer" },
    ]);
    for (const [index, block] of result.content.entries()) {
      expect(
        events.filter(
          (event) => event.type === `${block.type}_end` && "contentIndex" in event && event.contentIndex === index,
        ),
      ).toHaveLength(1);
    }
  });

  it.each([
    "<think>reason</think>",
    "<think>unfinished",
  ])("preserves a real tool call alongside tagged thinking: %s", async (content) => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":' } }],
              },
            },
          ],
        }),
        envelope({ choices: [{ delta: { content } }] }),
        envelope({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: "stop" },
          ],
        }),
        "[DONE]",
      ),
    );
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "bash",
      arguments: { command: "pwd" },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps abort precedence over incomplete thinking", async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue(textResponse("<thinking>unfinished"));
    const result = await streamQoder(model, context, {
      ...options,
      signal: controller.signal,
      onProviderStreamEvent: () => controller.abort(),
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("aborted");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an upstream failure rather than replacing it with an incomplete-output error", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { reasoning_content: "unfinished" } }] }),
        envelope("unavailable", 503),
      ),
    );
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("503");
    expect(result.content).toEqual([{ type: "thinking", thinking: "unfinished" }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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

  it.each([
    { id: "", name: "read", arguments: "{}" },
    { id: "call_2", name: " ", arguments: "{}" },
    { id: "call_2", name: "read", arguments: "[]" },
    { id: "call_2", name: "read", arguments: "null" },
  ])("does not finalize any tools when a sibling tool is invalid: %j", async (invalid) => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: "{}" } },
                  { index: 1, id: invalid.id, function: { name: invalid.name, arguments: invalid.arguments } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "[DONE]",
      ),
    );
    const stream = streamQoder(model, context, options);
    const events = [];
    for await (const event of stream) events.push(event);
    expect((await stream.result()).stopReason).toBe("error");
    expect(events.some((event) => event.type === "toolcall_end" || event.type === "done")).toBe(false);
  });

  it("honors zero temperature and ordinary headers including case-insensitive removal", async () => {
    mockTextResponse();
    const result = await streamQoder(model, context, {
      ...options,
      temperature: 0,
      headers: { "X-Trace": "trace-1", ACCEPT: "text/event-stream", "accept-encoding": null },
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(requestBody().parameters.temperature).toBe(0);
    const headers = new Headers(mocks.fetch.mock.calls[0][1].headers);
    expect(headers.get("x-trace")).toBe("trace-1");
    expect(headers.has("accept-encoding")).toBe(false);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it.each([
    "AUTHORIZATION",
    "cosy-key",
    "Host",
    "Content-Length",
    "X-Model-Key",
  ])("rejects overriding or suppressing managed header %s before sending", async (name) => {
    for (const value of ["override", null]) {
      const result = await streamQoder(model, context, { ...options, headers: { [name]: value } }).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("Qoder-managed header");
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    { reasoning: undefined, enabled: false, effort: "none" },
    { reasoning: false, enabled: false, effort: "none" },
    { reasoning: "off", enabled: false, effort: "none" },
    { reasoning: "high", enabled: true, effort: "high" },
  ])("maps host thinking mode to the supported wire flags: %j", async ({ reasoning, enabled, effort }) => {
    const catalog = Object.freeze({
      key: model.id,
      is_reasoning: true,
      thinking_config: {
        disabled: { is_default: false },
        enabled: { is_default: true, efforts: { high: { is_default: true } } },
      },
    });
    mocks.getCachedModelConfig.mockReturnValue(catalog);
    mockTextResponse();
    // Older hosts also pass boolean/off values outside the current SDK's effort union.
    const hostOptions = { ...options, reasoning } as unknown as SimpleStreamOptions;
    const result = await streamQoder(model, context, hostOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(requestBody().parameters).toMatchObject({ enable_thinking: enabled, reasoning_effort: effort });
    expect(requestBody().model_config.is_reasoning).toBe(enabled);
    expect(catalog.thinking_config.disabled.is_default).toBe(false);
  });

  it("does not alias requests with different temperature or thinking mode in one session", async () => {
    mocks.getCachedModelConfig.mockReturnValue({
      key: model.id,
      is_reasoning: true,
      thinking_config: { disabled: {}, enabled: { efforts: { high: {} } } },
    });
    mocks.fetch.mockImplementation(() => textResponse("pong"));
    for (const settings of [
      { temperature: 0 },
      { temperature: 0.5 },
      { temperature: 0.5, reasoning: "high" as const },
    ]) {
      await streamQoder(model, context, { ...options, ...settings, sessionId: "same-session" }).result();
    }
    const bodies = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString()));
    expect(new Set(bodies.map((body) => body.chat_record_id)).size).toBe(3);
    expect(new Set(bodies.map((body) => body.session_id)).size).toBe(1);
  });
});
