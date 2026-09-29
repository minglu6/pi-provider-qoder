import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadQoderPat, saveQoderPat } from "../pat-store.js";

// A real Android installation cannot load this package. Fail if any path tries.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("Native credential store unavailable");
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "android", configurable: true });
  vi.stubEnv("QODER_VPC_INSTANCE", "termux-test");
  vi.stubEnv("QODER_CN_OPENAPI_URL", "");
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

function storeDirectory(): string {
  const root = process.env.PI_CODING_AGENT_DIR;
  if (!root) throw new Error("Test agent directory is not configured");
  return join(root, "qoder-pats");
}

describe("Android PAT files", () => {
  it("persists across module reloads and replaces a PAT with private file permissions", async () => {
    await saveQoderPat("pt-first", "account-a", "cn");
    const directory = storeDirectory();
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const file = join(directory, files[0]);
    expect(readFileSync(file, "utf8")).toBe("pt-first");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Replacement must not preserve accidentally widened permissions.
    chmodSync(directory, 0o755);
    chmodSync(file, 0o644);
    await saveQoderPat("pt-replacement", "account-a", "cn");
    vi.resetModules();
    const reloaded = await import("../pat-store.js");
    expect(await reloaded.loadQoderPat("account-a", "cn")).toBe("pt-replacement");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(files);
  });

  it("isolates tenants, regions and accounts, including concurrent writes", async () => {
    await Promise.all([
      saveQoderPat("pt-account-a", "account-a", "cn"),
      saveQoderPat("pt-account-b", "account-b", "cn"),
      saveQoderPat("pt-global", "account-a", "global"),
    ]);
    expect(await loadQoderPat("account-a", "cn")).toBe("pt-account-a");
    expect(await loadQoderPat("account-b", "cn")).toBe("pt-account-b");
    expect(await loadQoderPat("account-a", "global")).toBe("pt-global");
    expect(await loadQoderPat("account-c", "cn")).toBeUndefined();
    vi.stubEnv("QODER_VPC_INSTANCE", "another-tenant");
    expect(await loadQoderPat("account-a", "cn")).toBeUndefined();
    await saveQoderPat("pt-other-tenant", "account-a", "cn");
    vi.stubEnv("QODER_VPC_INSTANCE", "termux-test");
    expect(await loadQoderPat("account-a", "cn")).toBe("pt-account-a");
  });

  it("treats absent credentials as missing but propagates invalid storage paths without leaking secrets", async () => {
    expect(await loadQoderPat("account-a", "cn")).toBeUndefined();
    writeFileSync(storeDirectory(), "not a directory");
    const error = await saveQoderPat("pt-do-not-leak", "account-a", "cn").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("pt-do-not-leak");
    await expect(loadQoderPat("account-a", "cn")).rejects.toBeInstanceOf(Error);
  });

  it("preserves a conflicting destination and removes staged secrets if replacement fails", async () => {
    await saveQoderPat("pt-original", "account-a", "cn");
    const directory = storeDirectory();
    const file = join(directory, readdirSync(directory)[0]);
    // A directory at the destination forces rename to fail without requiring root-sensitive permission tests.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(file);
    mkdirSync(file);
    writeFileSync(join(file, "original"), "pt-original");
    await expect(saveQoderPat("pt-new", "account-a", "cn")).rejects.toBeInstanceOf(Error);
    expect(readFileSync(join(file, "original"), "utf8")).toBe("pt-original");
    expect(readdirSync(directory)).toEqual([file.slice(directory.length + 1)]);
  });

  it("rejects missing account identity instead of sharing credentials", async () => {
    await expect(saveQoderPat("pt-test", "", "cn")).rejects.toBeInstanceOf(Error);
    await expect(loadQoderPat("", "cn")).rejects.toBeInstanceOf(Error);
  });

  it("does not silently use plaintext files on desktop when the native store is unavailable", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await expect(saveQoderPat("pt-test", "account-a", "cn")).rejects.toBeInstanceOf(Error);
    await expect(loadQoderPat("account-a", "cn")).rejects.toBeInstanceOf(Error);
    Object.defineProperty(process, "platform", { value: "android", configurable: true });
    expect(await loadQoderPat("account-a", "cn")).toBeUndefined();
  });
});
