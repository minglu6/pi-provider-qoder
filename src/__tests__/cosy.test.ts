import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatQoderHttpError,
  getQoderBaseUrl,
  getQoderCenterUrl,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderCNFriendlyModelInfo,
  getQoderCNPat,
  getQoderExchangeURL,
  getQoderIntegrationsUrl,
  getQoderManageUrl,
  getQoderMode,
  getQoderModelListURL,
  getQoderOpenApiUrl,
  getQoderRefreshURL,
  getQoderUsageURL,
  getQoderUserEmailFallback,
  getQoderUserInfoURL,
  isQoderCNMode,
  isQoderPatValue,
  toQoderCNFriendlyModel,
} from "../cosy.js";

const endpointEnvNames = [
  "QODER_CN_BASE_URL",
  "QODER_CN_OPENAPI_URL",
  "QODER_CN_CENTER_URL",
  "QODER_VPC_INSTANCE",
  "QODER_VPC_ENDPOINT",
  "QODERCN_VPC_ENDPOINT",
  "QODERCN_CLI_VPC_ENDPOINT",
  // PAT env vars force CN mode in getQoderMode(); isolate tests from host env.
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODER_API_KEY",
  "QODER_REGION",
  "QODER_BACKEND",
  "QODER_MODE",
] as const;
const originalEndpointEnv = Object.fromEntries(endpointEnvNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of endpointEnvNames) delete process.env[name];
});

afterEach(() => {
  for (const name of endpointEnvNames) {
    const value = originalEndpointEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ── getQoderMode ──────────────────────────────────────────────────────────

describe("getQoderMode", () => {
  it('returns "cn" for explicit CN variants', () => {
    expect(getQoderMode("cn")).toBe("cn");
    expect(getQoderMode("china")).toBe("cn");
    expect(getQoderMode("qodercn")).toBe("cn");
    expect(getQoderMode("qoder-cn")).toBe("cn");
    expect(getQoderMode("CN")).toBe("cn");
    expect(getQoderMode("China")).toBe("cn");
  });

  it('returns "global" for explicit global variants', () => {
    expect(getQoderMode("global")).toBe("global");
    expect(getQoderMode("intl")).toBe("global");
    expect(getQoderMode("international")).toBe("global");
    expect(getQoderMode("qoder")).toBe("global");
  });

  it("falls back to global for unknown strings", () => {
    expect(getQoderMode("unknown")).toBe("global");
    expect(getQoderMode("")).toBe("global");
  });
});

// ── isQoderCNMode ─────────────────────────────────────────────────────────

describe("isQoderCNMode", () => {
  it("returns true for CN modes", () => {
    expect(isQoderCNMode("cn")).toBe(true);
    expect(isQoderCNMode("china")).toBe(true);
  });

  it("returns false for global modes", () => {
    expect(isQoderCNMode("global")).toBe(false);
    expect(isQoderCNMode("intl")).toBe(false);
  });
});

// ── URL builders ──────────────────────────────────────────────────────────

describe("getQoderBaseUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderBaseUrl("global")).toBe("https://api3.qoder.sh/");
  });
});

describe("getQoderOpenApiUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderOpenApiUrl("global")).toBe("https://openapi.qoder.sh");
  });
});

describe("getQoderCenterUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderCenterUrl("cn")).toBe("https://gateway.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderCenterUrl("global")).toBe("https://center.qoder.sh");
  });
});

describe("Qoder VPC endpoint derivation", () => {
  it("derives gateway and OpenAPI hosts from an instance name", () => {
    process.env.QODER_VPC_INSTANCE = "sungrow-of-enterprise";

    expect(getQoderBaseUrl("cn")).toBe("https://sungrow-of-enterprise-gateway.vpc.qoder.com.cn/");
    expect(getQoderOpenApiUrl("cn")).toBe("https://sungrow-of-enterprise-openapi.vpc.qoder.com.cn");
    expect(getQoderCenterUrl("cn")).toBe("https://sungrow-of-enterprise-gateway.vpc.qoder.com.cn");
  });

  it("normalizes the tenant dashboard URL used as a legacy override", () => {
    const dashboardUrl = "https://sungrow-of-enterprise.vpc.qoder.com.cn/";
    process.env.QODER_CN_BASE_URL = dashboardUrl;

    expect(getQoderBaseUrl("cn")).toBe("https://sungrow-of-enterprise-gateway.vpc.qoder.com.cn/");
    expect(getQoderOpenApiUrl("cn")).toBe("https://sungrow-of-enterprise-openapi.vpc.qoder.com.cn");
    expect(getQoderCenterUrl("cn")).toBe("https://sungrow-of-enterprise-gateway.vpc.qoder.com.cn");
  });

  it("accepts the official CLI VPC endpoint environment variable", () => {
    process.env.QODERCN_VPC_ENDPOINT = "sungrow-of-enterprise-openapi.vpc.qoder.com.cn";

    expect(getQoderBaseUrl("cn")).toBe("https://sungrow-of-enterprise-gateway.vpc.qoder.com.cn/");
    expect(getQoderOpenApiUrl("cn")).toBe("https://sungrow-of-enterprise-openapi.vpc.qoder.com.cn");
  });
});

describe("formatQoderHttpError", () => {
  it("explains CSRFInvalid on the tenant dashboard host", () => {
    const message = formatQoderHttpError(
      "pat-exchange",
      400,
      "Bad Request",
      '{"errorCode":"CSRFInvalid","errorMessage":"Invalid or missing CSRF token"}',
      "https://sungrow-of-enterprise.vpc.qoder.com.cn/api/v1/jobToken/exchange",
    );

    expect(message).toContain("CSRFInvalid");
    expect(message).toContain("tenant dashboard host");
    expect(message).toContain("<instance>-gateway.vpc.qoder.com.cn");
  });

  it("explains open_access_token not found on the VPC OpenAPI host", () => {
    const message = formatQoderHttpError(
      "pat-exchange",
      400,
      "Bad Request",
      '{"errorCode":"BadRequest","errorMessage":"openv1: open_access_token not found"}',
      "https://sungrow-of-enterprise-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange",
    );

    expect(message).toContain("open_access_token not found");
    expect(message).toContain("tenant-side access record");
    expect(message).toContain("/account/integrations");
  });
});

describe("getQoderModelListURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderModelListURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list");
  });

  it("constructs correct global URL", () => {
    expect(getQoderModelListURL("global")).toBe("https://api3.qoder.sh/algo/api/v2/model/list");
  });
});

describe("getQoderChatURL", () => {
  it("contains base URL and chat path", () => {
    const url = getQoderChatURL("global");
    expect(url).toContain("https://api3.qoder.sh/");
    expect(url).toContain("algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(url).toContain("Encode=1");
  });
});

describe("getQoderExchangeURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderExchangeURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
  });

  it("constructs correct global URL", () => {
    expect(getQoderExchangeURL("global")).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
  });
});

describe("getQoderUserInfoURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUserInfoURL("global")).toBe("https://openapi.qoder.sh/api/v1/userinfo");
  });
});

describe("getQoderUsageURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUsageURL("global")).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
  });
});

describe("getQoderRefreshURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderRefreshURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token");
  });

  it("constructs correct global URL", () => {
    expect(getQoderRefreshURL("global")).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });
});

describe("getQoderManageUrl", () => {
  it("returns CN URL", () => {
    expect(getQoderManageUrl("cn")).toBe("https://qoder.com.cn");
  });

  it("returns global URL", () => {
    expect(getQoderManageUrl("global")).toBe("https://qoder.com");
  });

  it("returns VPC tenant dashboard when QODER_VPC_INSTANCE is set", () => {
    process.env.QODER_VPC_INSTANCE = "sungrow-of-enterprise";
    expect(getQoderManageUrl("cn")).toBe("https://sungrow-of-enterprise.vpc.qoder.com.cn");
  });
});

describe("getQoderIntegrationsUrl", () => {
  it("points at public CN integrations by default", () => {
    expect(getQoderIntegrationsUrl("cn")).toBe("https://qoder.com.cn/account/integrations");
  });

  it("points at VPC tenant integrations when instance is set", () => {
    process.env.QODER_VPC_INSTANCE = "sungrow-of-enterprise";
    expect(getQoderIntegrationsUrl("cn")).toBe(
      "https://sungrow-of-enterprise.vpc.qoder.com.cn/account/integrations",
    );
  });
});

describe("getQoderCNPat / isQoderPatValue", () => {
  it("prefers dedicated CN PAT env vars", () => {
    process.env.QODERCN_PAT = "pt-dedicated";
    process.env.QODER_API_KEY = "pt-alias";
    expect(getQoderCNPat()).toBe("pt-dedicated");
  });

  it("accepts QODER_API_KEY only when it starts with pt-", () => {
    process.env.QODER_API_KEY = "pt-from-api-key";
    expect(isQoderPatValue(process.env.QODER_API_KEY)).toBe(true);
    expect(getQoderCNPat()).toBe("pt-from-api-key");
  });

  it("ignores QODER_API_KEY when it is not a PAT", () => {
    process.env.QODER_API_KEY = "jt-not-a-pat";
    expect(isQoderPatValue(process.env.QODER_API_KEY)).toBe(false);
    expect(getQoderCNPat()).toBe("");
  });
});

describe("getQoderUserEmailFallback", () => {
  it("returns CN email", () => {
    expect(getQoderUserEmailFallback("cn")).toBe("user@qoder.com.cn");
  });

  it("returns global email", () => {
    expect(getQoderUserEmailFallback("global")).toBe("user@qoder.com");
  });
});

// ── getQoderCNDirectModel ─────────────────────────────────────────────────

describe("getQoderCNDirectModel", () => {
  it("maps known model IDs to internal keys", () => {
    expect(getQoderCNDirectModel("qoder-cn")).toBe("auto");
    expect(getQoderCNDirectModel("qwen3.7-max")).toBe("qmodel_latest");
    expect(getQoderCNDirectModel("qwen3.7-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-flash")).toBe("q36fmodel");
    expect(getQoderCNDirectModel("deepseek-v4-pro")).toBe("dmodel");
    expect(getQoderCNDirectModel("deepseek-v4-flash")).toBe("dfmodel");
    expect(getQoderCNDirectModel("glm-5.2")).toBe("gm51model");
    expect(getQoderCNDirectModel("glm-5.1")).toBe("gm51model");
    expect(getQoderCNDirectModel("kimi-k2.6")).toBe("kmodel");
    expect(getQoderCNDirectModel("minimax-m2.7")).toBe("mmodel");
    expect(getQoderCNDirectModel("minimax-m3")).toBe("mmodel");
  });

  it("returns the input ID for unknown models", () => {
    expect(getQoderCNDirectModel("custom-model")).toBe("custom-model");
  });

  it('defaults to "auto" when no input', () => {
    expect(getQoderCNDirectModel()).toBe("auto");
    expect(getQoderCNDirectModel("")).toBe("auto");
  });
});

// ── getQoderCNFriendlyModelInfo ───────────────────────────────────────────

describe("getQoderCNFriendlyModelInfo", () => {
  it("returns known friendly info for mapped keys", () => {
    const info = getQoderCNFriendlyModelInfo("qmodel_latest");
    expect(info.id).toBe("qwen3.7-max");
    expect(info.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("returns auto mapping", () => {
    const info = getQoderCNFriendlyModelInfo("auto");
    expect(info.id).toBe("auto");
    expect(info.name).toBe("Auto · Qoder CN");
  });

  it("generates friendly name for unknown keys", () => {
    const info = getQoderCNFriendlyModelInfo("my-custom-model", "My Custom Model");
    expect(info.id).toBe("my-custom-model");
    expect(info.name).toContain("Qoder CN");
  });

  it("prettifies model names with version numbers", () => {
    const info = getQoderCNFriendlyModelInfo("some-model", "Qwen3.7-New");
    expect(info.name).toContain("Qwen 3.7");
    expect(info.name).toContain("Qoder CN");
  });
});

// ── toQoderCNFriendlyModel ────────────────────────────────────────────────

describe("toQoderCNFriendlyModel", () => {
  it("maps known model ID to friendly version", () => {
    const result = toQoderCNFriendlyModel({ id: "qmodel_latest", name: "Original Name" });
    expect(result.id).toBe("qwen3.7-max");
    expect(result.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("preserves extra fields", () => {
    const result = toQoderCNFriendlyModel({ id: "auto", name: "Auto", extra: "field" } as {
      id: string;
      name: string;
      extra: string;
    });
    expect(result.extra).toBe("field");
  });

  it("handles unknown models by prettifying display name", () => {
    const result = toQoderCNFriendlyModel({ id: "custom", name: "CustomModel V2-Pro" });
    expect(result.id).toBe("custom");
    expect(result.name).toContain("Qoder CN");
  });
});
