import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createQoderAuthRecovery } from "../auth-recovery.js";

function fixture() {
  const storage = AuthStorage.inMemory({
    "qoder-recovery-test": {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() + 60_000,
    },
    unrelated: { type: "api_key", key: "untouched" },
  });
  const refresh = vi.fn(async () => ({
    access: "new-access",
    refresh: "rotated-refresh",
    expires: Date.now() + 60_000,
  }));
  ModelRegistry.inMemory(storage).registerProvider("qoder-recovery-test", {
    oauth: {
      name: "Recovery Test",
      login: async () => {
        throw new Error("Interactive login must not run");
      },
      refreshToken: refresh,
      getApiKey: (credential) => credential.access,
    },
  });
  return { storage, refresh, renew: createQoderAuthRecovery(storage, "qoder-recovery-test") };
}

describe("host-owned credential recovery", () => {
  it("forces renewal before local expiry, persists rotated credentials and coalesces concurrent failures", async () => {
    const { storage, refresh, renew } = fixture();
    expect(await Promise.all([renew("old-access"), renew("old-access")])).toEqual(["new-access", "new-access"]);
    storage.reload();
    expect(storage.get("qoder-recovery-test")).toMatchObject({ access: "new-access", refresh: "rotated-refresh" });
    expect(storage.get("unrelated")).toEqual({ type: "api_key", key: "untouched" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await renew("old-access")).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects fixed API keys without replacing them or attempting OAuth", async () => {
    const { storage, refresh, renew } = fixture();
    storage.set("qoder-recovery-test", { type: "api_key", key: "fixed" });
    await expect(renew("fixed")).rejects.toThrow("OAuth");
    expect(storage.get("qoder-recovery-test")).toEqual({ type: "api_key", key: "fixed" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not claim success when the host returns the rejected token", async () => {
    const { refresh, renew } = fixture();
    refresh.mockResolvedValue({ access: "old-access", refresh: "rotated-refresh", expires: Date.now() + 60_000 });
    await expect(renew("old-access")).rejects.toThrow("new access token");
  });
});
