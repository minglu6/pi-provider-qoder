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

  it("accepts OMP prompt sections without passing arrays into request hashing", async () => {
    mockTextResponse();
    const result = await streamQoder(
      model,
      { ...context, systemPrompt: ["Base instructions", "Workspace instructions"] },
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(requestBody().system).toBe("Base instructions\n\nWorkspace instructions");
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

  // Sanitized shape of the incident: an unrequested checkpoint was returned
  // as normal assistant content, despite the last user asking for diagnosis.
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

  it("quarantines an unsolicited checkpoint and retries the original request once in a fresh session", async () => {
    mocks.fetch
      .mockResolvedValueOnce(textResponse(checkpoint))
      .mockResolvedValueOnce(textResponse("Use the first skill."));
    const stream = streamQoder(model, agentContext, { ...options, sessionId: "chat-a" });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Use the first skill." }]);
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Review the conversation");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [first, retry] = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")));
    expect(retry.messages).toEqual(first.messages);
    expect(retry.tools).toEqual(first.tools);
    expect(retry.system).toContain("not a context-compaction request");
    expect(retry.session_id).not.toBe(first.session_id);
    expect(retry.chat_record_id).not.toBe(first.chat_record_id);
  });

  it("does not leak the checkpoint in text deltas even when every character is a separate SSE delta", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        responseWithSse(
          ...Array.from(checkpoint, (content) => envelope({ choices: [{ delta: { content } }] })),
          "[DONE]",
        ),
      )
      .mockResolvedValueOnce(textResponse("fixed"));
    const events = [];
    for await (const event of streamQoder(model, agentContext, options)) events.push(event);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("fixed");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly after a second unsolicited checkpoint, without a retry loop or fake overflow", async () => {
    mocks.fetch.mockImplementation(() => textResponse(checkpoint));
    const result = await streamQoder(model, agentContext, options).result();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("QODER_UNEXPECTED_SUMMARY");
    expect(result.errorMessage).not.toContain("context_length_exceeded");
    expect(result.content).toEqual([]);
  });

  it("recognizes the Chinese checkpoint headings from the incident", async () => {
    const chinese =
      "<analysis>会话梳理</analysis><summary>1. 主要请求与意图：排查\n2. 关键技术概念：技能\n3. 文件与代码段：文件\n4. 待办任务：回答</summary>";
    mocks.fetch.mockResolvedValueOnce(textResponse(chinese)).mockResolvedValueOnce(textResponse("正常答复"));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.content).toEqual([{ type: "text", text: "正常答复" }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Summarize our conversation",
    "请总结这次排查",
    "输出 <summary> 格式",
  ])("preserves explicitly requested summaries: %s", async (content) => {
    mocks.fetch.mockResolvedValue(textResponse(checkpoint));
    const result = await streamQoder(
      model,
      { ...agentContext, messages: [{ role: "user", content }] } as unknown as Context,
      options,
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: checkpoint }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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

  it("does not retry a quarantined response after cancellation", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(() => {
      controller.abort();
      return textResponse(checkpoint);
    });
    const result = await streamQoder(model, agentContext, { ...options, signal: controller.signal }).result();
    expect(result.stopReason).toBe("aborted");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([]);
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

  it("retries a truncated checkpoint without leaking its partial summary", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        responseWithSse(
          envelope({
            choices: [{ delta: { content: checkpoint.replace("</summary>", "") }, finish_reason: "length" }],
          }),
          "[DONE]",
        ),
      )
      .mockResolvedValueOnce(textResponse("normal answer"));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.content).toEqual([{ type: "text", text: "normal answer" }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry rate limits, and emits only one error after a failed recovery request", async () => {
    mocks.fetch
      .mockResolvedValueOnce(textResponse(checkpoint))
      .mockResolvedValueOnce(responseWithSse(envelope("rate limited", 429)));
    const events = [];
    const stream = streamQoder(model, agentContext, options);
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("429");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("Review the conversation");
  });

  it.each([
    checkpoint,
    "<thinking>Let me run the next check.",
  ])("recovery preserves prior tool results and returns a new tool call only once: %s", async (incomplete) => {
    mocks.fetch.mockResolvedValueOnce(textResponse(incomplete)).mockResolvedValueOnce(
      responseWithSse(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "new_call", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "[DONE]",
      ),
    );
    const history = {
      ...agentContext,
      messages: [
        ...context.messages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "old_call", name: "bash", arguments: { command: "ls" } }],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "old_call",
          toolName: "bash",
          content: [{ type: "text", text: "already executed" }],
          isError: false,
        },
      ],
    } as unknown as Context;
    const stream = streamQoder(model, history, options);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
    expect((await stream.result()).stopReason).toBe("toolUse");
    const bodies = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")));
    expect(bodies[1].messages).toEqual(bodies[0].messages);
    expect(bodies[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "old_call",
      content: "already executed",
    });
  });

  it("does not leak native thinking or partial snapshots from a rejected attempt", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        responseWithSse(
          envelope({ choices: [{ delta: { reasoning_content: "discarded attempt reasoning" } }] }),
          envelope({ choices: [{ delta: { content: checkpoint } }] }),
          "[DONE]",
        ),
      )
      .mockResolvedValueOnce(textResponse("normal answer"));
    const events = [];
    for await (const event of streamQoder(model, agentContext, { ...options, reasoning: "high" })) events.push(event);
    expect(JSON.stringify(events)).not.toContain("discarded attempt");
    expect(JSON.stringify(events)).not.toContain("Review the conversation");
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
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

  it("rejects a successful stream that contains no assistant content", async () => {
    mocks.fetch.mockResolvedValue(responseWithSse("[DONE]"));

    const result = await streamQoder(model, context, options).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Qoder upstream completed without assistant content");
  });

  it.each([
    { reasoning_content: "Let me simulate the current parsing behavior. Let's run." },
    { content: "<thinking>Let me run the next check.</thinking> \n" },
    { content: "<thinking>Let me run the next check." },
  ])("recovers thinking-only generation once without exposing the discarded attempt: %j", async (delta) => {
    mocks.fetch
      .mockResolvedValueOnce(responseWithSse(envelope({ choices: [{ delta, finish_reason: "stop" }] }), "[DONE]"))
      .mockResolvedValueOnce(textResponse("已完成核查，文件名不会命中原关键词。"));
    const stream = streamQoder(model, agentContext, { ...options, sessionId: "chat-a" });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "已完成核查，文件名不会命中原关键词。" }]);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.some((event) => event.type === "error" || event.type === "thinking_delta")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("Let me");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [first, retry] = mocks.fetch.mock.calls.map((call) => JSON.parse(call[1].body.toString("utf8")));
    expect(retry.messages).toEqual(first.messages);
    expect(retry.tools).toEqual(first.tools);
    expect(retry.system).toContain("Return a user-facing answer or a real tool call");
    expect(retry.session_id).not.toBe(first.session_id);
    expect(retry.chat_record_id).not.toBe(first.chat_record_id);
  });

  it.each([
    ["<thinking>Only a plan.", checkpoint],
    [checkpoint, "<thinking>Only a plan."],
  ])("shares a single recovery limit across incomplete output and checkpoints: %j", async (first, second) => {
    mocks.fetch.mockResolvedValueOnce(textResponse(first)).mockResolvedValueOnce(textResponse(second));
    const stream = streamQoder(model, agentContext, options);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.some((event) => event.type === "done" || event.type === "toolcall_start")).toBe(false);
    if (second === checkpoint) {
      expect(result.errorMessage).toContain("QODER_UNEXPECTED_SUMMARY");
      expect(result.content).toEqual([]);
    } else {
      expect(result.errorMessage).toContain("QODER_INCOMPLETE_RESPONSE");
      expect(result.errorMessage).toContain("no further retry");
      expect(result.content).toEqual([{ type: "thinking", thinking: "Only a plan." }]);
    }
  });

  it("does not retry incomplete output after public text has already streamed", async () => {
    mocks.fetch.mockResolvedValue(textResponse("已找到文件。<thinking>Let me check."));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("QODER_INCOMPLETE_RESPONSE");
    expect(result.content).toEqual([
      { type: "text", text: "已找到文件。" },
      { type: "thinking", thinking: "Let me check." },
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thinking-only attempt cancelled before recovery", async () => {
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

  it("surfaces an upstream failure during incomplete-output recovery without another retry", async () => {
    mocks.fetch
      .mockResolvedValueOnce(textResponse("<thinking>Let me check."))
      .mockResolvedValueOnce(responseWithSse(envelope("rate limited", 429)));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("429");
    expect(result.content).toEqual([]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    false,
    "off",
    "high",
  ])("rejects repeated fragmented unclosed thinking with reasoning=%s without inventing tools", async (reasoning) => {
    const chunks = ["<", "thinking", ">", "Confirmed", " live", ".</", "｜｜DSML｜｜", " parameter", ">"];
    mocks.fetch.mockImplementation(() =>
      responseWithSse(
        ...chunks.map((content) => envelope({ choices: [{ delta: { content } }] })),
        envelope({ choices: [{ finish_reason: "stop" }] }),
        "[DONE]",
      ),
    );
    const stream = streamQoder(model, agentContext, { ...options, reasoning } as SimpleStreamOptions);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("QODER_INCOMPLETE_RESPONSE");
    expect(result.content).toEqual([{ type: "thinking", thinking: chunks.join("").slice("<thinking>".length) }]);
    expect(events.some((event) => event.type === "text_delta" || event.type === "toolcall_start")).toBe(false);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { delta: { content: "<think>reason</think>" }, finish_reason: "stop" },
    { delta: { content: "<reasoning>reason</reasoning> \n" }, finish_reason: undefined },
    { delta: { reasoning_content: "native reasoning" }, finish_reason: "stop" },
    { delta: { content: "prefix<thought>unfinished" }, finish_reason: "stop" },
    { delta: { content: "<thinking>" }, finish_reason: "stop" },
    { delta: { content: "<thinking></thinking>" }, finish_reason: "stop" },
  ])("rejects incomplete output without a usable answer: %j", async (choice) => {
    mocks.fetch.mockImplementation(() => responseWithSse(envelope({ choices: [choice] }), "[DONE]"));
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("QODER_INCOMPLETE_RESPONSE");
    expect(mocks.fetch).toHaveBeenCalledTimes(choice.delta.content?.startsWith("prefix") ? 1 : 2);
  });

  it("preserves native reasoning, tagged reasoning and the complete answer with paired end events", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { reasoning_content: "native reasoning" } }] }),
        ...Array.from("prefix<think>tagged reasoning</think>\n\nanswer", (content) =>
          envelope({ choices: [{ delta: { content } }] }),
        ),
        "[DONE]",
      ),
    );
    const stream = streamQoder(model, context, options);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "thinking", thinking: "native reasoning" },
      { type: "text", text: "prefix" },
      { type: "thinking", thinking: "tagged reasoning" },
      { type: "text", text: "\n\nanswer" },
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

  it.each([
    "<thinking>unfinished",
    "<think>reason</think>",
    "<thinking>",
  ])("keeps length termination for thinking output: %s", async (content) => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(envelope({ choices: [{ delta: { content }, finish_reason: "length" }] }), "[DONE]"),
    );
    const result = await streamQoder(model, context, options).result();
    expect(result.stopReason).toBe("length");
    expect(result.errorMessage).toBeUndefined();
    expect(result.content.every((block) => block.type === "thinking")).toBe(true);
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
    expect(result.errorMessage).not.toContain("QODER_INCOMPLETE_RESPONSE");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an upstream failure rather than replacing it with an incomplete-output error", async () => {
    mocks.fetch.mockResolvedValue(
      responseWithSse(
        envelope({ choices: [{ delta: { content: "<think>unfinished" } }] }),
        envelope("unavailable", 503),
      ),
    );
    const result = await streamQoder(model, agentContext, options).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("503");
    expect(result.errorMessage).not.toContain("QODER_INCOMPLETE_RESPONSE");
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
});
