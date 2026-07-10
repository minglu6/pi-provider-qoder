import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
  formatQoderHttpError,
  getMachineId,
  getQoderExchangeURL,
  getQoderJobTokenRefreshURL,
  getQoderMode,
  getQoderUserEmailFallback,
  getQoderUserInfoURL,
  isQoderCNMode,
} from "./cosy.js";

const UA = "pi-provider-qoder";

/**
 * Marker prefixes used in the credential `refresh` field for job-token auth.
 *
 * Current (no plaintext PAT): `jrt|<jobRefreshToken>|<userID>|<machineID>`
 * Legacy (must migrate away): `pat|<personalToken>|<jobRefreshToken>|<userID>|<machineID>`
 *
 * Never encode a `pt-...` PAT into refresh — the host persists this field.
 */
export const PAT_REFRESH_PREFIX = "pat";
export const JRT_REFRESH_PREFIX = "jrt";

export interface PatExchangeResult {
  /** Short-lived job token (jt-...) used for auth + COSY signatures. */
  jobToken: string;
  /** Job refresh token (jrt-...), if returned. */
  jobRefreshToken: string;
  expiresAt: number;
}

export interface QoderUserInfo {
  userID: string;
  email: string;
  name: string;
}

export function isPatRefresh(refresh: string): boolean {
  return (
    refresh.startsWith(`${JRT_REFRESH_PREFIX}|`) || refresh.startsWith(`${PAT_REFRESH_PREFIX}|`)
  );
}

/** Encode job-token refresh WITHOUT embedding the plaintext PAT. */
export function encodeJobRefresh(jobRefreshToken: string, userID: string, machineID: string): string {
  return [JRT_REFRESH_PREFIX, jobRefreshToken, userID, machineID].join("|");
}

/**
 * @deprecated Legacy encoder that embedded the PAT. Kept only so old tests/callers
 * can be updated; new code must use encodeJobRefresh.
 */
export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  // Intentionally ignore `pat` — never persist plaintext PATs in refresh.
  void pat;
  return encodeJobRefresh(jobRefreshToken, userID, machineID);
}

/** Decode job-token / legacy PAT refresh fields. */
export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
  legacyEmbeddedPat: boolean;
} {
  const parts = refresh.split("|");
  if (parts[0] === JRT_REFRESH_PREFIX) {
    return {
      pat: "",
      jobRefreshToken: parts[1] || "",
      userID: parts[2] || "",
      machineID: parts[3] || "",
      legacyEmbeddedPat: false,
    };
  }
  // Legacy: pat|<pt>|<jrt>|<userID>|<machineID>
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
    legacyEmbeddedPat: Boolean(parts[1]),
  };
}

/**
 * Exchange a Qoder Personal Access Token (pt-...) for a short-lived Job Token
 * (jt-...). PATs cannot authenticate API calls directly; they must first be
 * exchanged. This mirrors the official qodercli/qoderclicn flow:
 *   POST /api/v1/jobToken/exchange { personal_token } -> { token, refresh_token, expires_at }
 * The exchange endpoint does not require a COSY signature.
 */
export async function exchangeJobToken(pat: string, mode: string = getQoderMode()): Promise<PatExchangeResult> {
  const res = await fetch(getQoderExchangeURL(mode), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      "Cosy-Version": "1.0.1",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ personal_token: pat }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(formatQoderHttpError("pat-exchange", res.status, res.statusText, text, getQoderExchangeURL(mode)));
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };

  if (!data.token) {
    throw new Error("Qoder PAT exchange returned no job token");
  }

  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (data.expires_in) {
    // expires_in is in milliseconds per the observed API response.
    expiresAt = Date.now() + data.expires_in;
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt,
  };
}

/**
 * Refresh a short-lived job token using the server-issued job refresh token (jrt-...).
 * POST /api/v1/jobToken/refresh { refresh_token } -> { token, refresh_token, expires_at }
 */
export async function refreshJobToken(
  jobRefreshToken: string,
  mode: string = getQoderMode(),
): Promise<PatExchangeResult> {
  if (!jobRefreshToken?.trim()) {
    throw new Error("Qoder job token refresh requires a non-empty refresh_token (jrt-...)");
  }

  const res = await fetch(getQoderJobTokenRefreshURL(mode), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      "Cosy-Version": "1.0.1",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ refresh_token: jobRefreshToken }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      formatQoderHttpError("pat-exchange", res.status, res.statusText, text, getQoderJobTokenRefreshURL(mode)),
    );
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };

  if (!data.token) {
    throw new Error("Qoder job token refresh returned no job token");
  }

  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (data.expires_in) {
    expiresAt = Date.now() + data.expires_in;
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || jobRefreshToken,
    expiresAt,
  };
}

/**
 * Fetch user profile using a job/access token (jt-...).
 * Returns empty fields when the request fails; callers that require identity
 * (login) must fail-fast on empty userID.
 */
export async function fetchUserInfo(jobToken: string, mode: string): Promise<QoderUserInfo> {
  let userID = "";
  let email = "";
  let name = "";
  try {
    const res = await fetch(getQoderUserInfoURL(mode), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": UA,
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
    });
    if (res.ok) {
      const info = (await res.json()) as {
        id?: string;
        email?: string;
        name?: string;
        username?: string;
      };
      userID = info.id || "";
      email = info.email || "";
      name = info.name || info.username || "";
    }
  } catch {
    // Callers decide whether empty identity is fatal.
  }
  return { userID, email, name };
}

/**
 * Build full Qoder credentials from a Personal Access Token.
 * Exchanges the PAT for a job token + job refresh token, resolves identity, and
 * stores ONLY the jrt (+ identity) in `refresh`. The plaintext PAT is never
 * written into credentials the host will persist.
 *
 * Fails if userinfo does not return a non-empty userID — otherwise login would
 * succeed while the first chat request fails with a missing-identity error.
 */
export async function credentialsFromPat(pat: string, mode: string = getQoderMode()): Promise<OAuthCredentials> {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode);
  const { userID, email, name } = await fetchUserInfo(jobToken, mode);
  if (!userID) {
    throw new Error(
      isQoderCNMode(mode)
        ? "Qoder CN login failed: userinfo did not return userID. Check VPC routing (QODER_VPC_INSTANCE) and PAT validity, then retry."
        : "Qoder login failed: userinfo did not return userID. Check network/PAT validity, then retry.",
    );
  }
  if (!jobRefreshToken) {
    throw new Error(
      isQoderCNMode(mode)
        ? "Qoder CN login failed: jobToken exchange returned no refresh_token (jrt). Cannot persist a refreshable session without embedding the PAT; retry or contact the tenant admin."
        : "Qoder login failed: jobToken exchange returned no refresh_token (jrt). Cannot persist a refreshable session without embedding the PAT.",
    );
  }
  const machineID = getMachineId();
  const refresh = encodeJobRefresh(jobRefreshToken, userID, machineID);
  const refreshParts = refresh.split("|");
  if (refreshParts.some((part) => part === pat || part.startsWith("pt-"))) {
    throw new Error("Refusing to return credentials that embed a plaintext PAT in refresh");
  }

  return {
    refresh,
    access: jobToken,
    expires: expiresAt - 5 * 60 * 1000, // 5 min buffer
    userID,
    email: email || getQoderUserEmailFallback(mode),
    name: name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
    machineID,
  } as OAuthCredentials;
}

/**
 * Build credentials from a job refresh token response / existing identity.
 * Never accepts or stores a PAT.
 */
export function credentialsFromJobTokens(
  exchange: PatExchangeResult,
  identity: { userID: string; email?: string; name?: string; machineID?: string },
  mode: string = getQoderMode(),
): OAuthCredentials {
  if (!identity.userID) {
    throw new Error("Cannot build Qoder credentials without userID");
  }
  if (!exchange.jobRefreshToken) {
    throw new Error("Cannot build refreshable Qoder credentials without jrt refresh_token");
  }
  const machineID = identity.machineID || getMachineId();
  const refresh = encodeJobRefresh(exchange.jobRefreshToken, identity.userID, machineID);
  return {
    refresh,
    access: exchange.jobToken,
    expires: exchange.expiresAt - 5 * 60 * 1000,
    userID: identity.userID,
    email: identity.email || getQoderUserEmailFallback(mode),
    name: identity.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
    machineID,
  } as OAuthCredentials;
}
