// A number of models served through the Qoder gateway (most visibly the DeepSeek
// family) do not answer the OpenAI-style `tools` payload with OpenAI-style
// `tool_calls`. Instead they emit their native DSML tool-call markup inside the
// normal assistant text stream, for example:
//
//   ｜DSML｜｜calls
//   ｜DSML｜｜invoke name="bash"
//   ｜DSML｜｜parameter name="command" string="true">ls -la｜DSML｜｜parameter
//   ｜DSML｜｜invoke
//   ｜DSML｜｜calls
//
// Nothing upstream of this file understands that markup, so it used to be copied
// into the assistant text block verbatim: the user sees the raw tags, pi reports
// stopReason "stop" instead of "toolUse" so no tool runs, and the garbage is then
// written into the session transcript and fed back to the model on every
// subsequent turn (which teaches it to imitate the broken format).
//
// This parser strips the markup out of the text stream and turns it into real
// ToolCall content blocks.

const VERTICAL_BAR = "\\uff5c";
const DSML_OPEN_MARKER = `<\\s*${VERTICAL_BAR}+\\s*DSML\\s*${VERTICAL_BAR}+`;
const DSML_CLOSE_MARKER = `<\\/\\s*${VERTICAL_BAR}+\\s*DSML\\s*${VERTICAL_BAR}+`;
const CALL_KEYWORDS = "(?:function_calls|calls|tool_calls)";

const OPEN_CALLS_RE = new RegExp(`${DSML_OPEN_MARKER}\\s*${CALL_KEYWORDS}\\s*>`);
const CLOSE_CALLS_RE = new RegExp(`${DSML_CLOSE_MARKER}\\s*${CALL_KEYWORDS}\\s*>`);
const INVOKE_OPEN_RE = new RegExp(`${DSML_OPEN_MARKER}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>`);
const INVOKE_BLOCK_RE = new RegExp(
  `${DSML_OPEN_MARKER}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/\\s*${VERTICAL_BAR}+\\s*DSML\\s*${VERTICAL_BAR}+\\s*invoke\\s*>`,
);
const PARAM_RE = new RegExp(
  `${DSML_OPEN_MARKER}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>` +
    `([\\s\\S]*?)<\\/\\s*${VERTICAL_BAR}+\\s*DSML\\s*${VERTICAL_BAR}+\\s*parameter\\s*>`,
  "g",
);

// Prefixes we must never emit as plain text, otherwise a chunk boundary would
// leak half a tag into the transcript. Generated: models vary the number of vertical
// bars and insert whitespace before the keyword.
const BAR_RUNS = ["｜", "｜｜"];
const GAPS = ["", " ", "\n"];
const DSML_KEYWORDS = ["calls", "function_calls", "tool_calls", "invoke", "parameter"];
const PARTIAL_TAG_CANDIDATES: string[] = [];
for (const leadingBars of BAR_RUNS) {
  for (const trailingBars of BAR_RUNS) {
    for (const gap of GAPS) {
      for (const keyword of DSML_KEYWORDS) {
        PARTIAL_TAG_CANDIDATES.push(`<${leadingBars}DSML${trailingBars}${gap}${keyword}>`);
        PARTIAL_TAG_CANDIDATES.push(`</${leadingBars}DSML${trailingBars}${gap}${keyword}>`);
      }
    }
  }
}

/** Upper bound for how much unfinished markup we are willing to hold back. */
const MAX_BUFFERED_CHARS = 1 << 20;

export interface DsmlToolCallDraft {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DsmlParserHandlers {
  onText: (text: string) => void;
  onToolCall: (call: DsmlToolCallDraft) => void;
}

function trailingPossibleTagPrefixLength(text: string): number {
  let maxLength = 0;
  for (const candidate of PARTIAL_TAG_CANDIDATES) {
    const limit = Math.min(text.length, candidate.length - 1);
    for (let len = limit; len > 0; len--) {
      if (text.endsWith(candidate.slice(0, len))) {
        maxLength = Math.max(maxLength, len);
        break;
      }
    }
  }
  return maxLength;
}

function coerceParameterValue(rawValue: string, stringFlag?: string): unknown {
  if (stringFlag === "true") return rawValue;
  if (stringFlag === "false") {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }
  // No explicit hint: accept JSON, fall back to the raw string.
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  PARAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAM_RE.exec(body)) !== null) {
    const [, paramName, stringFlag, rawValue] = match;
    args[paramName] = coerceParameterValue(rawValue, stringFlag);
  }
  return args;
}

/** Best-effort recovery of an invoke whose closing tag never arrived. */
export function salvagePartialInvoke(fragment: string): DsmlToolCallDraft | null {
  const openMatch = INVOKE_OPEN_RE.exec(fragment);
  if (!openMatch) return null;
  const name = openMatch[1];
  if (!name) return null;
  const body = fragment.slice(openMatch.index + openMatch[0].length);
  return {
    id: "",
    name,
    arguments: parseParameters(body),
  };
}

export class DsmlToolCallParser {
  private buffer = "";
  private inCalls = false;
  private seq = 0;

  constructor(private handlers: DsmlParserHandlers) {}

  processChunk(chunk: string): void {
    this.buffer += chunk;
    this.drain(false);
  }

  finalize(): void {
    this.drain(true);
    if (this.buffer.length === 0) return;

    const fragment = this.buffer;
    this.buffer = "";
    const salvaged = this.inCalls ? salvagePartialInvoke(fragment) : null;
    if (salvaged) {
      this.emit(salvaged);
      return;
    }
    this.handlers.onText(fragment);
  }

  private emit(call: DsmlToolCallDraft): void {
    this.seq += 1;
    this.handlers.onToolCall({
      id: call.id || `dsml_call_${this.seq}`,
      name: call.name,
      arguments: call.arguments,
    });
  }

  private drain(flush: boolean): void {
    while (this.buffer.length > 0) {
      if (this.inCalls) {
        const invokeMatch = INVOKE_BLOCK_RE.exec(this.buffer);
        if (invokeMatch) {
          const [full, name, body] = invokeMatch;
          // Anything between invokes is markup scaffolding: drop it.
          this.buffer = this.buffer.slice(invokeMatch.index + full.length);
          if (name) this.emit({ id: "", name, arguments: parseParameters(body) });
          continue;
        }

        const closeMatch = CLOSE_CALLS_RE.exec(this.buffer);
        if (closeMatch) {
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch[0].length);
          this.inCalls = false;
          continue;
        }

        if (!flush) {
          if (this.buffer.length <= MAX_BUFFERED_CHARS) return;
          // Way too much unfinished markup: give up on parsing it.
          const dump = this.buffer;
          this.buffer = "";
          this.inCalls = false;
          this.handlers.onText(dump);
          return;
        }

        // Stream ended mid-block: recover whatever invoke we got rather than dumping
        // raw markup into the transcript.
        const salvaged = salvagePartialInvoke(this.buffer);
        const leftover = salvaged ? "" : this.buffer;
        this.buffer = "";
        this.inCalls = false;
        if (salvaged) this.emit(salvaged);
        if (leftover) this.handlers.onText(leftover);
        return;
      }

      const openMatch = OPEN_CALLS_RE.exec(this.buffer);
      if (openMatch) {
        if (openMatch.index > 0) this.handlers.onText(this.buffer.slice(0, openMatch.index));
        this.buffer = this.buffer.slice(openMatch.index + openMatch[0].length);
        this.inCalls = true;
        continue;
      }

      const holdback = trailingPossibleTagPrefixLength(this.buffer);
      const safeLength = this.buffer.length - holdback;
      if (safeLength <= 0) return;
      this.handlers.onText(this.buffer.slice(0, safeLength));
      this.buffer = this.buffer.slice(safeLength);
    }
  }
}
