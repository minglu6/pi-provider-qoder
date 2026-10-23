import { afterEach, describe, expect, it, vi } from "vitest";
import { loadQoderPat } from "../pat-store.js";

const mocks = vi.hoisted(() => ({ getSecret: vi.fn() }));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    getSecret = mocks.getSecret;
  },
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  mocks.getSecret.mockReset();
});

describe("native PAT decoding", () => {
  it.each([
    ["win32", "utf16le"],
    ["darwin", "utf8"],
    ["linux", "utf8"],
  ] as const)("reads the password bytes stored by %s without corrupting the PAT", async (platform, encoding) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    mocks.getSecret.mockResolvedValue(Buffer.from("pt-native-roundtrip", encoding));
    expect(await loadQoderPat("account-a", "cn")).toBe("pt-native-roundtrip");
  });

  it.each([null, undefined])("keeps absent native credentials absent: %s", async (secret) => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mocks.getSecret.mockResolvedValue(secret);
    expect(await loadQoderPat("account-a", "cn")).toBeUndefined();
  });

  it("does not turn a locked Windows store into a missing PAT or expose its error payload", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mocks.getSecret.mockRejectedValue(new Error("locked store: pt-private-value"));
    const error = await loadQoderPat("account-a", "cn").catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("could not read the saved PAT");
    expect(String(error)).not.toContain("pt-private-value");
  });
});
