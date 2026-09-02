import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = (id: string, provider: string) => ({
    id,
    name: id,
    api: "qoder-api",
    provider,
    baseUrl: "https://example.test/",
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 32_768,
  });

  return {
    cachedCnModels: [model("qwen3.7-max", "qoder-cn")],
    refreshedCnModels: [model("qwen3.7-max", "qoder-cn"), model("qmodel_preview", "qoder-cn")],
    staticModels: [model("auto", "qoder")],
    staticCnModels: [model("auto", "qoder-cn")],
    resolveQoderIdentity: vi.fn(),
    updateQoderModelsCache: vi.fn(),
  };
});

vi.mock("../cosy.js", () => ({
  getQoderBaseUrl: (mode: string) => `https://${mode}.example.test/`,
  getQoderMode: () => "global",
  getQoderUserEmailFallback: () => "user@example.test",
  isQoderCNMode: (mode: string) => mode === "cn",
  toQoderCNFriendlyModel: (model: unknown) => model,
}));

vi.mock("../models.js", () => ({
  getCachedModels: (mode: string) => (mode === "cn" ? mocks.cachedCnModels : []),
  isCacheStale: (mode: string) => mode === "cn",
  qoderModelIdentity: (id: string) => ({ class: id.includes("deepseek") ? "deepseek" : "unknown" }),
  staticCnModels: mocks.staticCnModels,
  staticModels: mocks.staticModels,
  updateQoderModelsCache: mocks.updateQoderModelsCache,
}));

vi.mock("../oauth.js", () => ({
  loginQoder: vi.fn(),
  loginQoderCN: vi.fn(),
  refreshQoderToken: vi.fn(),
  refreshQoderTokenCN: vi.fn(),
  resolveQoderIdentity: mocks.resolveQoderIdentity,
}));

vi.mock("../stream.js", () => ({ streamQoder: vi.fn() }));
vi.mock("../usage.js", () => ({ fetchQoderUsage: vi.fn(), fetchQoderUsageCN: vi.fn() }));

import registerQoderExtension from "../index.js";

describe("Qoder extension model refresh", () => {
  beforeEach(() => {
    mocks.cachedCnModels = [mocks.refreshedCnModels[0]];
    mocks.resolveQoderIdentity.mockReset().mockResolvedValue({
      userID: "user-id",
      name: "User",
      email: "user@example.test",
    });
    mocks.updateQoderModelsCache.mockReset().mockImplementation(async (_access, _userID, _name, _email, mode) => {
      if (mode === "cn") mocks.cachedCnModels = mocks.refreshedCnModels;
    });
  });

  it("publishes newly fetched models to the current session registry", async () => {
    let sessionStart: ((event: unknown, context: unknown) => Promise<void>) | undefined;
    const authStorage = AuthStorage.inMemory({
      "qoder-cn": {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const pi = {
      on: vi.fn((event: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
        if (event === "session_start") sessionStart = handler;
      }),
      registerProvider: (providerID: string, config: Parameters<ModelRegistry["registerProvider"]>[1]) => {
        modelRegistry.registerProvider(providerID, config);
      },
    };

    registerQoderExtension(pi as never);
    expect(sessionStart).toBeDefined();
    expect(modelRegistry.getAll().some((model) => model.id === "qmodel_preview")).toBe(false);

    await sessionStart?.({ type: "session_start", reason: "startup" }, { modelRegistry });

    expect(modelRegistry.getAll().some((model) => model.id === "qmodel_preview")).toBe(true);
  });
});
