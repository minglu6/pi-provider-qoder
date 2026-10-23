import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";

const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];
const THINKING_OPEN_TAGS = THINKING_TAG_VARIANTS.map((variant) => variant.open);
const DSML_PREFIXES = ["<｜DSML｜", "<｜｜DSML｜｜", "</｜DSML｜", "</｜｜DSML｜｜"];
const UNPARSED_TOOL_CALL =
  "QODER_UNPARSED_TOOL_CALL: Qoder returned raw DSML instead of structured tool_calls; no tool call was accepted.";

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) {
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  }
  return maxLength;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingSeen = false;
  private publicTextSeen = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_TAG_VARIANTS[0].close;

  constructor(
    private output: AssistantMessage,
    private stream: AssistantMessageEventStream,
  ) {}

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (this.inThinking) {
        this.processInsideThinking();
      } else {
        this.processBeforeThinking();
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (this.inThinking) {
      this.emitThinking(this.textBuffer);
    } else {
      const prefix = this.textBuffer.trimStart();
      if (
        !this.publicTextSeen &&
        prefix.includes("DSML") &&
        DSML_PREFIXES.some((marker) => marker.startsWith(prefix))
      ) {
        throw new Error(UNPARSED_TOOL_CALL);
      }
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
    this.endThinking();
    this.endText();
  }

  hasUnclosedThinking(): boolean {
    return this.inThinking;
  }

  hasTaggedThinking(): boolean {
    return this.thinkingSeen;
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  private processBeforeThinking(): void {
    if (!this.publicTextSeen) {
      const prefix = this.textBuffer.trimStart();
      if (DSML_PREFIXES.some((marker) => prefix.startsWith(marker))) {
        throw new Error(UNPARSED_TOOL_CALL);
      }
      // Hold only an undecided leading protocol token, not quoted examples.
      if (DSML_PREFIXES.some((marker) => marker.startsWith(prefix))) return;
    }
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }
    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitText(this.textBuffer.slice(0, bestPos));
      this.endText();
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.thinkingSeen = true;
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }

    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(this.textBuffer, THINKING_OPEN_TAGS);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      this.endThinking();
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      return;
    }

    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private endText(): void {
    if (this.textBlockIndex === null) return;
    const block = this.output.content[this.textBlockIndex] as TextContent;
    this.stream.push({
      type: "text_end",
      contentIndex: this.textBlockIndex,
      content: block.text,
      partial: this.output,
    });
    this.lastTextBlockIndex = this.textBlockIndex;
    this.textBlockIndex = null;
  }

  private endThinking(): void {
    if (this.thinkingBlockIndex === null) return;
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    this.stream.push({
      type: "thinking_end",
      contentIndex: this.thinkingBlockIndex,
      content: block.thinking,
      partial: this.output,
    });
    this.thinkingBlockIndex = null;
  }

  private emitText(text: string): void {
    if (!text) return;
    if (text.trim()) this.publicTextSeen = true;
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.stream.push({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent;
    block.text += text;
    this.stream.push({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    if (this.thinkingBlockIndex === null) {
      this.thinkingBlockIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    block.thinking += thinking;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    });
  }
}
