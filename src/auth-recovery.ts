import type { OAuthCredentials } from "@earendil-works/pi-ai";

export type RenewQoderAccess = (accessToken: string, sessionId?: string) => Promise<string>;

type StoredOAuth = OAuthCredentials & { type: "oauth" };
interface PiAuthStorage {
  reload(): void;
  get(provider: string): StoredOAuth | { type: "api_key"; key: string } | undefined;
  set(provider: string, credential: StoredOAuth): void;
  getApiKey(provider: string): Promise<string | undefined>;
}
interface OmpAuthStorage {
  keys: {
    get(
      provider: string,
      sessionId: string | undefined,
      options: {
        forceRefresh: boolean;
        refreshReason: string;
      },
    ): Promise<string | undefined>;
  };
}
interface PiRuntime {
  credentials: {
    modify(
      provider: string,
      update: (current: StoredOAuth | { type: "api_key"; key: string } | undefined) => StoredOAuth | undefined,
    ): Promise<unknown>;
  };
  getAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined>;
}

// Both hosts own persistence and refresh locking; never rewrite auth.json here.
export function createQoderAuthRecovery(
  storage: PiAuthStorage | OmpAuthStorage | PiRuntime,
  provider: string,
): RenewQoderAccess {
  const pending = new Map<string, Promise<string>>();
  return (accessToken, sessionId) => {
    const existing = pending.get(accessToken);
    if (existing) return existing;
    const renewal = (async () => {
      let renewed: string | undefined;
      if ("keys" in storage) {
        renewed = await storage.keys.get(provider, sessionId, { forceRefresh: true, refreshReason: "auth-recovery" });
      } else if ("credentials" in storage) {
        await storage.credentials.modify(provider, (current) => {
          if (current?.type !== "oauth") throw new Error("Qoder automatic renewal requires host OAuth credentials.");
          return current.access === accessToken ? { ...current, expires: 0 } : undefined;
        });
        renewed = (await storage.getAuth(provider))?.auth.apiKey;
      } else {
        storage.reload();
        const current = storage.get(provider);
        if (current?.type !== "oauth") throw new Error("Qoder automatic renewal requires host OAuth credentials.");
        if (current.access !== accessToken) {
          renewed = await storage.getApiKey(provider);
        } else {
          // Expire only the rejected credential, then use the host's locked refresh.
          storage.set(provider, { ...current, expires: 0 });
          renewed = await storage.getApiKey(provider);
        }
      }
      if (!renewed || renewed === accessToken)
        throw new Error("Qoder automatic renewal did not return a new access token.");
      return renewed;
    })();
    pending.set(accessToken, renewal);
    void renewal.finally(() => pending.delete(accessToken)).catch(() => {});
    return renewal;
  };
}

export function isQoderAuthExpired(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  if (/\b(?:ExpiredTokenError|InvalidTokenError|InvalidRefreshTokenError|TOKEN_EXPIRED?)\b/.test(body)) return true;
  try {
    const error: unknown = JSON.parse(body);
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "105" || error.code === 105) &&
      "message" in error &&
      typeof error.message === "string" &&
      /^Login expired$/i.test(error.message.trim())
    );
  } catch {
    return false;
  }
}

export class QoderAuthExpiredError extends Error {}
