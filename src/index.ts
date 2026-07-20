import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  getQoderBaseUrl,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  toQoderCNFriendlyModel,
} from "./cosy.js";
import { getCachedModels, isCacheStale, staticCnModels, staticModels, updateQoderModelsCache } from "./models.js";
import { loginQoder, loginQoderCN, refreshQoderToken, refreshQoderTokenCN, resolveQoderIdentity } from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage, fetchQoderUsageCN } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare the extension locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

function modelsForProvider(mode: string, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : isQoderCNMode(mode) ? staticCnModels : staticModels;

  return modelsToUse.map((m) => {
    const model = isQoderCNMode(mode) ? toQoderCNFriendlyModel(m) : m;
    return {
      ...model,
      provider: providerID,
      baseUrl: getQoderBaseUrl(mode),
    };
  }) as unknown as Model<Api>[];
}

function oauthDisplayName(providerID: string, mode: string): string {
  // Always distinguish by providerID. When getQoderMode() is "cn", both
  // `qoder` and `qoder-cn` would otherwise show as "Qoder CN (PAT)" in /provider.
  if (providerID === "qoder-cn") return "Qoder CN (PAT)";
  if (isQoderCNMode(mode)) return "Qoder (CN mode / PAT)";
  return "Qoder (Browser OAuth / PAT)";
}

function createQoderOAuth(providerID: string, mode: string): OAuthConfigWithUsage {
  return {
    name: oauthDisplayName(providerID, mode),
    login: isQoderCNMode(mode) ? loginQoderCN : loginQoder,
    refreshToken: isQoderCNMode(mode) ? refreshQoderTokenCN : refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
      const nonQoder = models.filter((m: Model<Api>) => m.provider !== providerID);
      return [...nonQoder, ...modelsForProvider(mode, providerID)];
    },
    fetchUsage: isQoderCNMode(mode) ? fetchQoderUsageCN : fetchQoderUsage,
  };
}

// ModelRegistry requires apiKey or oauth whenever models are present, including
// re-registration after a cache refresh. Always include oauth so session_start
// can publish an updated model list without failing validation.
function modelConfigForProvider(mode: string, providerID: string): Pick<ProviderConfig, "api" | "baseUrl" | "models" | "oauth"> {
  return {
    baseUrl: getQoderBaseUrl(mode),
    api: "qoder-api" as Api,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: createQoderOAuth(providerID, mode) as ProviderConfig["oauth"],
  };
}

function registerQoderProvider(pi: ExtensionAPI, providerID: string, mode: string): void {
  pi.registerProvider(providerID, {
    ...modelConfigForProvider(mode, providerID),
    streamSimple: streamQoder,
  });
}

export default function (pi: ExtensionAPI) {
  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  // Login/refresh are the other rebuild triggers; this covers the case where
  // the cache was deleted while the token is still valid.
  pi.on("session_start", async (_event, ctx) => {
    for (const [providerID, mode] of [
      ["qoder", getQoderMode()],
      ["qoder-cn", "cn"],
    ] as const) {
      try {
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
        if (!accessToken || !isCacheStale(mode)) continue;
        // Prefer auth.json, else /userinfo(access). Never use a placeholder userID.
        const creds = await resolveQoderIdentity(accessToken, providerID, mode);
        if (!creds?.userID) continue;
        const userID = creds.userID;
        const name = creds.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User");
        const email = creds.email || getQoderUserEmailFallback(mode);
        await updateQoderModelsCache(accessToken, userID, name, email, mode);
        // The provider was registered before session_start from the previous cache.
        // Publish the refreshed snapshot immediately so the current model picker
        // sees newly released models without restarting OMP.
        ctx.modelRegistry.registerProvider(providerID, modelConfigForProvider(mode, providerID));
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
  });

  registerQoderProvider(pi, "qoder", getQoderMode());
  registerQoderProvider(pi, "qoder-cn", "cn");
}
