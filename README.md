# pi-qoder-provider

English | [中文](./README.zh-CN.md)

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Qoder API**, exposing Qoder Global and Qoder China models through provider surfaces.

Published on npm as `pi-qoder-provider` (GitHub repo remains `minglu6/pi-provider-qoder`).

## Instructions for AI agents

Copy-paste this block when asking an agent to install and configure this plugin:

```text
Install and enable the Qoder provider for OMP/pi:

1. Install:
   omp plugin uninstall pi-qoder-provider
   omp plugin uninstall pi-provider-qoder
   omp plugin install npm:pi-qoder-provider
2. Fully quit and restart OMP (not just a new chat).
3. Verify: omp plugin list && omp plugin doctor
4. Run /login. China login prompts for the VPC instance/URL and PAT, then saves them
   after successful authentication. Subsequent startup and renewal need no PAT or VPC environment variables.

Choose ONE profile:

A) Global / international:
   Run /login qoder and enter a PAT (or choose browser login).

B) China public cloud:
   Run /login qoder-cn, leave the VPC prompt empty (or enter public), then enter a CN PAT.

C) China enterprise VPC (most common failure if missed):
   Run /login qoder-cn, enter the instance name or tenant URL, then a PAT issued by that tenant.

Hard rules:
- Enter the VPC address during login; the provider derives -gateway / -openapi hosts.
- Existing routing environment variables override saved configuration. Remove them to edit the instance during login.
- Complete /login first. PAT environment variables are optional login inputs, not a renewal requirement.
- Never put PAT values into git, README, or chat logs.
- Prefer provider qoder-cn for China/VPC; do not guess public hosts for VPC tenants.
```

## Features

- **Two provider entries**:
  - `qoder` — Global / international Qoder.
  - `qoder-cn` — Qoder China, forced to CN endpoints and independent of `QODER_REGION`.
- **Interactive Login**: Global Qoder supports browser device-code flow or Personal Access Token (PAT) login.
- **Qoder CN PAT Login**: China edition uses a separate PAT login entry (`/login qoder-cn`) and CN token exchange endpoints.
- **WAF Bypass**: Built-in WAF obfuscation and body encoding (`Encode=1`).
- **COSY Signing**: Full COSY signature header generation (RSA/AES-CBC/MD5).
- **Dynamic Model Catalog**: Dynamically fetches model limits, effort configurations, and options from the `/algo/api/v2/model/list` endpoint.
- **Reasoning/Thinking Support**: Maps the API's explicit `reasoning_content` field without interpreting tags in ordinary text.

## Quick Start

### Install

#### 1. npm registry (recommended)

```bash
# Remove older copies if present
omp plugin uninstall pi-qoder-provider
omp plugin uninstall pi-provider-qoder

omp plugin install npm:pi-qoder-provider
# or
npm install -g pi-qoder-provider
```

Restart OMP fully (quit all windows, not just open a new chat), then verify:

```bash
omp plugin list
omp plugin doctor
```

You should see `pi-qoder-provider` enabled, with `pi.extensions` pointing at `./src/index.ts`.

#### 2. OMP git install

```bash
omp plugin install github:minglu6/pi-provider-qoder
```

#### 3. Local clone (for contributors / debugging)

```bash
git clone https://github.com/minglu6/pi-provider-qoder.git
cd pi-provider-qoder
npm install
omp plugin link "$(pwd)"
```

After `git pull`, restart OMP (and rebuild with `npm run build` if you rely on `dist/`).

#### 4. Android / Termux

Starting with 0.3.1, installing the source package does not run a build or require `esbuild`. Pi loads `src/index.ts` directly; `npm run build` is only needed for development or publishing.

```bash
# Pi: install from GitHub, or update the same source if already installed
pi install git:github.com/minglu6/pi-provider-qoder
# Existing GitHub installation:
pi update git:github.com/minglu6/pi-provider-qoder
```

For OMP, use `omp plugin install github:minglu6/pi-provider-qoder`. Keep only one enabled copy of the provider; remove an older npm installation before switching sources. Fully restart the host, then run `/login qoder-cn` once.

On native Android (`process.platform === "android"`), the provider never loads the native keyring package. PATs are stored as **plaintext** in `~/.pi/agent/qoder-pats/` (or `$PI_CODING_AGENT_DIR/qoder-pats/`), with directory permissions `0700` and file permissions `0600`. Each OpenAPI endpoint/account has a separate file; writes are atomic. Keep the agent directory inside Termux private storage, not shared `/sdcard` storage. File permissions are not encryption and do not protect against root or compromised processes running as the same user.

### Login

Global / international edition:

```text
/login qoder
```

China / VPC edition:

```text
/login qoder-cn
```

In CN/VPC environments, `/provider` may show two Qoder rows from the same plugin: `Qoder CN (PAT)` (`qoder-cn`) and `Qoder (CN mode / PAT)` (`qoder`). Use the logged-in `qoder-cn` entry for VPC.

Without explicit routing environment variables, China login asks for the VPC instance/URL before the PAT. An empty first selection uses China public cloud; on later logins, Enter keeps the saved instance and `public` switches back to public cloud. New routing is saved only after successful authentication; cancellation or failure leaves the previous instance unchanged.

### Personal Access Token (PAT)

A Qoder PAT (`pt-...`) cannot authenticate API calls directly — the provider exchanges it for a short-lived job token (mirroring the official `qodercli` / `qoderclicn` flow) and resolves your account identity automatically.

**Global Qoder:**

- Run `/login qoder` and choose **Use API Key (PAT)**, then paste the token.
- Or set `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) before starting pi, then run `/login qoder`.

**Qoder China:**

- Run `/login qoder-cn`, choose the VPC / China public cloud, then paste the CN PAT.
- Or set `QODERCN_PERSONAL_ACCESS_TOKEN` (or `QODERCN_PAT`) before starting pi, then run `/login qoder-cn`.
- `QODER_API_KEY` is accepted as a CN PAT alias **only** when the value starts with `pt-`.

After successful login, the PAT is saved in **macOS Keychain / Windows Credential Manager / Linux Secret Service**, or **private plaintext files on Android/Termux** as described above, scoped by OpenAPI endpoint and account. Host credentials (`auth.json`) still contain only short-lived tokens and the JRT, never the plaintext PAT.

- Normal renewal uses `POST /api/v1/jobToken/refresh`. If the JRT is explicitly rejected or expired, the provider automatically exchanges the saved PAT. No PAT environment variable is needed.
- If a request returns an explicit expired-login error (including HTTP 200 SSE wrapping `403 / code 105 / Login expired`), the provider asks the host to renew and persist credentials, then retries once before any assistant content or tool call is emitted. Concurrent failures share renewal. Ordinary permission errors, partial responses and cancelled requests are not replayed. Pi 1.x runtime, older Pi AuthStorage and OMP credential APIs are supported.
- Network failures, rate limits and server 5xx errors are propagated without PAT exchange or a misleading re-login instruction. If the server rejects the PAT itself, run `/login` again with a valid PAT.
- Existing JRT-only sessions need one more login after upgrading and restarting Pi to save the PAT. Legacy credentials embedding a PAT migrate it into the platform-appropriate store after successful renewal.
- On desktop/server platforms, the system credential store must be available and unlocked. Install optional dependencies; Linux requires a persistent Secret Service (such as GNOME Keyring / KWallet). A missing or locked native store never silently falls back to plaintext files. Android deliberately uses the file store instead. Login fails explicitly if the PAT cannot be saved.
- Saved PAT bytes are decoded using the native password encoding: UTF-16LE on Windows, UTF-8 on macOS/Linux. Store-access failures remain explicit rather than being treated as missing credentials. Windows SSH logon sessions may not have access to Credential Manager; use the logged-in desktop session for authentication.
- `/logout` removes the host session but does not remove the saved PAT: Pi exposes no provider logout callback. The provider does not automatically create a new login from the saved PAT alone. To remove it completely, delete the system credential entry with service `pi-qoder-provider:<OpenAPI URL>` and the relevant userID as account. On Android, removing `qoder-pats/` deletes saved PATs for all accounts in that agent directory. Revoke the PAT in Qoder to invalidate access.

**Both the PAT and enterprise VPC configuration can be saved through one interactive login, without any Qoder environment variables.** The PAT uses the platform-appropriate store; the non-secret instance configuration goes into a separate local file.

### Region environment variables

```bash
export QODER_REGION=cn       # or QODER_BACKEND=cn / QODER_MODE=cn
```

Setting a CN PAT without a global PAT also auto-selects CN mode for the `qoder` entry, but the recommended explicit China entry is still `/login qoder-cn` and `--provider qoder-cn`.

### Enterprise VPC

Run `/login qoder-cn` and enter the instance name at the VPC prompt, for example:

```text
sungrow-of-enterprise
```

You can also paste `https://sungrow-of-enterprise.vpc.qoder.com.cn` or its `-gateway` / `-openapi` URL. Then enter a PAT issued by that tenant.

After successful authentication, the normalized instance is saved to `~/.pi/agent/qoder-cn-config.json` (or the directory specified by `PI_CODING_AGENT_DIR`), for example:

```json
{ "vpcInstance": "sungrow-of-enterprise" }
```

This file never contains the PAT. It is loaded automatically after restart and shared by login, model discovery, chat, usage and token renewal. Log in again to change the instance, or enter `public` to save China public cloud routing. Restart Pi after manual edits to this file. Logging out does not clear this non-secret configuration.

The provider derives the service-specific hosts expected by Qoder VPC:

- `https://<instance>-gateway.vpc.qoder.com.cn`
- `https://<instance>-openapi.vpc.qoder.com.cn`

Existing environment variables remain **explicit overrides**, not requirements: `QODER_VPC_INSTANCE`, `QODER_VPC_ENDPOINT`, `QODERCN_VPC_ENDPOINT`, `QODERCN_CLI_VPC_ENDPOINT`, and `QODER_CN_BASE_URL`, `QODER_CN_OPENAPI_URL`, `QODER_CN_CENTER_URL`. With an override, login announces environment routing and skips the VPC prompt. Successful login also saves a recognizable VPC instance, allowing you to remove the environment variables afterward. Arbitrary custom API URLs remain environment-only overrides and are not saved as instance configuration.

> `<instance>.vpc.qoder.com.cn` is the tenant dashboard host, not an API host. Sending PAT exchange or COSY chat there returns `CSRFInvalid` because it hits web/session middleware. Always use the derived `-gateway` / `-openapi` hosts above.

Use a PAT created by the VPC tenant (for example from `https://<instance>.vpc.qoder.com.cn/account/integrations`). A public/global PAT exchanged against the tenant OpenAPI host fails with `open_access_token not found`. The exchange payload must remain `personal_token`; verify PAT provisioning with the tenant administrator.

For safe request diagnostics, set `QODER_COSY_DEBUG=1`. Logs include the URL, status, and non-secret COSY signature inputs, but never credentials, Authorization, `Cosy-Key`, or machine identifiers.

## Stream safety and diagnostics

- Remote session IDs are scoped to the host's `sessionId`, account, region and model, not shared across every chat. Calls without a host session ID get a fresh remote session. Tool-free summarization is separated from tool-enabled chat.
- Host system instructions are sent as the first `messages` entry with `role: "system"`; the gateway does not apply a standalone top-level `system` field. Legacy host prompt strings/ordered arrays (OMP) and transcript prompt updates (Pi) use this path. Prompt sections retain their order and are joined with blank lines. The provider adds no instructions of its own.
- Token usage is read from upstream snapshots, including usage-only terminal chunks and cached prompt tokens. Missing usage is not fabricated. `length`, errors and disconnected streams are no longer reported as a successful `stop`.
- The provider is a protocol gateway, not an answer-quality judge. It does not classify user intent, filter summaries/checkpoints, inject corrective prompts, or regenerate ordinary answers. Text, reasoning-only and empty responses normally follow upstream completion status; `stop` is a transport termination, not a claim that the user's task succeeded.
- Only `reasoning_content` maps to thinking; ordinary `content` stays literal, including XML/code examples. Tool-enabled DeepSeek requests use the bounded DSML recovery below. Reasoning content is never executed as a tool call.
- Channel transitions preserve order, whitespace and paired end events. Structured tool calls must have a nonblank ID/name and valid object arguments before any tool call is finalized.
- User and tool-result images retain their ordered text/image parts. Historical assistant reasoning is sent in `reasoning_content`, never injected into the answer body. Tool images and reasoning history were verified with the Qoder CN enterprise gateway.
- Thinking modes follow the live catalog. Supported off mode sends `enable_thinking: false`, `reasoning_effort: "none"` and matching model flags; supported efforts enable thinking. Pi's omitted reasoning option means off where the catalog supports it. Explicit unsupported toggles fail rather than silently changing modes. `temperature`, including zero, is forwarded without choosing a provider default.
- Ordinary custom headers are merged case-insensitively; null removes a default header. Overrides/removal of authentication, COSY, routing and body-framing headers are rejected before sending. Request identities include generation parameters and model configuration so mode/temperature changes cannot alias a prior request.
- Authentication expiry may trigger one credential refresh and request retry before any assistant content is received. This transport recovery preserves the conversation and has a separate retry allowance from DSML protocol recovery. Host inspection hooks may still modify payloads explicitly.
- The provider honors host `onPayload`, `onResponse`, and (when available) `onProviderStreamEvent` inspection hooks. No prompt, response or credential logging is enabled automatically. Use opt-in inspection carefully; these hooks can expose sensitive conversation data.

### DeepSeek tool-call recovery

- Complete, unquoted DSML calls starting on a line are recovered as standard tool events. Supported forms include `calls / tool_calls / function_calls`, single/double-bar markers and complete `invoke` blocks without an outer wrapper. Names must exactly match offered tools, and every call in a batch must pass host schema validation before dispatch. Parameters are not renamed, coerced or guessed.
- Dangling trailers, incomplete calls and invalid arguments permit one regeneration only if no native tool call was received on that turn. It uses the original valid history and fresh remote session/request IDs with `is_retry`, without adding the damaged response or corrective instructions. A second failure is an explicit error and dispatches no calls from that batch. Regeneration may incur an extra charge; reported token usage from both attempts is summed.
- Native `tool_calls` take precedence: no body recovery or regeneration is attempted alongside them, preventing duplicate dispatch. Cancellation, `length` and HTTP/SSE transport errors do not trigger DSML regeneration. Recovery is disabled if `onPayload` changes offered tools or disables tool calls.
- Text/thinking events are buffered until validated or a native call appears; native calls then stream normally. Text-only responses therefore become visible at turn completion. Known damaged assistant turns without structured calls are excluded from outgoing history, while valid tool/result pairs and host-owned session files remain unchanged.
- Fenced code, inline code, blockquotes and tool-free requests remain literal. **Limitation:** Qoder supplies no special-token IDs. Unquoted text that exactly forms a complete invocation of an offered tool cannot be perfectly distinguished from a real DSML call; use code fences for protocol examples. This is client-side recovery, not a fix to upstream generation. Raw responses remain inspectable through the opt-in `onProviderStreamEvent` hook.


## Endpoints

**Global:**

- PAT exchange: `https://openapi.qoder.sh/api/v1/jobToken/exchange`
- Job-token refresh: `https://openapi.qoder.sh/api/v1/jobToken/refresh`
- User info: `https://openapi.qoder.sh/api/v1/userinfo`
- Usage: `https://openapi.qoder.sh/api/v2/quota/usage`
- Model / chat gateway: `https://api3.qoder.sh/algo/api/v2/...`

**China:**

- PAT exchange: `https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- Job-token refresh: `https://openapi.qoder.com.cn/api/v1/jobToken/refresh`
- User info: `https://openapi.qoder.com.cn/api/v1/userinfo`
- Usage: `https://openapi.qoder.com.cn/api/v2/quota/usage`
- Model / chat gateway: `https://gateway.qoder.com.cn/algo/api/v2/...`

Enterprise VPC (when `QODER_VPC_INSTANCE=<instance>` is set) uses the derived `-openapi` / `-gateway` hosts under `*.vpc.qoder.com.cn` instead of the public China hosts above.

## Models

### Global `qoder`

Exposes the backing model keys returned by Qoder, including:

- **Tier Models**: `auto`, `ultimate`, `performance`, `efficient`, `lite`
- **Frontier Models**:
  - `qmodel` (Qwen3.7 Plus)
  - `qmodel_latest` (Qwen3.7 Max)
  - `dmodel` (DeepSeek V4 Pro)
  - `dfmodel` (DeepSeek V4 Flash)
  - `gm51model` (GLM)
  - `kmodel` (Kimi)
  - `mmodel` (MiniMax)

### China `qoder-cn`

The China provider exposes friendly model IDs and maps them back to Qoder CN's internal keys at request time:

| Friendly ID | Qoder CN key | Context | Images | Reasoning |
| --- | --- | ---: | :---: | :---: |
| `auto` | `auto` | 180K | ✅ | ✅ |
| `qwen3.7-max` | `qmodel_latest` | 1M | ✅ | ✅ |
| `qwen3.7-plus` | `qmodel` | 1M | ❌ | ✅ |
| `qwen3.6-flash` | `q36fmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-pro` | `dmodel` | 1M | ❌ | ✅ |
| `deepseek-v4-flash` | `dfmodel` | 1M | ❌ | ❌ |
| `glm-5.2` | `gm51model` | 200K | ✅ | ✅ |
| `kimi-k2.6` | `kmodel` | 256K | ✅ | ✅ |
| `minimax-m2.7` | `mmodel` | 200K | ❌ | ❌ |

Compatibility aliases are also accepted for request mapping, such as `qwen3.6-plus` → `qmodel`, `glm-5.1` → `gm51model`, and `minimax-m3` → `mmodel`.

## Usage

Once logged in, select any Qoder model in pi:

```text
/model qwen3.7-plus
```

Or start directly:

```bash
pi --provider qoder-cn --model qwen3.7-plus
```

Global example:

```bash
pi --provider qoder --model auto
```

## Architecture

```text
src/
├── index.ts            # Extension registration
├── cosy.ts             # COSY signature, machine ID, region/endpoints, CN model aliases
├── login.ts            # OAuth device flow + PAT login sequence
├── oauth.ts            # PAT / OAuth callback orchestrator
├── pat.ts              # PAT → job-token exchange + identity resolution
├── models.ts           # Model definitions and dynamic config cache
├── stream.ts           # Main streaming response handler
├── transform.ts        # Message conversions (OpenAI schema mapping)
├── usage.ts            # Usage / quota tracking
└── qoder-encoding.ts   # WAF bypass body encoder
```

## License

MIT
