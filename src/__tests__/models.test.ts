import { describe, expect, it } from "vitest";
import { deriveQoderThinking, qoderModelIdentity, staticCnModels, staticModels, withQoderThinkingEffort, ZERO_COST } from "../models.js";

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
  it("is a non-empty array", () => {
    expect(Array.isArray(staticCnModels)).toBe(true);
    expect(staticCnModels.length).toBeGreaterThan(0);
  });

  it("has auto as first entry", () => {
    expect(staticCnModels[0].id).toBe("auto");
  });

  it("every CN model has required fields", () => {
    for (const m of staticCnModels) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.api).toBe("qoder-api");
      expect(m.provider).toBe("qoder-cn");
      expect(m.baseUrl).toContain("qoder.com.cn");
      expect(typeof m.reasoning).toBe("boolean");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.cost).toBe(ZERO_COST);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("has unique IDs", () => {
    const ids = staticCnModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every CN model has a description", () => {
    for (const m of staticCnModels) {
      expect(m.description).toBeTruthy();
    }
  });

  it("CN DeepSeek V4 models declare high/max thinking efforts", () => {
    for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
      const m = staticCnModels.find((model) => model.id === id);
      expect(m).toBeTruthy();
      expect(m?.reasoning).toBe(true);
      expect(m?.supportsEffort).toBe(true);
      expect(m?.thinking).toEqual({ mode: "effort", efforts: ["high", "max"], defaultLevel: "max" });
    }
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

describe("withQoderThinkingEffort", () => {
  const entry = {
    key: "dfmodel",
    is_reasoning: false,
    thinking_config: {
      disabled: { is_default: true },
      enabled: {
        is_default: false,
        efforts: {
          high: { description: "High", is_default: true },
          max: { description: "Maximum" },
        },
      },
    },
  };

  it("selects max explicitly and enables reasoning", () => {
    const configured = withQoderThinkingEffort(entry, "max");
    expect(configured.is_reasoning).toBe(true);
    expect(configured.thinking_config?.disabled?.is_default).toBe(false);
    expect(configured.thinking_config?.enabled?.is_default).toBe(true);
    expect(configured.thinking_config?.enabled?.efforts?.high?.is_default).toBe(false);
    expect(configured.thinking_config?.enabled?.efforts?.max?.is_default).toBe(true);
  });

  it("rejects an unsupported effort", () => {
    expect(() => withQoderThinkingEffort(entry, "ultra" as "max")).toThrow(
      "does not support thinking effort ultra",
    );
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
