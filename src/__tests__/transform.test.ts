import type { Message, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getContentText, transformMessagesForQoder, transformTools } from "../transform.js";

// ── getContentText ────────────────────────────────────────────────────────

describe("getContentText", () => {
  it("returns string content directly", () => {
    const msg = { role: "user", content: "hello" } as Message;
    expect(getContentText(msg)).toBe("hello");
  });

  it("joins text and thinking blocks from array content", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "reasoning" },
      ],
    } as unknown as Message;
    expect(getContentText(msg)).toBe("answerreasoning");
  });

  it("skips non-text/non-thinking blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "base64", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    } as unknown as Message;
    expect(getContentText(msg)).toBe("ab");
  });

  it("returns empty string for null content", () => {
    const msg = { role: "assistant", content: null } as unknown as Message;
    expect(getContentText(msg)).toBe("");
  });

  it("returns empty string for undefined content", () => {
    const msg = { role: "assistant" } as unknown as Message;
    expect(getContentText(msg)).toBe("");
  });
});

// ── transformTools ────────────────────────────────────────────────────────

describe("transformTools", () => {
  it("transforms tools to Qoder format", () => {
    const tools: Tool[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const result = transformTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });
  });

  it("handles empty tools array", () => {
    expect(transformTools([])).toEqual([]);
  });

  it("preserves all tool properties", () => {
    const tools: Tool[] = [
      { name: "a", description: "desc a", parameters: { p: 1 } },
      { name: "b", description: "desc b", parameters: { q: 2 } },
    ];
    const result = transformTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("a");
    expect(result[1].function.name).toBe("b");
  });
});

// ── transformMessagesForQoder ─────────────────────────────────────────────

describe("transformMessagesForQoder", () => {
  it("passes through simple user string messages", () => {
    const msgs: Message[] = [{ role: "user", content: "hello" } as Message];
    const result = transformMessagesForQoder(msgs);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("skips assistant messages with error stopReason", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "err", stopReason: "error" },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("skips assistant messages with aborted stopReason", () => {
    const msgs = [{ role: "assistant", content: "aborted", stopReason: "aborted" }] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    expect(result).toHaveLength(0);
  });

  it("handles user message with array content (text only)", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    expect(result[0].content).toBe("part1part2");
  });

  it("handles user message with image content", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at " },
          { type: "image", data: "abc123", mimeType: "image/png" },
        ],
      },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    const content = result[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "look at " });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    });
  });

  it("handles assistant message with text and tool calls", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read_file",
            arguments: { path: "/tmp/test" },
          },
        ],
      },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("I'll read the file");
    const msg0 = result[0] as {
      role: string;
      content: unknown;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(msg0.tool_calls).toHaveLength(1);
    expect(msg0.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "/tmp/test" }),
      },
    });
  });

  it("keeps assistant thinking separate from response text", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "answer" },
        ],
      },
    ] as unknown as Message[];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "let me think",
      },
    ]);
  });

  it("preserves interleaved thinking, text, and tool calls without adding delimiters", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: " First <thinking>" },
          { type: "text", text: "answer " },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/tmp/test" } },
          { type: "thinking", thinking: "\nsecond</thinking> " },
          { type: "text", text: "continues" },
        ],
      },
    ] as unknown as Message[];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "assistant",
        content: "answer continues",
        reasoning_content: " First <thinking>\nsecond</thinking> ",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/test" }) },
          },
        ],
      },
    ]);
  });

  it.each(["", " \n<host>raw & reasoning</host>\n "])("preserves thinking-only content verbatim (%j)", (thinking) => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking }],
      },
    ] as unknown as Message[];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: thinking,
      },
    ]);
  });

  it("preserves text-only tool results", () => {
    const msgs: Message[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [
          { type: "text", text: "file content " },
          { type: "text", text: "here" },
        ],
        isError: false,
        timestamp: 0,
      },
    ];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file content here",
      },
    ]);
  });

  it("preserves mixed tool result blocks in their original order", () => {
    const msgs: Message[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [
          { type: "text", text: "before" },
          { type: "image", data: "first", mimeType: "image/png" },
          { type: "text", text: "" },
          { type: "text", text: "between" },
          { type: "image", data: "second", mimeType: "image/jpeg" },
          { type: "text", text: "after" },
        ],
        isError: false,
        timestamp: 0,
      },
    ];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,first" } },
          { type: "text", text: "" },
          { type: "text", text: "between" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,second" } },
          { type: "text", text: "after" },
        ],
      },
    ]);
  });

  it("preserves image-only tool results", () => {
    const msgs: Message[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [
          { type: "image", data: "first", mimeType: "image/png" },
          { type: "image", data: "second", mimeType: "image/jpeg" },
        ],
        isError: false,
        timestamp: 0,
      },
    ];
    expect(transformMessagesForQoder(msgs)).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,first" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,second" } },
        ],
      },
    ]);
  });

  it("handles assistant message with string content", () => {
    const msgs = [
      {
        role: "assistant",
        content: "simple response",
      },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "simple response",
    });
  });

  it("keeps string content for assistant messages containing only tool calls", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "fn",
            arguments: {},
          },
        ],
      },
    ] as unknown as Message[];
    const result = transformMessagesForQoder(msgs);
    const msg0 = result[0] as { role: string; content: unknown; tool_calls?: unknown[] };
    expect(msg0.content).toBe("");
    expect(msg0.tool_calls).toHaveLength(1);
  });
});
