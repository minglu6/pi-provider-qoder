import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

import {
  clearQoderIdentityMemoryCache,
  getCachedCredentials,
  peekQoderIdentityMemoryCache,
  rememberQoderIdentity,
  resolveQoderIdentity,
} from "../oauth.js";

const endpointEnvNames = [
  "QODER_CN_BASE_URL",
  "QODER_CN_OPENAPI_URL",
  "QODER_CN_CENTER_URL",
  "QODER_VPC_ENDPOINT",
  "QODERCN_VPC_ENDPOINT",
  "QODERCN_CLI_VPC_ENDPOINT",
  "QODER_VPC_INSTANCE",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODER_API_KEY",
] as const;
const originalEndpointEnv = Object.fromEntries(endpointEnvNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  clearQoderIdentityMemoryCache();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  for (const name of endpointEnvNames) delete process.env[name];
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearQoderIdentityMemoryCache();
  for (const name of endpointEnvNames) {
    const original = originalEndpointEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

function stubEmptyAuthJson() {
  existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
  readFileSyncMock.mockImplementation((path: PathLike) => {
    if (String(path) === AUTH_FILE) return "{}";
    throw new Error(`unexpected read: ${String(path)}`);
  });
}

// local type alias without importing fs namespace (mocked)
type PathLike = string | Buffer | URL;

describe("getCachedCredentials", () => {
  it("returns null when auth.json is empty", () => {
    stubEmptyAuthJson();
    expect(getCachedCredentials("jt-test", "qoder-cn")).toBeNull();
  });

  it("returns creds when auth.json userID matches this access token", () => {
    existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        "qoder-cn": {
          userID: "user-1",
          email: "a@b.c",
          name: "n",
          machineID: "m-1",
          access: "jt-x",
          refresh: "pat|x|y|user-1|m-1",
          expires: 1,
        },
      }),
    );
    const creds = getCachedCredentials("jt-x", "qoder-cn");
    expect(creds?.userID).toBe("user-1");
    expect(creds?.machineID).toBe("m-1");
  });

  it("returns null when auth.json access does not match the current token", () => {
    existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        "qoder-cn": {
          userID: "old-user",
          email: "old@example.com",
          name: "Old",
          machineID: "m-old",
          access: "jt-old",
          refresh: "pat|x|y|old-user|m-old",
          expires: 1,
        },
      }),
    );
    expect(getCachedCredentials("jt-new", "qoder-cn")).toBeNull();
  });

  it("returns null when auth.json has userID but no access field", () => {
    existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        "qoder-cn": {
          userID: "user-1",
          email: "a@b.c",
          name: "n",
          machineID: "m-1",
        },
      }),
    );
    expect(getCachedCredentials("jt-x", "qoder-cn")).toBeNull();
  });
});

describe("resolveQoderIdentity", () => {
  it("uses auth.json fast path only when stored access matches", async () => {
    existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        "qoder-cn": {
          userID: "from-file",
          email: "file@example.com",
          name: "File User",
          machineID: "machine-file",
          access: "jt-access",
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const identity = await resolveQoderIdentity("jt-access", "qoder-cn", "cn");
    expect(identity.userID).toBe("from-file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores stale auth.json and re-resolves via userinfo for a new access token", async () => {
    existsSyncMock.mockImplementation((path: PathLike) => String(path) === AUTH_FILE);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        "qoder-cn": {
          userID: "old-user",
          email: "old@example.com",
          name: "Old User",
          machineID: "machine-old",
          access: "jt-old",
        },
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "new-user", email: "new@example.com", name: "New User" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const identity = await resolveQoderIdentity("jt-new", "qoder-cn", "cn");
    expect(identity.userID).toBe("new-user");
    expect(identity.email).toBe("new@example.com");
    expect(identity.access).toBe("jt-new");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to /userinfo when auth.json has no userID", async () => {
    stubEmptyAuthJson();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "user-from-info", email: "u@example.com", name: "Info" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const identity = await resolveQoderIdentity("jt-access", "qoder-cn", "cn");
    expect(identity.userID).toBe("user-from-info");
    expect(identity.email).toBe("u@example.com");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/userinfo");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jt-access");
  });

  it("caches identity in memory after userinfo success", async () => {
    stubEmptyAuthJson();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "cached-user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveQoderIdentity("jt-access", "qoder-cn", "cn");
    const second = await resolveQoderIdentity("jt-access", "qoder-cn", "cn");
    expect(first.userID).toBe("cached-user");
    expect(second.userID).toBe("cached-user");
    expect(fetchMock).toHaveBeenCalledOnce();

    const cached = peekQoderIdentityMemoryCache();
    expect(cached).toHaveLength(1);
    expect(cached[0]).toEqual({
      userID: "cached-user",
      email: expect.any(String),
      name: expect.any(String),
      machineID: expect.any(String),
    });
    expect(cached[0]).not.toHaveProperty("access");
    expect(cached[0]).not.toHaveProperty("refresh");
    expect(cached[0]).not.toHaveProperty("expires");
  });

  it("throws a clear error when auth.json and userinfo both lack userID", async () => {
    stubEmptyAuthJson();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    await expect(resolveQoderIdentity("jt-access", "qoder-cn", "cn")).rejects.toThrow(/identity unavailable/i);
    await expect(resolveQoderIdentity("jt-access", "qoder-cn", "cn")).rejects.toThrow(/userinfo/i);
  });

  it("does not invent a placeholder userID on userinfo failure", async () => {
    stubEmptyAuthJson();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(resolveQoderIdentity("jt-access", "qoder-cn", "cn")).rejects.toThrow(/identity unavailable/i);
  });
});

describe("rememberQoderIdentity cache hygiene", () => {
  it("stores identity fields only even when given full credentials with refresh/PAT", () => {
    rememberQoderIdentity("qoder-cn", {
      access: "jt-secret-access",
      refresh: "pat|pt-secret|jrt-x|user-1|machine-1",
      expires: 123,
      userID: "user-1",
      email: "a@b.c",
      name: "n",
      machineID: "machine-1",
    } as any);

    const cached = peekQoderIdentityMemoryCache();
    expect(cached).toHaveLength(1);
    expect(Object.keys(cached[0]).sort()).toEqual(["email", "machineID", "name", "userID"]);
    expect(JSON.stringify(cached[0])).not.toContain("jt-secret-access");
    expect(JSON.stringify(cached[0])).not.toContain("pt-secret");
    expect(JSON.stringify(cached[0])).not.toContain("pat|");
  });

  it("clears prior provider entries when remembering a new access token", () => {
    rememberQoderIdentity("qoder-cn", {
      access: "jt-old",
      userID: "old-user",
      email: "old@example.com",
      name: "Old",
      machineID: "m-old",
    });
    rememberQoderIdentity("qoder-cn", {
      access: "jt-new",
      userID: "new-user",
      email: "new@example.com",
      name: "New",
      machineID: "m-new",
    });

    const cached = peekQoderIdentityMemoryCache();
    expect(cached).toHaveLength(1);
    expect(cached[0].userID).toBe("new-user");
    expect(cached[0]).not.toHaveProperty("access");
    expect(cached[0]).not.toHaveProperty("refresh");
  });

  it("does not keep stale identity under an old access token after provider replace", async () => {
    stubEmptyAuthJson();
    rememberQoderIdentity("qoder-cn", {
      access: "jt-old",
      userID: "old-user",
      email: "old@example.com",
      name: "Old",
      machineID: "m-old",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "fresh-user", email: "fresh@example.com", name: "Fresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Old token was replaced; resolving with a different access must not reuse old identity.
    const identity = await resolveQoderIdentity("jt-new", "qoder-cn", "cn");
    expect(identity.userID).toBe("fresh-user");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(peekQoderIdentityMemoryCache()).toHaveLength(1);
    expect(peekQoderIdentityMemoryCache()[0].userID).toBe("fresh-user");
  });
});
