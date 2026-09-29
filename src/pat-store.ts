import { AsyncEntry } from "@napi-rs/keyring";
import { getQoderOpenApiUrl } from "./cosy.js";

function patEntry(userID: string, mode: string) {
  if (!userID) throw new Error("Qoder PAT storage requires an account identity");
  return new AsyncEntry(`pi-qoder-provider:${getQoderOpenApiUrl(mode)}`, userID, {
    // The default Linux fallback is memory-only and loses credentials on reboot.
    linux: { store: "secret-service" },
  });
}

export async function saveQoderPat(pat: string, userID: string, mode: string): Promise<void> {
  try {
    await patEntry(userID, mode).setPassword(pat);
  } catch {
    // Native errors must not echo the secret being saved.
    throw new Error(
      "Qoder could not save the PAT in the system credential store. Unlock macOS Keychain / Windows Credential Manager, " +
        "or enable a persistent Secret Service on Linux, then retry login. The PAT was not saved to auth.json.",
    );
  }
}

export async function loadQoderPat(userID: string, mode: string): Promise<string | undefined> {
  try {
    const secret = await patEntry(userID, mode).getSecret();
    // Native backends may return null although the TypeScript binding declares undefined.
    return secret == null ? undefined : Buffer.from(secret).toString("utf8");
  } catch {
    throw new Error(
      "Qoder could not read the saved PAT. Unlock the system credential store and retry; this is not a token-expiry error.",
    );
  }
}
