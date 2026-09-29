import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export const QoderVPCDomain = "vpc.qoder.com.cn";

interface VPCConfig {
  vpcInstance: string | null;
}

// A login attempt must not redirect requests from the existing session before it succeeds.
const loginRouting = new AsyncLocalStorage<VPCConfig>();
let savedConfig: { path: string; config: VPCConfig } | undefined;

function configPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "qoder-cn-config.json");
}

function parseQoderVPCInstance(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  let candidate = value.trim().toLowerCase();
  try {
    candidate = new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname;
  } catch {
    return undefined;
  }
  const suffix = `.${QoderVPCDomain}`;
  if (candidate.endsWith(suffix)) {
    candidate = candidate.slice(0, -suffix.length);
    if (candidate.endsWith("-gateway") || candidate.endsWith("-openapi")) {
      candidate = candidate.slice(0, -8);
    }
  } else if (candidate.includes(".")) {
    return undefined;
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate) ? candidate : undefined;
}

function environmentEndpoint(): string | undefined {
  return (
    process.env.QODER_VPC_INSTANCE ||
    process.env.QODER_VPC_ENDPOINT ||
    process.env.QODERCN_VPC_ENDPOINT ||
    process.env.QODERCN_CLI_VPC_ENDPOINT ||
    process.env.QODER_CN_BASE_URL ||
    process.env.QODER_CN_OPENAPI_URL ||
    process.env.QODER_CN_CENTER_URL
  );
}

function readConfig(): VPCConfig {
  const path = configPath();
  if (savedConfig?.path === path) return savedConfig.config;
  let config: VPCConfig = { vpcInstance: null };
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as VPCConfig;
      if (
        data.vpcInstance !== null &&
        (typeof data.vpcInstance !== "string" || parseQoderVPCInstance(data.vpcInstance) !== data.vpcInstance)
      )
        throw new Error("Invalid VPC instance");
      config = { vpcInstance: data.vpcInstance };
    } catch {
      // Never silently route an existing tenant's credentials to the public cloud.
      throw new Error(`Cannot read Qoder CN routing configuration: ${path}. Repair or remove this file before login.`);
    }
  }
  savedConfig = { path, config };
  return config;
}

function saveConfig(config: VPCConfig): void {
  const path = configPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    savedConfig = { path, config };
  } catch {
    throw new Error(
      `Could not save Qoder CN routing configuration: ${path}. Check directory permissions and retry login.`,
    );
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function getQoderVPCInstance(endpointOverride?: string): string | undefined {
  const explicit = endpointOverride || environmentEndpoint();
  // Explicit custom/public endpoints must not fall back to a saved tenant.
  if (explicit) return parseQoderVPCInstance(explicit);
  return (loginRouting.getStore() || readConfig()).vpcInstance || undefined;
}

/** Select routing before asking for a PAT; commit it only after authentication succeeds. */
export async function loginWithQoderVPC<T>(callbacks: OAuthLoginCallbacks, login: () => Promise<T>): Promise<T> {
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");
  const explicit = environmentEndpoint();
  if (explicit) {
    callbacks.onProgress?.("Using Qoder CN routing from environment variables (overrides saved configuration).");
    const result = await login();
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");
    const instance = parseQoderVPCInstance(explicit);
    // Preserve compatibility with custom API endpoints; only VPC instances are persisted.
    if (instance) saveConfig({ vpcInstance: instance });
    return result;
  }

  const previous = readConfig();
  let selected: VPCConfig;
  for (;;) {
    const answer = (
      await callbacks.onPrompt({
        message: previous.vpcInstance
          ? `Qoder CN VPC instance or URL (current: ${previous.vpcInstance}). Enter to keep; type public for China public cloud`
          : "Qoder CN enterprise VPC instance or URL; leave empty for China public cloud",
        placeholder: previous.vpcInstance || "tenant-name / https://tenant-name.vpc.qoder.com.cn",
        allowEmpty: true,
      })
    ).trim();
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");
    if (!answer) {
      selected = previous;
      break;
    }
    if (answer.toLowerCase() === "public") {
      selected = { vpcInstance: null };
      break;
    }
    const instance = parseQoderVPCInstance(answer);
    if (instance) {
      selected = { vpcInstance: instance };
      break;
    }
    callbacks.onProgress?.("Invalid VPC address. Enter an instance name or a *.vpc.qoder.com.cn URL, or type public.");
  }

  return loginRouting.run(selected, async () => {
    const result = await login();
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");
    saveConfig(selected);
    callbacks.onProgress?.("Qoder CN routing saved. VPC environment variables are no longer required.");
    return result;
  });
}
