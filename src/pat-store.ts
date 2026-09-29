import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getQoderOpenApiUrl } from "./cosy.js";

export function getQoderPatStorageDescription(): string {
  return process.platform === "android"
    ? "a plaintext file in the private agent directory (permissions 0600)"
    : "the system credential store";
}

function requireAccount(userID: string): void {
  if (!userID) throw new Error("Qoder PAT storage requires an account identity");
}

function patFile(userID: string, mode: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify([getQoderOpenApiUrl(mode), userID]))
    .digest("hex");
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "qoder-pats", `${key}.pat`);
}

async function savePatFile(pat: string, userID: string, mode: string): Promise<void> {
  const path = patFile(userID, mode);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    if ((await stat(dirname(path))).mode & 0o077) {
      throw new Error("PAT storage requires a private directory");
    }
    await writeFile(temporary, pat, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function patEntry(userID: string, mode: string) {
  // Android has no supported binding. Other platforms load the optional native
  // package only when storage is needed, never while registering the provider.
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(`pi-qoder-provider:${getQoderOpenApiUrl(mode)}`, userID, {
    // The default Linux fallback is memory-only and loses credentials on reboot.
    linux: { store: "secret-service" },
  });
}

export async function saveQoderPat(pat: string, userID: string, mode: string): Promise<void> {
  try {
    requireAccount(userID);
    if (process.platform === "android") {
      await savePatFile(pat, userID, mode);
      return;
    }
    await (await patEntry(userID, mode)).setPassword(pat);
  } catch {
    // Native errors must not echo the secret being saved.
    if (process.platform === "android") {
      throw new Error(
        "Qoder could not save the PAT in the private agent directory. Check directory permissions and retry login. " +
          "Keep PI_CODING_AGENT_DIR inside Termux private storage, not shared /sdcard storage.",
      );
    }
    throw new Error(
      "Qoder could not save the PAT in the system credential store. Install optional dependencies and unlock " +
        "macOS Keychain / Windows Credential Manager, or enable a persistent Secret Service on Linux, " +
        "then retry login. The PAT was not saved to auth.json.",
    );
  }
}

export async function loadQoderPat(userID: string, mode: string): Promise<string | undefined> {
  try {
    requireAccount(userID);
    if (process.platform === "android") {
      try {
        return await readFile(patFile(userID, mode), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    const secret = await (await patEntry(userID, mode)).getSecret();
    // Native backends may return null although the TypeScript binding declares undefined.
    return secret == null ? undefined : Buffer.from(secret).toString("utf8");
  } catch {
    if (process.platform === "android") {
      throw new Error(
        "Qoder could not read the saved PAT in the private agent directory. Check directory permissions and retry; " +
          "this is not a token-expiry error.",
      );
    }
    throw new Error(
      "Qoder could not read the saved PAT. Install optional dependencies and unlock the system credential store, " +
        "then retry; this is not a token-expiry error.",
    );
  }
}
