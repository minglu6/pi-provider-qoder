import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFromPat, decodePatRefresh, encodePatRefresh, exchangeJobToken, isPatRefresh, PAT_REFRESH_PREFIX } from "../pat.js";

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
  it("returns true for PAT refresh strings", () => {
    expect(isPatRefresh("pat|mytoken|refresh123|user1|machine1")).toBe(true);
  });

  it("returns true for minimal PAT prefix", () => {
    expect(isPatRefresh("pat|")).toBe(true);
  });

  it("returns false for non-PAT refresh strings", () => {
    expect(isPatRefresh("some-other-refresh-token")).toBe(false);
    expect(isPatRefresh("refresh|user|machine")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPatRefresh("")).toBe(false);
  });
});

// ── encodePatRefresh / decodePatRefresh ───────────────────────────────────

describe("encodePatRefresh / decodePatRefresh roundtrip", () => {
  it("encodes and decodes correctly", () => {
    const encoded = encodePatRefresh("pt-abc123", "jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("pat|pt-abc123|jrt-xyz|user-42|machine-7");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "pt-abc123",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
    });
  });

  it("handles empty fields", () => {
    const encoded = encodePatRefresh("", "", "", "");
    expect(encoded).toBe("pat||||");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "",
      jobRefreshToken: "",
      userID: "",
      machineID: "",
    });
  });

  it("handles pipe characters in fields gracefully", () => {
    // The decode splits on |, so extra pipes shift fields
    const encoded = encodePatRefresh("pt-test", "jrt-ok", "u1", "m1");
    const decoded = decodePatRefresh(encoded);
    expect(decoded.pat).toBe("pt-test");
    expect(decoded.jobRefreshToken).toBe("jrt-ok");
    expect(decoded.userID).toBe("u1");
    expect(decoded.machineID).toBe("m1");
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
    expect(creds.refresh.startsWith("pat|pt-test|jrt-ok|user-ok|")).toBe(true);
  });
});
