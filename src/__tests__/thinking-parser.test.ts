import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingTagParser } from "../thinking-parser.js";

function createMockStream() {
  const events: AssistantMessageEvent[] = [];
  const push = vi.fn((event: AssistantMessageEvent) => events.push(event));
  const stream = {
    push,
    end: vi.fn(),
    [Symbol.iterator]: function* () {},
    [Symbol.asyncIterator]: function* () {},
    events,
  } as unknown as AssistantMessageEventStream;
  return { stream, push, events };
}

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
    provider: "qoder",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("ThinkingTagParser", () => {
  let output: AssistantMessage;
  let stream: AssistantMessageEventStream;
  let pushMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    output = createOutput();
    const mock = createMockStream();
    stream = mock.stream;
    pushMock = mock.push;
  });

  // ── Plain text (no thinking tags) ─────────────────────────────────────

  it("passes plain text through without modification", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello world");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("handles empty input", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.finalize();
    expect(output.content).toHaveLength(0);
  });

  // ── Standard <thinking> tags ──────────────────────────────────────────

  it("extracts thinking content from <thinking> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thinking>reasoning here</thinking> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "reasoning here" });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles thinking-only content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>just thinking</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "just thinking" });
  });

  // ── Alternative tag variants ──────────────────────────────────────────

  it("handles <think> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think>reasoning</think> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "reasoning" });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles <reasoning> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<reasoning>deep thought</reasoning>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "deep thought" });
  });

  it("handles <thought> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thought>pondering</thought>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "pondering" });
  });

  // ── Chunked streaming ─────────────────────────────────────────────────

  it("handles thinking content split across multiple chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thin");
    parser.processChunk("king>part1 ");
    parser.processChunk("part2</think");
    parser.processChunk("ing> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "part1 part2" });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles open tag split across chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("text <thin");
    parser.processChunk("king>body</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(2);
    expect(output.content[0]).toMatchObject({ type: "text", text: "text " });
    expect(output.content[1]).toMatchObject({ type: "thinking", thinking: "body" });
  });

  // ── Multiple thinking blocks ──────────────────────────────────────────

  it("handles multiple thinking blocks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>first</thinking> text <thinking>second</thinking>");
    parser.finalize();

    expect(output.content).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "text", text: " text " },
      { type: "thinking", thinking: "second" },
    ]);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles text ending with partial tag prefix", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think");
    // Don't finalize yet — the parser should hold back "<think" as potential tag
    // But finalize should flush it as text
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    const allText = textBlocks.map((c) => (c as { type: string; text: string }).text).join("");
    expect(allText).toContain("Hello");
    expect(allText).toContain("<think");
  });

  it("preserves newlines after a closing tag", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>thought</thinking>\n\nActual text");
    parser.finalize();

    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "thought" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "\n\nActual text" });
  });

  // ── getTextBlockIndex ─────────────────────────────────────────────────

  it("tracks text block index correctly", () => {
    const parser = new ThinkingTagParser(output, stream);
    expect(parser.getTextBlockIndex()).toBeNull();

    parser.processChunk("Hello");
    expect(parser.getTextBlockIndex()).toBe(0);

    parser.processChunk("<thinking>thought</thinking>");
    parser.processChunk(" World");
    expect(parser.getTextBlockIndex()).not.toBeNull();
  });

  // ── Stream events ─────────────────────────────────────────────────────

  it("emits text_start and text_delta events for plain text", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hi");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
  });

  it("emits thinking_start and thinking_delta events for thinking content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>deep</thinking>");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
  });

  // ── Finalize with remaining buffer ────────────────────────────────────

  it("finalize flushes remaining text when not in thinking mode", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("partial");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "partial" });
  });

  it("finalize flushes remaining thinking when in thinking mode", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>unfinished");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "unfinished" });
  });

  it.each([
    "thinking",
    "think",
    "reasoning",
    "thought",
  ])("recognizes %s tags at every split point without changing ordinary text", (tag) => {
    const input = `prefix <${tag}>reason</${tag}>\n\nanswer <ordinary> <thin`;
    for (let split = 1; split < input.length; split++) {
      const result = createOutput();
      const parser = new ThinkingTagParser(result, createMockStream().stream);
      parser.processChunk(input.slice(0, split));
      parser.processChunk(input.slice(split));
      parser.finalize();
      expect(result.content).toEqual([
        { type: "text", text: "prefix " },
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "\n\nanswer <ordinary> <thin" },
      ]);
      expect(parser.hasTaggedThinking()).toBe(true);
      expect(parser.hasUnclosedThinking()).toBe(false);
    }
  });

  it.each([
    "thinking",
    "think",
    "reasoning",
    "thought",
  ])("only closes %s with its matching tag and preserves an incomplete closing prefix", (tag) => {
    const wrongTag = tag === "think" ? "thought" : "think";
    const parser = new ThinkingTagParser(output, stream);
    const thinking = `reason</${wrongTag}>still thinking</${tag.slice(0, -1)}`;
    for (const chunk of `<${tag}>${thinking}`) parser.processChunk(chunk);
    parser.finalize();
    expect(parser.hasUnclosedThinking()).toBe(true);
    expect(output.content).toEqual([{ type: "thinking", thinking }]);
  });

  it.each([
    "plain text",
    "<thinking>unfinished",
    "<thinking>unfinished</think",
    "prefix<think>reason</think>suffix",
    "<thought>first</thought><reasoning>second</reasoning>",
  ])("ends every started block once with stable indices: %s", (input) => {
    const parser = new ThinkingTagParser(output, stream);
    for (const chunk of input) parser.processChunk(chunk);
    parser.finalize();
    parser.finalize();

    const events = pushMock.mock.calls.map(([event]) => event as AssistantMessageEvent);
    for (const [index, block] of output.content.entries()) {
      const blockEvents = events.filter((event) => "contentIndex" in event && event.contentIndex === index);
      expect(blockEvents[0].type).toBe(`${block.type}_start`);
      expect(blockEvents.at(-1)?.type).toBe(`${block.type}_end`);
      expect(blockEvents.filter((event) => event.type.endsWith("_start"))).toHaveLength(1);
      expect(blockEvents.filter((event) => event.type.endsWith("_end"))).toHaveLength(1);
      const deltas = blockEvents.flatMap((event) => ("delta" in event ? [event.delta] : [])).join("");
      expect(deltas).toBe(block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "");
    }
  });
});
