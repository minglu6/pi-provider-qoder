import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/** OpenAI-compatible usage returned inside Qoder's SSE body. Counts are snapshots. */
export interface QoderTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function applyQoderUsage(output: AssistantMessage, usage: QoderTokenUsage, model: Model<Api>): void {
  const hit = count(usage.prompt_tokens_details?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? 0;
  const prompt = count(usage.prompt_tokens) ?? (count(usage.prompt_cache_miss_tokens) ?? 0) + hit;
  const cached = Math.min(prompt, hit);
  output.usage.input = prompt - cached;
  output.usage.cacheRead = cached;
  output.usage.output = count(usage.completion_tokens) ?? 0;
  output.usage.totalTokens = count(usage.total_tokens) ?? prompt + output.usage.output;
  for (const kind of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    output.usage.cost[kind] = (output.usage[kind] * model.cost[kind]) / 1_000_000;
  }
  const cost = output.usage.cost;
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

export function qoderStopReason(reason: string | undefined, hasTools: boolean): "stop" | "toolUse" | "length" {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      if (!hasTools) throw new Error("Qoder finished with tool_calls but returned no tool call");
      return "toolUse";
    case undefined:
    case "stop":
      return hasTools ? "toolUse" : "stop";
    default:
      throw new Error(`Qoder stopped with unsupported finish_reason: ${reason}`);
  }
}
