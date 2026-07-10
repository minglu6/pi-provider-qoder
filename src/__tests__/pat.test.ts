import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialsFromPat,
  decodePatRefresh,
  encodeJobRefresh,
  encodePatRefresh,
  exchangeJobToken,
  isPatRefresh,
  JRT_REFRESH_PREFIX,
  PAT_REFRESH_PREFIX,
  refreshJobToken,
} from "../pat.js";
import { getQoderJobTokenRefreshURL } from "../cosy.js";
import { refreshQoderTokenCN } from "../oauth.js";

const endpointEnvNames = [
  "QODER_CN_BASE_URL",
  "QODER_CN_OPENAPI_URL",
  "QODER_CN_CENTER_URL",
  "QODER_VPC_ENDPOINT",
  "QODERCN_VPC_ENDPOINT",
  "QODERCN_CLI_VPC_ENDPOINT",
  "QODER_VPC_INSTANCE",
] as const;
const originalEndpointEnv = Object.fromEntries(endpointEnvNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of endpointEnvNames) delete process.env[name];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of endpointEnvNames) {
    const original = originalEndpointEnv[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

// ── isPatRefresh ──────────────────────────────────────────────────────────

describe("isPatRefresh", () => {
  it("returns true for legacy PAT refresh strings", () => {
    expect(isPatRefresh("pat|pt-mytoken|jrt-123|user1|machine1")).toBe(true);
  });

  it("returns true for jrt-only refresh strings", () => {
    expect(isPatRefresh("jrt|jrt-123|user1|machine1")).toBe(true);
  });

  it("returns true for minimal prefixes", () => {
    expect(isPatRefresh("pat|")).toBe(true);
    expect(isPatRefresh("jrt|")).toBe(true);
  });

  it("returns false for non-job refresh strings", () => {
    expect(isPatRefresh("some-other-refresh-token")).toBe(false);
    expect(isPatRefresh("refresh|user|machine")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPatRefresh("")).toBe(false);
  });
});

// ── encodePatRefresh / decodePatRefresh ───────────────────────────────────

describe("encodeJobRefresh / decodePatRefresh", () => {
  it("encodes jrt-only refresh without PAT", () => {
    const encoded = encodeJobRefresh("jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("jrt|jrt-xyz|user-42|machine-7");
    expect(encoded).not.toContain("pt-");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
      legacyEmbeddedPat: false,
    });
  });

  it("encodePatRefresh ignores PAT and emits jrt-only", () => {
    const encoded = encodePatRefresh("pt-abc123", "jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("jrt|jrt-xyz|user-42|machine-7");
    expect(encoded).not.toContain("pt-abc123");
  });

  it("decodes legacy pat|pt|jrt|user|machine format", () => {
    const decoded = decodePatRefresh("pat|pt-abc123|jrt-xyz|user-42|machine-7");
    expect(decoded).toEqual({
      pat: "pt-abc123",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
      legacyEmbeddedPat: true,
    });
  });

  it("handles empty jrt fields", () => {
    const encoded = encodeJobRefresh("", "", "");
    expect(encoded).toBe("jrt|||");
    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "",
      jobRefreshToken: "",
      userID: "",
      machineID: "",
      legacyEmbeddedPat: false,
    });
  });
});

describe("PAT_REFRESH_PREFIX", () => {
  it('is "pat"', () => {
    expect(PAT_REFRESH_PREFIX).toBe("pat");
  });
});

describe("exchangeJobToken", () => {
  it("matches the official CLI VPC exchange payload", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "jt-test",
          refresh_token: "jrt-test",
          expires_in: 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await exchangeJobToken("pt-test", "cn");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example-tenant-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange");
    expect(JSON.parse(init.body as string)).toEqual({ personal_token: "pt-test" });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("open_access_token");
  });
});


describe("credentialsFromPat", () => {
  it("fails fast when userinfo returns empty userID", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "jt-test",
            refresh_token: "jrt-test",
            expires_in: 60_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: "x@y.z" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(credentialsFromPat("pt-test", "cn")).rejects.toThrow(/userinfo did not return userID/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns credentials when userinfo includes userID", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "jt-ok",
            refresh_token: "jrt-ok",
            expires_in: 60_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "user-ok", email: "ok@example.com", name: "Ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const creds = await credentialsFromPat("pt-test", "cn");
    expect((creds as { userID?: string }).userID).toBe("user-ok");
    expect(creds.access).toBe("jt-ok");
    expect(creds.refresh.startsWith("jrt|jrt-ok|user-ok|")).toBe(true);
    expect(creds.refresh).not.toContain("pt-test");
    expect(creds.refresh.split("|").some((p) => p.startsWith("pt-"))).toBe(false);
  });
});

describe("refreshJobToken", () => {
  it("posts refresh_token to the VPC jobToken refresh endpoint", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "jt-new",
          refresh_token: "jrt-new",
          expires_in: 3600000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshJobToken("jrt-old", "cn");
    expect(result.jobToken).toBe("jt-new");
    expect(result.jobRefreshToken).toBe("jrt-new");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example-tenant-openapi.vpc.qoder.com.cn/api/v1/jobToken/refresh");
    expect(url).toBe(getQoderJobTokenRefreshURL("cn"));
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: "jrt-old" });
  });
});

describe("refreshQoderTokenCN without persisting PAT", () => {
  it("refreshes via jrt and returns credentials without pt-", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "jt-refreshed",
          refresh_token: "jrt-rotated",
          expires_in: 3600000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshQoderTokenCN({
      access: "jt-old",
      refresh: "jrt|jrt-old|user-1|machine-1",
      expires: Date.now() - 1000,
      userID: "user-1",
      email: "u@example.com",
      name: "User",
      machineID: "machine-1",
    } as any);

    expect(refreshed.access).toBe("jt-refreshed");
    expect(refreshed.refresh).toBe("jrt|jrt-rotated|user-1|machine-1");
    expect(refreshed.refresh.split("|").some((p) => p.startsWith("pt-"))).toBe(false);
    expect(JSON.stringify(refreshed)).not.toContain("pt-");
  });

  it("migrates legacy pat|pt|jrt refresh to jrt-only via env-less jrt path", async () => {
    process.env.QODER_VPC_INSTANCE = "example-tenant";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "jt-from-jrt",
          refresh_token: "jrt-from-jrt",
          expires_in: 3600000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshQoderTokenCN({
      access: "jt-old",
      refresh: "pat|pt-should-not-persist|jrt-legacy|user-1|machine-1",
      expires: Date.now() - 1000,
      userID: "user-1",
      email: "u@example.com",
      name: "User",
      machineID: "machine-1",
    } as any);

    expect(refreshed.access).toBe("jt-from-jrt");
    expect(refreshed.refresh).toBe("jrt|jrt-from-jrt|user-1|machine-1");
    expect(refreshed.refresh).not.toContain("pt-should-not-persist");
    expect(JSON.stringify(refreshed)).not.toContain("pt-should-not-persist");
  });
});
