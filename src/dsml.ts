import { randomUUID } from "node:crypto";
import type { TextContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";

export type DsmlResult =
  | { kind: "text" }
  | { kind: "malformed"; reason: string }
  | { kind: "calls"; content: Array<TextContent | ToolCall> };

const marker = "(?:｜DSML｜|｜｜DSML｜｜)\\s*";
const wrapperOpen = new RegExp(`^<${marker}(calls|tool_calls|function_calls)>`, "u");
const invokeOpen = new RegExp(`^<${marker}invoke([^>]*)>`, "u");
const parameterOpen = new RegExp(`^<${marker}parameter([^>]*)>`, "u");
const parameterClose = new RegExp(`</${marker}parameter>`, "u");
const invokeClose = new RegExp(`^</${marker}invoke>`, "u");
const wrapperClose = new RegExp(`^</${marker}(calls|tool_calls|function_calls)>`, "u");
const candidate = new RegExp(`(^|\\n)[ \\t]*<${marker}(?:calls>|tool_calls>|function_calls>|invoke\\s+name=)`, "gu");
const trailer = new RegExp(
  `</${marker}parameter>\\s*</${marker}invoke>\\s*</${marker}(?:calls|tool_calls|function_calls)>\\s*$`,
  "u",
);

// Mask examples without changing offsets. Protocol values are read from the
// original string only after a real candidate has been selected.
function maskExamples(text: string): string {
  let fence: { char: string; length: number } | undefined;
  return text
    .split("\n")
    .map((line) => {
      const run = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence) {
        if (run && run[1][0] === fence.char && run[1].length >= fence.length && !run[2].trim()) fence = undefined;
        return " ".repeat(line.length);
      }
      if (run) {
        fence = { char: run[1][0], length: run[1].length };
        return " ".repeat(line.length);
      }
      if (/^\s*>/u.test(line)) return " ".repeat(line.length);
      return line.replace(/(`+)([\s\S]*?)(\1|$)/gu, (value: string) => " ".repeat(value.length));
    })
    .join("\n");
}

function attributes(raw: string, allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let rest = raw;
  while (rest.trim()) {
    const attribute = /^\s+([a-z]+)="([^"]*)"/u.exec(rest);
    if (!attribute || !allowed.includes(attribute[1]) || Object.hasOwn(result, attribute[1])) {
      throw new Error("Invalid or duplicate DSML attribute");
    }
    result[attribute[1]] = attribute[2];
    rest = rest.slice(attribute[0].length);
  }
  return result;
}

/** Recover only complete, unquoted DSML calls to tools offered on this request. */
export function recoverDsml(text: string, tools: Tool[]): DsmlResult {
  if (!tools.length || !text.includes("DSML")) return { kind: "text" };
  const masked = maskExamples(text);
  candidate.lastIndex = 0;
  const first = candidate.exec(masked);
  const hasTrailer = trailer.test(masked);
  if (!first) return hasTrailer ? { kind: "malformed", reason: "Dangling DSML tool-call trailer" } : { kind: "text" };
  // A wrapper mentioned on its own is not a call.
  const firstIndex = first.index + first[0].indexOf("<");
  if (!new RegExp(`<${marker}invoke\\s+name=`, "u").test(masked.slice(firstIndex))) {
    return hasTrailer ? { kind: "malformed", reason: "DSML trailer without an invocation" } : { kind: "text" };
  }

  try {
    const content: Array<TextContent | ToolCall> = [];
    let cursor = firstIndex;
    let emitted = 0;
    const whitespace = () => {
      const spaces = /^\s*/u.exec(text.slice(cursor));
      cursor += spaces?.[0].length ?? 0;
    };
    const parseInvoke = (): ToolCall => {
      const open = invokeOpen.exec(text.slice(cursor));
      if (!open) throw new Error("Incomplete DSML invocation");
      const attrs = attributes(open[1], ["name"]);
      const name = attrs.name;
      if (!name || !tools.some((tool) => tool.name === name))
        throw new Error("DSML invocation names an undeclared tool");
      cursor += open[0].length;
      const args: Record<string, unknown> = Object.create(null);
      whitespace();
      while (!invokeClose.test(text.slice(cursor))) {
        const parameter = parameterOpen.exec(text.slice(cursor));
        if (!parameter) throw new Error("Incomplete DSML parameter or invocation");
        const attrs = attributes(parameter[1], ["name", "string"]);
        const key = attrs.name;
        if (!key || ["__proto__", "prototype", "constructor"].includes(key) || Object.hasOwn(args, key)) {
          throw new Error("Invalid or duplicate DSML parameter name");
        }
        if (attrs.string !== undefined && attrs.string !== "true" && attrs.string !== "false") {
          throw new Error("Invalid DSML string attribute");
        }
        cursor += parameter[0].length;
        const close = parameterClose.exec(text.slice(cursor));
        if (!close) throw new Error("Incomplete DSML parameter value");
        const value = text.slice(cursor, cursor + close.index);
        args[key] = attrs.string === "false" ? JSON.parse(value) : value;
        cursor += close.index + close[0].length;
        whitespace();
      }
      const close = invokeClose.exec(text.slice(cursor));
      if (!close) throw new Error("Incomplete DSML invocation");
      cursor += close[0].length;
      const call: ToolCall = { type: "toolCall", id: `call_${randomUUID()}`, name, arguments: args };
      // Use the host's schema implementation, but never silently coerce a
      // recovered command, path, flag or argument type.
      const validated: unknown = PiAi.validateToolCall(tools, call);
      if (JSON.stringify(validated) !== JSON.stringify(args)) throw new Error("DSML arguments require schema coercion");
      return call;
    };

    while (cursor < text.length) {
      if (cursor > emitted) content.push({ type: "text", text: text.slice(emitted, cursor) });
      const wrapper = wrapperOpen.exec(text.slice(cursor));
      if (wrapper) {
        cursor += wrapper[0].length;
        whitespace();
      }
      let count = 0;
      while (invokeOpen.test(text.slice(cursor))) {
        content.push(parseInvoke());
        count++;
        whitespace();
      }
      if (!count) throw new Error("DSML wrapper contains no complete invocation");
      const close = wrapperClose.exec(text.slice(cursor));
      if (wrapper && (!close || close[1] !== wrapper[1])) throw new Error("Missing or mismatched DSML wrapper close");
      if (close) cursor += close[0].length;
      emitted = cursor;
      candidate.lastIndex = cursor;
      const next = candidate.exec(masked);
      if (!next) break;
      cursor = next.index + next[0].indexOf("<");
    }
    const suffix = text.slice(emitted);
    if (new RegExp(`</?${marker}`, "u").test(maskExamples(suffix)))
      throw new Error("Unconsumed DSML protocol fragment");
    if (suffix) content.push({ type: "text", text: suffix });
    return { kind: "calls", content };
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : String(error) };
  }
}
