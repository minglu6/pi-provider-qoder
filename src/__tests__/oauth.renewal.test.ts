import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cosy from "../cosy.js";
import { loginQoderCN, refreshQoderTokenCN } from "../oauth.js";
import { credentialsFromPat, QoderTokenError } from "../pat.js";
import { loadQoderPat } from "../pat-store.js";

const store = vi.hoisted(() => ({
  passwords: new Map<string, string>(),
  unavailable: false,
  reads: 0,
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    key: string;
    constructor(service: string, userID: string) {
      this.key = JSON.stringify([service, userID]);
    }
    async setPassword(pat: string) {
      if (store.unavailable) throw new Error(`locked: ${pat}`);
      store.passwords.set(this.key, pat);
    }
    async getSecret() {
      store.reads++;
      if (store.unavailable) throw new Error("locked");
      const pat = store.passwords.get(this.key);
      return pat === undefined ? null : Buffer.from(pat);
    }
  },
}));
vi.mock("../models.js", () => ({ updateQoderModelsCache: vi.fn().mockResolvedValue(undefined) }));

let refreshStatus: number;
let refreshBody: string;
let exchangeStatus: number;
let exchangeAccount: string;
let failNetwork: boolean;
let exchangePats: string[];
let requestURLs: string[];

beforeEach(() => {
  for (const key of [
    "QODERCN_PERSONAL_ACCESS_TOKEN",
    "QODERCN_PAT",
    "QODER_API_KEY",
    "QODER_PERSONAL_ACCESS_TOKEN",
    "QODER_PAT",
    "QODER_CN_BASE_URL",
    "QODER_CN_OPENAPI_URL",
    "QODER_CN_CENTER_URL",
    "QODER_VPC_ENDPOINT",
    "QODERCN_VPC_ENDPOINT",
    "QODERCN_CLI_VPC_ENDPOINT",
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("QODER_VPC_INSTANCE", "renewal-test");
  vi.spyOn(cosy, "getMachineId").mockReturnValue("test-machine");
  store.passwords.clear();
  store.unavailable = false;
  store.reads = 0;
  refreshStatus = 401;
  refreshBody = "ExpiredTokenError";
  exchangeStatus = 200;
  exchangeAccount = "account-a";
  failNetwork = false;
  exchangePats = [];
  requestURLs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requestURLs.push(url);
      const path = new URL(url).pathname;
      if (path.endsWith("/jobToken/refresh")) {
        if (failNetwork) throw new TypeError("fetch failed");
        if (refreshStatus !== 200) return new Response(refreshBody, { status: refreshStatus });
        return Response.json({ token: "jt-renewed", refresh_token: "jrt-rotated", expires_in: 86_400_000 });
      }
      if (path.endsWith("/jobToken/exchange")) {
        exchangePats.push(JSON.parse(init.body as string).personal_token);
        if (exchangeStatus !== 200) return new Response("ExpiredTokenError", { status: exchangeStatus });
        return Response.json({ token: "jt-recovered", refresh_token: "jrt-recovered", expires_in: 86_400_000 });
      }
      if (path.endsWith("/userinfo")) return Response.json({ id: exchangeAccount });
      throw new Error(`Unexpected endpoint: ${path}`);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function login(pat = "pt-saved-account-a"): Promise<OAuthCredentials> {
  return loginQoderCN({ onPrompt: async () => pat } as unknown as OAuthLoginCallbacks);
}

function expire(creds: OAuthCredentials): OAuthCredentials {
  // Persist/reload the host credential shape; never keep a PAT in process-local login state.
  return { ...JSON.parse(JSON.stringify(creds)), expires: 0 };
}

describe("saved PAT recovery", () => {
  it("recovers after one interactive login without PAT environment variables, preserving identity", async () => {
    const creds = await login();
    exchangePats = [];
    const recovered = await refreshQoderTokenCN(expire(creds));
    expect(recovered.access).toBe("jt-recovered");
    expect(recovered.refresh).toBe("jrt|jrt-recovered|account-a|test-machine");
    expect(recovered.expires).toBeGreaterThan(Date.now());
    expect(exchangePats).toEqual(["pt-saved-account-a"]);
    expect(JSON.stringify([creds, recovered])).not.toContain("pt-saved-account-a");
  });

  it("does not require an unlocked credential store when JRT renewal succeeds", async () => {
    const creds = await login();
    refreshStatus = 200;
    store.unavailable = true;
    exchangePats = [];
    const renewed = await refreshQoderTokenCN(expire(creds));
    expect(renewed.refresh).toBe("jrt|jrt-rotated|account-a|test-machine");
    expect(store.reads).toBe(0);
    expect(exchangePats).toEqual([]);
  });

  it.each([400, 403])("recovers on explicit expired-token errors with HTTP %s", async (status) => {
    const creds = await login();
    refreshStatus = status;
    expect((await refreshQoderTokenCN(expire(creds))).access).toBe("jt-recovered");
  });

  it.each([403, 429, 503])("does not exchange a PAT for an unrelated HTTP %s failure", async (status) => {
    const creds = await login();
    refreshStatus = status;
    refreshBody = status === 403 ? "PermissionDenied" : "ExpiredTokenError";
    exchangePats = [];
    await expect(refreshQoderTokenCN(expire(creds))).rejects.toBeInstanceOf(QoderTokenError);
    expect(store.reads).toBe(0);
    expect(exchangePats).toEqual([]);
  });

  it("propagates a transport failure without touching the saved PAT", async () => {
    const creds = await login();
    failNetwork = true;
    exchangePats = [];
    await expect(refreshQoderTokenCN(expire(creds))).rejects.toBeInstanceOf(TypeError);
    expect(store.reads).toBe(0);
    expect(exchangePats).toEqual([]);
  });

  it("prefers the saved account over an unrelated environment PAT", async () => {
    const creds = await login();
    vi.stubEnv("QODERCN_PAT", "pt-unrelated");
    exchangePats = [];
    await refreshQoderTokenCN(expire(creds));
    expect(exchangePats).toEqual(["pt-saved-account-a"]);
  });

  it("does not send one tenant's PAT to a different endpoint", async () => {
    const creds = await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "another-tenant");
    exchangePats = [];
    await expect(refreshQoderTokenCN(expire(creds))).rejects.toThrow();
    expect(exchangePats).toEqual([]);
  });

  it("does not reuse a different account's PAT on the same tenant", async () => {
    await login();
    exchangePats = [];
    await expect(
      refreshQoderTokenCN({ access: "jt-b", refresh: "jrt|jrt-b|account-b|machine-b", expires: 0 }),
    ).rejects.toThrow();
    expect(exchangePats).toEqual([]);
  });

  it("treats a native null entry as absent rather than a locked credential store", async () => {
    expect(await loadQoderPat("missing-account", "cn")).toBeUndefined();
  });

  it("allows interactive replacement of a rejected environment PAT", async () => {
    vi.stubEnv("QODERCN_PAT", "pt-expired-env");
    exchangeStatus = 401;
    const creds = await loginQoderCN({
      onPrompt: async () => {
        exchangeStatus = 200;
        return "pt-interactive-replacement";
      },
    } as unknown as OAuthLoginCallbacks);
    expect(creds.access).toBe("jt-recovered");
    vi.stubEnv("QODERCN_PAT", "");
    exchangePats = [];
    await refreshQoderTokenCN(expire(creds));
    expect(exchangePats).toEqual(["pt-interactive-replacement"]);
  });

  it("rejects an identity change before saving the replacement credential", async () => {
    const creds = await login();
    const stored = new Map(store.passwords);
    exchangeAccount = "account-b";
    await expect(refreshQoderTokenCN(expire(creds))).rejects.toThrow();
    expect(store.passwords).toEqual(stored);
  });

  it("fails login rather than promising renewal when the credential store is locked", async () => {
    store.unavailable = true;
    const error = await login().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("pt-saved-account-a");
    expect(store.passwords.size).toBe(0);
  });

  it("replaces a rejected PAT through a new login and resumes unattended recovery", async () => {
    const creds = await login();
    exchangeStatus = 401;
    await expect(refreshQoderTokenCN(expire(creds))).rejects.toThrow();
    exchangeStatus = 200;
    const updated = await login("pt-replacement");
    exchangePats = [];
    await refreshQoderTokenCN(expire(updated));
    expect(exchangePats).toEqual(["pt-replacement"]);
  });

  it("does not claim an expired PAT when the credential store is locked", async () => {
    const creds = await login();
    store.unavailable = true;
    exchangePats = [];
    const error = await refreshQoderTokenCN(expire(creds)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(QoderTokenError);
    expect(exchangePats).toEqual([]);
  });

  it("migrates an embedded legacy PAT before dropping it from host credentials", async () => {
    refreshStatus = 200;
    const migrated = await refreshQoderTokenCN({
      access: "jt-old",
      refresh: "pat|pt-legacy|jrt-old|account-a|old-machine",
      expires: 0,
    });
    expect(JSON.stringify(migrated)).not.toContain("pt-legacy");
    refreshStatus = 401;
    const recovered = await refreshQoderTokenCN(expire(migrated));
    expect(exchangePats).toEqual(["pt-legacy"]);
    expect(recovered.refresh).toBe("jrt|jrt-recovered|account-a|old-machine");
  });

  it("does not expose a PAT echoed by a failing exchange endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rejected pt-do-not-log", { status: 400 })));
    const error = await credentialsFromPat("pt-do-not-log", "cn").catch((e: Error) => e);
    expect(error).toBeInstanceOf(QoderTokenError);
    expect(String(error)).not.toContain("pt-do-not-log");
    expect(store.passwords.size).toBe(0);
  });
});

describe("interactive VPC routing", () => {
  async function loginAt(...answers: string[]): Promise<OAuthCredentials> {
    return loginQoderCN({
      onPrompt: async () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error("Unexpected login prompt");
        return answer;
      },
    } as unknown as OAuthLoginCallbacks);
  }

  it("saves an entered tenant URL and uses it for recovery without route or PAT environment variables", async () => {
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    const creds = await loginAt("https://example-tenant.vpc.qoder.com.cn/account/integrations", "pt-saved");
    const saved = readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "qoder-cn-config.json"), "utf8");
    expect(JSON.parse(saved)).toEqual({ vpcInstance: "example-tenant" });
    expect(saved).not.toContain("pt-saved");
    requestURLs = [];
    await refreshQoderTokenCN(expire(creds));
    expect(new Set(requestURLs.map((url) => new URL(url).host))).toEqual(
      new Set(["example-tenant-openapi.vpc.qoder.com.cn"]),
    );
    expect(cosy.getQoderChatURL("cn")).toMatch(/^https:\/\/example-tenant-gateway\.vpc\.qoder\.com\.cn\//);
    expect(cosy.getQoderIntegrationsUrl("cn")).toBe("https://example-tenant.vpc.qoder.com.cn/account/integrations");
  });

  it("keeps the saved tenant when Enter is pressed on subsequent logins", async () => {
    await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    requestURLs = [];
    await loginAt("", "pt-replacement");
    expect(new Set(requestURLs.map((url) => new URL(url).host))).toEqual(
      new Set(["renewal-test-openapi.vpc.qoder.com.cn"]),
    );
  });

  it("persists a deliberate switch from enterprise VPC to China public cloud", async () => {
    await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    requestURLs = [];
    await loginAt("public", "pt-public");
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
    expect(cosy.getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
    expect(new Set(requestURLs.map((url) => new URL(url).host))).toEqual(new Set(["openapi.qoder.com.cn"]));
    expect(JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "qoder-cn-config.json"), "utf8"))).toEqual({
      vpcInstance: null,
    });
  });

  it("does not persist a new route or redirect the existing session when authentication fails", async () => {
    await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    const path = join(process.env.PI_CODING_AGENT_DIR!, "qoder-cn-config.json");
    const original = readFileSync(path, "utf8");
    exchangeStatus = 401;
    await expect(loginAt("other-tenant", "pt-rejected")).rejects.toBeInstanceOf(QoderTokenError);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://renewal-test-openapi.vpc.qoder.com.cn");
  });

  it("rejects unrelated domains before sending the PAT", async () => {
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    await loginAt("https://unrelated.example", "https://valid-tenant-openapi.vpc.qoder.com.cn", "pt-valid");
    expect(new Set(requestURLs.map((url) => new URL(url).host))).toEqual(
      new Set(["valid-tenant-openapi.vpc.qoder.com.cn"]),
    );
    expect(exchangePats).toEqual(["pt-valid"]);
  });

  it("cancels route selection without network requests or saved configuration", async () => {
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    const controller = new AbortController();
    await expect(
      loginQoderCN({
        signal: controller.signal,
        onPrompt: async () => {
          controller.abort();
          return "cancelled-tenant";
        },
      } as unknown as OAuthLoginCallbacks),
    ).rejects.toThrow();
    expect(requestURLs).toEqual([]);
    expect(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "qoder-cn-config.json"))).toBe(false);
  });

  it("keeps custom environment endpoints authoritative over a saved VPC", async () => {
    await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    vi.stubEnv("QODER_CN_OPENAPI_URL", "https://openapi.qoder.com.cn");
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
    vi.stubEnv("QODER_CN_OPENAPI_URL", "");
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://renewal-test-openapi.vpc.qoder.com.cn");
  });

  it("isolates a pending login's tenant from requests in the existing session", async () => {
    await login();
    vi.stubEnv("QODER_VPC_INSTANCE", "");
    let submitPat!: (pat: string) => void;
    let notifyPrompt!: () => void;
    const pat = new Promise<string>((resolve) => {
      submitPat = resolve;
    });
    const prompted = new Promise<void>((resolve) => {
      notifyPrompt = resolve;
    });
    let prompts = 0;
    const pending = loginQoderCN({
      onPrompt: async () => {
        if (prompts++ === 0) return "pending-tenant";
        notifyPrompt();
        return pat;
      },
    } as unknown as OAuthLoginCallbacks);
    await prompted;
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://renewal-test-openapi.vpc.qoder.com.cn");
    submitPat("pt-new-tenant");
    await pending;
    expect(cosy.getQoderOpenApiUrl("cn")).toBe("https://pending-tenant-openapi.vpc.qoder.com.cn");
  });
});
