import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import { recoverDsml } from "./dsml.js";
import type { QoderContext } from "./transform.js";

export interface DsmlAttempt {
  complete: boolean;
  finishReason?: string;
  regeneration?: string;
  allowRecovery?: boolean;
}

function addUsage(target: Usage, previous: Usage): void {
  target.input += previous.input;
  target.output += previous.output;
  target.cacheRead += previous.cacheRead;
  target.cacheWrite += previous.cacheWrite;
  target.totalTokens += previous.totalTokens;
  target.cost.input += previous.cost.input;
  target.cost.output += previous.cost.output;
  target.cost.cacheRead += previous.cost.cacheRead;
  target.cost.cacheWrite += previous.cost.cacheWrite;
  target.cost.total += previous.cost.total;
}

function emitRecovered(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
    } else if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    } else {
      stream.push({ type: "thinking_start", contentIndex, partial: message });
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: message });
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
    }
  }
}

/** Hold uncommitted DeepSeek content so failed attempts never escape into history. */
export function streamWithDsmlRecovery(
  model: Model<Api>,
  context: QoderContext,
  tools: Tool[],
  options: SimpleStreamOptions | undefined,
  attempt: (context: QoderContext, inspection: DsmlAttempt) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  // Older host typings omit the constructor that their runtime exports.
  const runtime = PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream };
  const stream = new runtime.AssistantMessageEventStream();
  let current: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
  (async () => {
    let previousUsage: Usage | undefined;
    try {
      // Preserve valid tool/result pairs and caller-owned transcript objects.
      const cleanContext: QoderContext = {
        ...context,
        messages: context.messages.filter((message) => {
          if (message.role !== "assistant") return true;
          if (typeof message.content === "string") return recoverDsml(message.content, tools).kind === "text";
          if (message.content.some((block) => block.type === "toolCall")) return true;
          return !message.content.some(
            (block) =>
              block.type !== "toolCall" &&
              recoverDsml(block.type === "text" ? block.text : block.thinking, tools).kind !== "text",
          );
        }),
      };
      stream.push({ type: "start", partial: current });
      for (let index = 0; index < 2; index++) {
        options?.signal?.throwIfAborted();
        const inspection: DsmlAttempt = { complete: false, regeneration: index ? randomUUID() : undefined };
        const source = attempt(cleanContext, inspection);
        const pending: AssistantMessageEvent[] = [];
        let committed = false;
        for await (const event of source) {
          if (event.type === "start") continue;
          if (event.type === "done" || event.type === "error") {
            current = event.type === "done" ? event.message : event.error;
            continue;
          }
          if (event.type === "toolcall_start" && !committed) {
            committed = true;
            for (const buffered of pending) stream.push(buffered);
            pending.length = 0;
          }
          if (committed) stream.push(event);
          else pending.push(event);
        }
        current = await source.result();
        if (previousUsage) addUsage(current.usage, previousUsage);
        let malformed: string | undefined;
        let recovered = false;
        const content: AssistantMessage["content"] = [];
        if (
          !committed &&
          inspection.complete &&
          inspection.allowRecovery !== false &&
          current.stopReason !== "aborted" &&
          inspection.finishReason !== "length" &&
          (inspection.finishReason === undefined ||
            inspection.finishReason === "stop" ||
            inspection.finishReason === "tool_calls")
        ) {
          for (const block of current.content) {
            if (block.type === "toolCall") {
              content.push(block);
              continue;
            }
            const parsed = recoverDsml(block.type === "text" ? block.text : block.thinking, tools);
            if (parsed.kind === "malformed") {
              malformed = parsed.reason;
              break;
            }
            if (parsed.kind === "calls") {
              if (block.type === "thinking") {
                malformed = "DSML invocation leaked into reasoning";
                break;
              }
              recovered = true;
              content.push(...parsed.content);
            } else content.push(block);
          }
        }
        if (malformed) {
          previousUsage = current.usage;
          pending.length = 0;
          current.content = [];
          if (index === 0 && !options?.signal?.aborted) continue;
          current.stopReason = "error";
          current.errorMessage = `Qoder DSML recovery failed after one regeneration: ${malformed}. No tool call was dispatched.`;
        } else if (recovered) {
          current.content = content;
          current.stopReason = "toolUse";
          delete current.errorMessage;
          emitRecovered(stream, current);
        } else {
          for (const event of pending) stream.push(event);
        }
        if (current.stopReason === "error" || current.stopReason === "aborted") {
          stream.push({ type: "error", reason: current.stopReason, error: current });
        } else {
          stream.push({ type: "done", reason: current.stopReason, message: current });
        }
        stream.end();
        return;
      }
    } catch (error) {
      current.stopReason = options?.signal?.aborted ? "aborted" : "error";
      current.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: current.stopReason, error: current });
      stream.end();
    }
  })();
  return stream;
}
