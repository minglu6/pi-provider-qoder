import { describe, expect, it } from "vitest";
import {
  applyQoderThinkingOptions,
  deriveQoderThinking,
  deriveQoderThinkingLevelMap,
  qoderModelIdentity,
  staticCnModels,
  staticModels,
  ZERO_COST,
} from "../models.js";

// ── staticModels ──────────────────────────────────────────────────────────

describe("staticModels", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(staticModels)).toBe(true);
    expect(staticModels.length).toBeGreaterThan(0);
  });

  it("has auto as first entry", () => {
    expect(staticModels[0].id).toBe("auto");
  });

  it("every model has required fields", () => {
    for (const m of staticModels) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.api).toBe("qoder-api");
      expect(m.provider).toBe("qoder");
      expect(m.baseUrl).toBeTruthy();
      expect(typeof m.reasoning).toBe("boolean");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.cost).toBe(ZERO_COST);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("has unique IDs", () => {
    const ids = staticModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DeepSeek V4 models declare high/max thinking efforts", () => {
    for (const id of ["dmodel", "dfmodel"]) {
      const m = staticModels.find((model) => model.id === id);
      expect(m).toBeTruthy();
      expect(m?.thinking).toEqual({ mode: "effort", efforts: ["high", "max"], defaultLevel: "max" });
    }
  });
});

// ── staticCnModels ────────────────────────────────────────────────────────

describe("staticCnModels", () => {
  it("is only a cold-start auto fallback; concrete models come from the live catalog", () => {
    expect(staticCnModels).toEqual([
      expect.objectContaining({
        id: "auto",
        provider: "qoder-cn",
        api: "qoder-api",
      }),
    ]);
    expect(staticCnModels).toHaveLength(1);
  });
});

// ── deriveQoderThinking ───────────────────────────────────────────────────

describe("deriveQoderThinking", () => {
  it("maps upstream effort entries to a thinking surface with default", () => {
    const thinking = deriveQoderThinking(
      {
        key: "dfmodel",
        thinking_config: {
          enabled: {
            efforts: {
              high: { description: "High thinking intensity" },
              max: { description: "Maximum", is_default: true },
            },
          },
        },
      },
      true,
    );
    expect(thinking).toEqual({ mode: "effort", efforts: ["high", "max"], defaultLevel: "max" });
  });

  it("orders known effort labels ascending", () => {
    const thinking = deriveQoderThinking(
      {
        key: "qmodel",
        thinking_config: {
          enabled: {
            efforts: {
              xhigh: { is_default: true },
              low: {},
              medium: {},
            },
          },
        },
      },
      true,
    );
    expect(thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "xhigh"], defaultLevel: "xhigh" });
  });

  it("returns undefined without default effort", () => {
    const thinking = deriveQoderThinking(
      {
        key: "dfmodel",
        thinking_config: { enabled: { efforts: { high: {} } } },
      },
      true,
    );
    expect(thinking).toEqual({ mode: "effort", efforts: ["high"] });
  });

  it("returns undefined for non-reasoning models", () => {
    expect(
      deriveQoderThinking({ key: "lite", thinking_config: { enabled: { efforts: { high: {} } } } }, false),
    ).toBeUndefined();
  });

  it("returns undefined without an efforts surface", () => {
    expect(deriveQoderThinking({ key: "auto", thinking_config: { enabled: {} } }, true)).toBeUndefined();
    expect(deriveQoderThinking({ key: "auto" }, true)).toBeUndefined();
  });
});

describe("deriveQoderThinkingLevelMap", () => {
  it("marks unsupported pi levels null so sticky high is clamped away", () => {
    const map = deriveQoderThinkingLevelMap(
      {
        key: "qmodel_38max",
        thinking_config: {
          disabled: {},
          enabled: {
            is_default: true,
            efforts: {
              xhigh: { is_default: true },
              low: {},
              medium: {},
            },
          },
        },
      },
      true,
    );
    expect(map).toEqual({
      off: "off",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    });
  });

  it("does not invent effort levels for toggle-only catalogs", () => {
    expect(
      deriveQoderThinkingLevelMap(
        { key: "auto", thinking_config: { disabled: {}, enabled: { is_default: true } } },
        true,
      ),
    ).toBeUndefined();
    expect(deriveQoderThinkingLevelMap({ key: "auto" }, true)).toBeUndefined();
  });

  it("does not expose off when the catalog cannot disable thinking", () => {
    const map = deriveQoderThinkingLevelMap({ thinking_config: { enabled: { efforts: { high: {} } } } }, true);
    expect(map?.off).toBeNull();
    expect(map?.high).toBe("high");
  });

  it("returns undefined for non-reasoning models", () => {
    expect(
      deriveQoderThinkingLevelMap({ thinking_config: { disabled: {}, enabled: { efforts: { high: {} } } } }, false),
    ).toBeUndefined();
  });
});

describe("applyQoderThinkingOptions", () => {
  const entry = Object.freeze({
    key: "dfmodel",
    is_reasoning: false,
    source: "system",
    thinking_config: Object.freeze({
      disabled: Object.freeze({ is_default: true, description: "No thinking" }),
      enabled: Object.freeze({
        is_default: false,
        description: "Thinking",
        efforts: Object.freeze({
          high: Object.freeze({ description: "High", is_default: true }),
          max: Object.freeze({ description: "Maximum", is_default: false }),
        }),
      }),
    }),
  });

  it("keeps the catalog default when reasoning is undefined", () => {
    expect(applyQoderThinkingOptions(entry, undefined)).toEqual({ modelConfig: entry });
    expect(applyQoderThinkingOptions(entry, undefined).modelConfig).toBe(entry);
  });

  it.each([false, "off"])("explicitly disables thinking for %s", (reasoning) => {
    const enabledEntry = {
      ...entry,
      is_reasoning: true,
      thinking_config: {
        disabled: { ...entry.thinking_config.disabled, is_default: false },
        enabled: { ...entry.thinking_config.enabled, is_default: true },
      },
    };
    const result = applyQoderThinkingOptions(enabledEntry, reasoning);
    expect(result.modelConfig.is_reasoning).toBe(false);
    expect(result.modelConfig.thinking_config?.disabled?.is_default).toBe(true);
    expect(result.modelConfig.thinking_config?.enabled?.is_default).toBe(false);
    expect(result.modelConfig.thinking_config?.enabled?.efforts).toBe(entry.thinking_config.enabled.efforts);
    expect(result).not.toHaveProperty("effort");
    expect(enabledEntry.thinking_config.enabled.is_default).toBe(true);
  });

  it("explicitly enables thinking without selecting a different effort", () => {
    const result = applyQoderThinkingOptions(entry, true);
    expect(result.modelConfig.is_reasoning).toBe(true);
    expect(result.modelConfig.thinking_config?.disabled?.is_default).toBe(false);
    expect(result.modelConfig.thinking_config?.enabled?.is_default).toBe(true);
    expect(result.modelConfig.thinking_config?.enabled?.efforts).toBe(entry.thinking_config.enabled.efforts);
    expect(result).not.toHaveProperty("effort");
  });

  it("selects a supported effort and enables thinking", () => {
    const result = applyQoderThinkingOptions(entry, "max");
    expect(result.effort).toBe("max");
    expect(result.modelConfig.is_reasoning).toBe(true);
    expect(result.modelConfig.thinking_config?.disabled?.is_default).toBe(false);
    expect(result.modelConfig.thinking_config?.enabled?.is_default).toBe(true);
    expect(result.modelConfig.thinking_config?.enabled?.efforts).toEqual({
      high: { description: "High", is_default: false },
      max: { description: "Maximum", is_default: true },
    });
  });

  it.each([
    "ultra",
    "xhigh",
    "constructor",
    "toString",
    "true",
    "false",
    "",
  ])("retains the catalog default for unsupported effort %s", (reasoning) => {
    const result = applyQoderThinkingOptions(entry, reasoning);
    expect(result.modelConfig).toBe(entry);
    expect(result).not.toHaveProperty("effort");
  });

  it("enables toggle-only catalogs without inventing efforts or disabled mode", () => {
    const result = applyQoderThinkingOptions(
      { is_reasoning: false, thinking_config: { enabled: { is_default: false } } },
      true,
    );
    expect(result).toEqual({
      modelConfig: { is_reasoning: true, thinking_config: { enabled: { is_default: true } } },
    });
  });

  it("selects effort without inventing a disabled capability", () => {
    const result = applyQoderThinkingOptions({ thinking_config: { enabled: { efforts: { high: {} } } } }, "high");
    expect(result.effort).toBe("high");
    expect(result.modelConfig.thinking_config).not.toHaveProperty("disabled");
    expect(result.modelConfig.thinking_config?.enabled?.is_default).toBe(true);
  });

  it("disables a disabled-only catalog without inventing an enabled capability", () => {
    const result = applyQoderThinkingOptions(
      { is_reasoning: true, thinking_config: { disabled: { is_default: false } } },
      false,
    );
    expect(result).toEqual({
      modelConfig: { is_reasoning: false, thinking_config: { disabled: { is_default: true } } },
    });
  });

  it.each([false, "off"])("rejects %s when the catalog cannot disable thinking", (reasoning) => {
    expect(() => applyQoderThinkingOptions({ key: "always-on", thinking_config: { enabled: {} } }, reasoning)).toThrow(
      'Qoder model "always-on" does not support disabling thinking.',
    );
  });

  it("rejects true when the catalog cannot enable thinking", () => {
    expect(() => applyQoderThinkingOptions({ key: "always-off", thinking_config: { disabled: {} } }, true)).toThrow(
      'Qoder model "always-off" does not support enabling thinking.',
    );
  });

  it("keeps unknown catalog defaults but rejects unsupported explicit toggles", () => {
    const unknownEntry = { key: "unknown", is_reasoning: false };
    expect(applyQoderThinkingOptions(unknownEntry, undefined).modelConfig).toBe(unknownEntry);
    expect(applyQoderThinkingOptions(unknownEntry, "high").modelConfig).toBe(unknownEntry);
    for (const reasoning of [false, "off", true]) {
      expect(() => applyQoderThinkingOptions(unknownEntry, reasoning)).toThrow(/does not support/);
    }
  });

  it("does not mutate frozen catalog modes, effort defaults, or metadata", () => {
    const configured = applyQoderThinkingOptions(entry, "max").modelConfig;
    expect(configured).not.toBe(entry);
    expect(configured.thinking_config).not.toBe(entry.thinking_config);
    expect(configured.thinking_config?.enabled?.efforts).not.toBe(entry.thinking_config.enabled.efforts);
    expect(configured.source).toBe("system");
    expect(configured.thinking_config?.disabled?.description).toBe("No thinking");
    expect(configured.thinking_config?.enabled?.description).toBe("Thinking");
    expect(entry.is_reasoning).toBe(false);
    expect(entry.thinking_config.disabled.is_default).toBe(true);
    expect(entry.thinking_config.enabled.is_default).toBe(false);
    expect(entry.thinking_config.enabled.efforts.high.is_default).toBe(true);
    expect(entry.thinking_config.enabled.efforts.max.is_default).toBe(false);
  });
});

// ── ZERO_COST ─────────────────────────────────────────────────────────────

describe("ZERO_COST", () => {
  it("has all zero values", () => {
    expect(ZERO_COST).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ZERO_COST)).toBe(true);
  });
});

// ── qoderModelIdentity ─────────────────────────────────────────────────────

describe("qoderModelIdentity", () => {
  it("classifies deepseek v4 variants with families", () => {
    expect(qoderModelIdentity("deepseek-v4-flash")).toEqual({ class: "deepseek", family: "flash" });
    expect(qoderModelIdentity("deepseek-v4-pro")).toEqual({ class: "deepseek", family: "pro" });
  });

  it("classifies glm and qwen without family", () => {
    expect(qoderModelIdentity("glm-5.2")).toEqual({ class: "glm" });
    expect(qoderModelIdentity("qwen3.7-plus")).toEqual({ class: "qwen" });
  });

  it("falls back to unknown for aliases", () => {
    expect(qoderModelIdentity("auto")).toEqual({ class: "unknown" });
    expect(qoderModelIdentity("dfmodel")).toEqual({ class: "unknown" });
  });
});
