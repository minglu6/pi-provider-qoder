import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";

// Narrowly recognize the checkpoint scaffold seen in the incident. XML examples,
// ordinary prose summaries and requested compactions must not be silently removed.
export function isConversationCheckpoint(text: string): boolean {
  const match = /^\s*<analysis>[\s\S]*?<\/analysis>\s*<summary>([\s\S]*)$/i.exec(text);
  if (!match) return false;
  const closing = match[1].toLowerCase().indexOf("</summary>");
  // A truncated checkpoint may lack its closing tag. An answer after the
  // checkpoint, however, is not this failure mode and must not be discarded.
  if (closing !== -1 && match[1].slice(closing + "</summary>".length).trim()) return false;
  const summary = closing === -1 ? match[1] : match[1].slice(0, closing);
  const headings = [
    /Primary Request and Intent|主要请求与意图/i,
    /Key Technical Concepts|关键技术概念/i,
    /Files and Code Sections|文件与代码段/i,
    /All User Messages|所有用户消息/i,
    /Pending Tasks|待办任务/i,
    /Current Work|当前工作/i,
    /Optional Next Step|可选的下一步/i,
  ];
  return headings.filter((heading) => heading.test(summary)).length >= 3;
}

export function requestsSummary(text: string): boolean {
  return /\b(?:summari[sz]e|summary|compaction|compact|recap|handoff|handover)\b|总结|摘要|概括|压缩|交接|汇总|回顾/i.test(
    text,
  );
}

function couldBeCheckpoint(text: string): boolean {
  const prefix = text.trimStart().toLowerCase();
  return "<analysis>".startsWith(prefix) || prefix.startsWith("<analysis>");
}

export type ResponseRecoveryReason = "checkpoint" | "incomplete";

/**
 * Hold only undecided response prefixes. Once ordinary text or a tool call is
 * seen, stream normally. Native reasoning is held until that decision, so a
 * rejected attempt cannot leak through start.partial or thinking events either.
 * Retry generation only, never execute tools or replay a rejected response.
 * Checkpoint and thinking-only failures share one retry, before public output.
 */
export function withResponseRecovery(
  createAttempt: (recovery?: ResponseRecoveryReason) => AssistantMessageEventStream,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();
  void (async () => {
    try {
      let recovery: ResponseRecoveryReason | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const source = createAttempt(recovery);
        let pending: AssistantMessageEvent[] = [];
        let text = "";
        let released = false;
        const release = () => {
          for (const event of pending) stream.push(event);
          pending = [];
          released = true;
        };
        for await (const event of source) {
          if (released) {
            stream.push(event);
            continue;
          }
          pending.push(event);
          if (event.type === "text_delta") text += event.delta;
          if (event.type === "toolcall_start" || (event.type === "text_delta" && !couldBeCheckpoint(text))) release();
        }
        const result = await source.result();
        if (released) return;
        if (signal?.aborted) {
          stream.push({
            type: "error",
            reason: "aborted",
            error: {
              ...result,
              content: [],
              stopReason: "aborted",
              errorMessage: "Qoder request aborted",
            },
          });
          return;
        }
        if (result.stopReason === "error" && result.errorMessage?.startsWith("QODER_INCOMPLETE_RESPONSE:")) {
          if (attempt === 0) {
            recovery = "incomplete";
            continue;
          }
          result.errorMessage += " Recovery generation also returned incomplete output; no further retry was made.";
        }
        if (isConversationCheckpoint(text)) {
          if (result.stopReason === "error" || result.stopReason === "aborted") {
            stream.push({ type: "error", reason: result.stopReason, error: { ...result, content: [] } });
            return;
          }
          if (attempt === 0) {
            recovery = "checkpoint";
            continue;
          }
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...result,
              content: [],
              stopReason: "error",
              errorMessage:
                "QODER_UNEXPECTED_SUMMARY: Recovery generation returned an unsolicited conversation checkpoint. No answer or tool call was accepted. Retry in a new session or switch models.",
            },
          });
          return;
        }
        release();
        return;
      }
    } finally {
      stream.end();
    }
  })();
  return stream;
}
