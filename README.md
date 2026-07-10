# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Qoder API**, exposing Qoder Global and Qoder China models through provider surfaces.

## Features

- **Two provider entries**:
  - `qoder` — Global / international Qoder.
  - `qoder-cn` — Qoder China, forced to CN endpoints and independent of `QODER_REGION`.
- **Interactive Login**: Global Qoder supports browser device-code flow or Personal Access Token (PAT) login.
- **Qoder CN PAT Login**: China edition uses a separate PAT login entry (`/login qoder-cn`) and CN token exchange endpoints.
- **WAF Bypass**: Built-in WAF obfuscation and body encoding (`Encode=1`).
- **COSY Signing**: Full COSY signature header generation (RSA/AES-CBC/MD5).
- **Dynamic Model Catalog**: Dynamically fetches model limits, effort configurations, and options from the `/algo/api/v2/model/list` endpoint.
- **Reasoning/Thinking Support**: Real-time extraction of thinking process from API reasoning or HTML-like `<think>` tags.

## Quick Start

### Install

#### 1. OMP git install (recommended)

```bash
# Remove older copy if present
omp plugin uninstall pi-provider-qoder

omp plugin install github:minglu6/pi-provider-qoder
```

Restart OMP fully (quit all windows, not just open a new chat), then verify:

```bash
omp plugin list
omp plugin doctor
```

You should see `pi-provider-qoder` enabled, with `pi.extensions` pointing at `./src/index.ts`.

#### 2. Local clone (for contributors / debugging)

```bash
git clone https://github.com/minglu6/pi-provider-qoder.git
cd pi-provider-qoder
npm install
omp plugin link "$(pwd)"
```

After `git pull`, restart OMP (and rebuild with `npm run build` if you rely on `dist/`).

#### 3. npm registry

```bash
omp plugin install npm:pi-provider-qoder
# or
npm install -g pi-provider-qoder
```

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

### Personal Access Token (PAT)

A Qoder PAT (`pt-...`) cannot authenticate API calls directly — the provider exchanges it for a short-lived job token (mirroring the official `qodercli` / `qoderclicn` flow) and resolves your account identity automatically.

**Global Qoder:**

- Run `/login qoder` and choose **Use API Key (PAT)**, then paste the token.
- Or set `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) before starting pi.

**Qoder China:**

- Run `/login qoder-cn`, then paste the CN PAT.
- Or set `QODERCN_PERSONAL_ACCESS_TOKEN` (or `QODERCN_PAT`) before starting pi.
- `QODER_API_KEY` is accepted as a CN PAT alias **only** when the value starts with `pt-`.

> The exchanged job token (`jt-...`) is short-lived. After login the provider persists a **job refresh token** (`jrt-...`) only — it does **not** store the plaintext PAT. When the job token expires, the provider calls `POST /api/v1/jobToken/refresh`. If refresh fails, log in again with a PAT.

### Region environment variables

```bash
export QODER_REGION=cn       # or QODER_BACKEND=cn / QODER_MODE=cn
```

Setting a CN PAT without a global PAT also auto-selects CN mode for the `qoder` entry, but the recommended explicit China entry is still `/login qoder-cn` and `--provider qoder-cn`.

### Enterprise VPC

Set the VPC instance name shown before `.vpc.qoder.com.cn`:

```bash
export QODER_VPC_INSTANCE=sungrow-of-enterprise
```

The provider derives the service-specific hosts expected by Qoder VPC:

- `https://<instance>-gateway.vpc.qoder.com.cn`
- `https://<instance>-openapi.vpc.qoder.com.cn`

`QODER_VPC_ENDPOINT` and the official CLI variable `QODERCN_VPC_ENDPOINT` are accepted as aliases. The legacy `QODERCN_CLI_VPC_ENDPOINT` spelling is also accepted. Existing `QODER_CN_BASE_URL`, `QODER_CN_OPENAPI_URL`, and `QODER_CN_CENTER_URL` overrides remain supported; when they contain the tenant dashboard host, the provider normalizes them to the corresponding gateway or OpenAPI host.

> `<instance>.vpc.qoder.com.cn` is the tenant dashboard host, not an API host. Sending PAT exchange or COSY chat there returns `CSRFInvalid` because it hits web/session middleware. Always use the derived `-gateway` / `-openapi` hosts above.

Use a PAT created by the VPC tenant (for example from `https://<instance>.vpc.qoder.com.cn/account/integrations`). A public/global PAT exchanged against the tenant OpenAPI host fails with `open_access_token not found`. The exchange payload must remain `personal_token`; verify PAT provisioning with the tenant administrator.

For safe request diagnostics, set `QODER_COSY_DEBUG=1`. Logs include the URL, status, and non-secret COSY signature inputs, but never credentials, Authorization, `Cosy-Key`, or machine identifiers.

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
├── thinking-parser.ts  # Fallback <think> tag parser
└── qoder-encoding.ts   # WAF bypass body encoder
```

## License

MIT
