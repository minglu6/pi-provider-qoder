import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderCNFriendlyModelInfo,
  getQoderMode,
  getQoderModelListURL,
  isQoderCNMode,
  logCosyRequest,
  logCosyResponse,
} from "./cosy.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface QoderThinkingDef {
  mode: "effort";
  efforts: string[];
  defaultLevel?: string;
}

/** Pi thinking levels that the host can display / clamp against. */
export type QoderThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Maps pi thinking levels to upstream effort labels.
 * `null` marks a level unsupported so the host hides/clamps it.
 */
export type QoderThinkingLevelMap = Partial<Record<QoderThinkingLevel, string | null>>;

const PI_THINKING_LEVELS: readonly QoderThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_config?: Record<string, { token_count?: number }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: {
    disabled?: {
      is_default?: boolean;
      [key: string]: unknown;
    };
    enabled?: {
      is_default?: boolean;
      efforts?: Record<string, { description?: string; is_default?: boolean; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  source?: string;
  [key: string]: unknown;
}

export interface QoderModelDef {
  id: string;
  name: string;
  api: "qoder-api";
  provider: "qoder" | "qoder-cn";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  /** Explicit thinking effort surface forwarded to the host (OMP thinking levels). */
  thinking?: QoderThinkingDef;
  /** Pi uses this to hide unsupported levels (e.g. `high`) and clamp sticky defaults. */
  thinkingLevelMap?: QoderThinkingLevelMap;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

function getQoderCachePath(mode?: string): string {
  return join(
    homedir(),
    ".pi",
    "agent",
    isQoderCNMode(mode) ? "qoder-cn-models-cache.json" : "qoder-models-cache.json",
  );
}

export const staticModels: QoderModelDef[] = [
  {
    id: "auto",
    name: "Qoder Auto",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "ultimate",
    name: "Qoder Ultimate",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "performance",
    name: "Qoder Performance",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "efficient",
    name: "Qoder Efficient",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "lite",
    name: "Qoder Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "qmodel",
    name: "Qwen3.7 Plus (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7 Max (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dmodel",
    name: "DeepSeek V4 Pro (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "dfmodel",
    name: "DeepSeek V4 Flash (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gm51model",
    name: "GLM 5.1 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
  },
  {
    id: "kmodel",
    name: "Kimi K2.6 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 32768,
  },
  {
    id: "mmodel",
    name: "MiniMax M3 (Qoder)",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
];

export const staticCnModels: QoderModelDef[] = [
  {
    id: "auto",
    name: "Auto · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
    description: "Qoder CN smart routing; live catalog is the source of truth for concrete models.",
  },
];

/** Preferred display/order ladder for known Qoder effort labels. */
const QODER_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

function sortQoderEfforts(efforts: string[]): string[] {
  return [...efforts].sort((a, b) => {
    const ia = (QODER_EFFORT_ORDER as readonly string[]).indexOf(a);
    const ib = (QODER_EFFORT_ORDER as readonly string[]).indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Forward the upstream thinking effort surface as explicit model metadata
 * so the host offers exactly the wire-supported levels instead of inferring
 * a generic fallback ladder.
 */
export function deriveQoderThinking(entry: QoderModelEntry, isReasoning: boolean): QoderThinkingDef | undefined {
  if (!isReasoning) return undefined;
  const effortsObj = entry.thinking_config?.enabled?.efforts;
  if (!effortsObj || typeof effortsObj !== "object") return undefined;
  const efforts = sortQoderEfforts(Object.keys(effortsObj));
  if (efforts.length === 0) return undefined;
  const defaultEffort = Object.entries(effortsObj).find(([, cfg]) => cfg?.is_default)?.[0];
  return {
    mode: "effort",
    efforts,
    ...(defaultEffort ? { defaultLevel: defaultEffort } : {}),
  };
}

/**
 * Build a pi `thinkingLevelMap` from the live catalog efforts.
 * Unsupported host levels (e.g. sticky `high` on a model that only has
 * `xhigh`/`medium`/`low`) are marked `null` so pi clamps/hides them.
 */
export function deriveQoderThinkingLevelMap(
  entry: QoderModelEntry,
  isReasoning: boolean,
): QoderThinkingLevelMap | undefined {
  if (!isReasoning) return undefined;
  const effortsObj = entry.thinking_config?.enabled?.efforts;
  if (!effortsObj || typeof effortsObj !== "object") return undefined;
  const supported = new Set(Object.keys(effortsObj));
  if (supported.size === 0) return undefined;

  const map: QoderThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    if (level === "off") {
      // Prefer an explicit off when the catalog advertises a disabled mode.
      map.off = entry.thinking_config?.disabled ? "off" : null;
      continue;
    }
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

/**
 * Extract a concrete thinking-effort label from the host `reasoning` option.
 * Booleans / `off` are not effort levels — they only toggle thinking.
 */
export function resolveRequestedThinkingEffort(reasoning: unknown): string | undefined {
  if (typeof reasoning !== "string") return undefined;
  if (reasoning === "off" || reasoning === "true" || reasoning === "false") return undefined;
  return reasoning.length > 0 ? reasoning : undefined;
}

export function qoderSupportsThinkingEffort(entry: QoderModelEntry, effort: string): boolean {
  return !!entry.thinking_config?.enabled?.efforts?.[effort];
}

/** Model identity, mirroring the host catalog's class/family classification. */
export interface QoderModelIdentity {
  class: string;
  family?: string;
}

/**
 * Host (omp v18) reads `model.identity.class` on stream paths without null
 * guards; plugin models must carry an identity or the turn dies with
 * "undefined is not an object (evaluating 'e.identity.class')".
 */
export function qoderModelIdentity(id: string): QoderModelIdentity {
  const lower = id.toLowerCase();
  if (lower.includes("deepseek")) {
    if (lower.includes("v4") && lower.includes("flash")) return { class: "deepseek", family: "flash" };
    if (lower.includes("v4") && lower.includes("pro")) return { class: "deepseek", family: "pro" };
    if (lower.includes("v4")) return { class: "deepseek", family: "v4" };
    if (lower.includes("v3")) return { class: "deepseek", family: "v3" };
    if (lower.includes("r1")) return { class: "deepseek", family: "r1" };
    return { class: "deepseek" };
  }
  if (lower.includes("glm")) return { class: "glm" };
  if (lower.includes("qwen")) return { class: "qwen" };
  if (lower.includes("kimi")) return { class: "kimi" };
  return { class: "unknown" };
}

/**
 * Apply a host-selected thinking effort onto the upstream model_config.
 * If the model does not advertise that effort, leave the entry unchanged so
 * the request keeps the catalog default instead of inventing levels or crashing.
 */
export function withQoderThinkingEffort(entry: QoderModelEntry, effort: string): QoderModelEntry {
  const configuredEfforts = entry.thinking_config?.enabled?.efforts;
  if (!configuredEfforts?.[effort]) {
    return entry;
  }
  const efforts = Object.fromEntries(
    Object.entries(configuredEfforts).map(([name, config]) => [name, { ...config, is_default: name === effort }]),
  );
  return {
    ...entry,
    is_reasoning: true,
    thinking_config: {
      ...entry.thinking_config,
      disabled: {
        ...entry.thinking_config?.disabled,
        is_default: false,
      },
      enabled: {
        ...entry.thinking_config?.enabled,
        is_default: true,
        efforts,
      },
    },
  };
}

export function getCachedModels(mode?: string): QoderModelDef[] {
  const cachePath = getQoderCachePath(mode);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      if (data && Array.isArray(data.models)) {
        return data.models;
      }
    } catch {}
  }
  return isQoderCNMode(mode) ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelKey: string, mode?: string): QoderModelEntry | null {
  const cachePath = getQoderCachePath(mode);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as {
      configs?: Record<string, QoderModelEntry>;
    };
    const configs = data.configs;
    if (!configs || typeof configs !== "object") return null;
    if (configs[modelKey]) return configs[modelKey] as QoderModelEntry;

    // Host list id is the display label; resolve back to the catalog entry by
    // recomputing that label from each entry's display_name (no hardcoded map).
    if (isQoderCNMode(mode)) {
      for (const entry of Object.values(configs)) {
        const wireKey = entry?.key;
        if (!wireKey) continue;
        const listId = getQoderCNFriendlyModelInfo(wireKey, entry.display_name || wireKey).id;
        if (listId === modelKey || wireKey === modelKey) return entry;
      }
    }
  } catch {}
  return null;
}

export function isCacheStale(mode?: string): boolean {
  const cachePath = getQoderCachePath(mode);
  if (!existsSync(cachePath)) return true;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!data || typeof data.updatedAt !== "number") return true;
    // Stale if older than 1 hour
    return Date.now() - data.updatedAt > 3600_000;
  } catch {
    return true;
  }
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: string = getQoderMode(),
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    const headers = buildAuthHeaders(null, modelListURL, {
      userID,
      authToken,
      name,
      email,
    });
    logCosyRequest("GET", modelListURL, headers);

    const response = await fetch(modelListURL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    });
    await logCosyResponse(modelListURL, response);

    if (!response.ok) {
      return;
    }

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};
    const usedListIds = new Set<string>();

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable) continue;

      const display = entry.display_name || key;
      let ctxLen = entry.max_input_tokens || 180000;
      if (entry.context_config && typeof entry.context_config === "object") {
        for (const configVal of Object.values(entry.context_config)) {
          if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
            const tc = configVal.token_count;
            if (tc > ctxLen) {
              ctxLen = tc;
            }
          }
        }
      }
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinking = deriveQoderThinking(entry, isReasoning);
      const thinkingLevelMap = deriveQoderThinkingLevelMap(entry, isReasoning);
      let modelInfo = isQoderCNMode(mode)
        ? getQoderCNFriendlyModelInfo(key, display)
        : { id: display || key, name: display || key };
      if (usedListIds.has(modelInfo.id) && modelInfo.id !== key) {
        modelInfo = { ...modelInfo, id: `${modelInfo.id} (${key})` };
      }
      usedListIds.add(modelInfo.id);

      configs[key] = entry;
      if (modelInfo.id !== key) configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        thinking,
        thinkingLevelMap,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: entry.max_output_tokens || 32768,
      });
    }

    if (newModels.length === 0) return;

    // Ensure auto is present
    if (!newModels.some((m) => m.id === "auto")) {
      newModels.unshift({
        id: "auto",
        name: isQoderCNMode(mode) ? "Auto · Qoder CN" : "Qoder Auto",
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 180000,
        maxTokens: 32768,
      });
    }

    // Keep prior host ids that pointed at the same wire key so old sessions still resolve.
    const cachePath = getQoderCachePath(mode);
    if (existsSync(cachePath)) {
      try {
        const previous = JSON.parse(readFileSync(cachePath, "utf8")) as {
          configs?: Record<string, QoderModelEntry>;
        };
        for (const [previousId, previousEntry] of Object.entries(previous.configs || {})) {
          const wireKey = previousEntry?.key;
          if (!wireKey || previousId === wireKey || !configs[wireKey] || configs[previousId]) continue;
          configs[previousId] = configs[wireKey];
        }
      } catch {}
    }

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
  } catch {}
}
