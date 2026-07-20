# pi-qoder-provider

[English](./README.md) | 中文

[pi](https://shittycodingagent.ai/) 的 Qoder API 提供方扩展，可在 pi 中使用 **Qoder 国际版** 与 **Qoder 中国版** 模型。

npm 包名：`pi-qoder-provider`（GitHub 仓库仍为 `minglu6/pi-provider-qoder`）。

## 发给智能体的指令

需要智能体帮你安装/配置时，直接把下面整段发给它：

```text
请为 OMP/pi 安装并启用 Qoder provider：

1. 安装：
   omp plugin uninstall pi-qoder-provider
   omp plugin uninstall pi-provider-qoder
   omp plugin install npm:pi-qoder-provider
2. 完全退出并重启 OMP（不是只开新对话）。
3. 验证：omp plugin list && omp plugin doctor
4. 【必须】在启动 OMP/pi 的同一个 shell 里先设置环境变量。
   不设置环境变量则无法鉴权，provider 不可用。

按场景只选一套：

A) 国际版：
   export QODER_PERSONAL_ACCESS_TOKEN=pt-...   # 或 QODER_PAT
   然后：/login qoder   或：pi --provider qoder --model auto

B) 中国公有云：
   export QODER_REGION=cn
   export QODERCN_PERSONAL_ACCESS_TOKEN=pt-...   # 或 QODERCN_PAT
   然后：/login qoder-cn   或：pi --provider qoder-cn --model auto

C) 中国企业 VPC（最容易漏配）：
   export QODER_REGION=cn
   export QODER_VPC_INSTANCE=<instance>   # 即 xxx.vpc.qoder.com.cn 里的 xxx
   export QODERCN_PERSONAL_ACCESS_TOKEN=pt-...   # 必须是该 VPC 租户签发的 PAT
   然后：/login qoder-cn   或：pi --provider qoder-cn --model auto

硬性规则：
- 不要跳过环境变量，只靠 /login 解决不了 VPC 路由。
- 未设置 QODER_VPC_INSTANCE（或 QODERCN_VPC_ENDPOINT）时，VPC 登录/调用会失败
  （常见 CSRFInvalid / 打到错误主机）。
- 未设置 PAT 环境变量且未成功 /login 时，请求会报 credentials not set。
- 禁止把 PAT 写入 git、README 或聊天记录。
- 中国/VPC 优先使用 provider qoder-cn，不要猜公网域名给 VPC 租户用。
```

## 功能

- **两个 Provider 入口**：
  - `qoder` — 国际版 / Global Qoder
  - `qoder-cn` — 中国版，固定走 CN 端点，不受 `QODER_REGION` 影响
- **交互式登录**：国际版支持浏览器设备码流程，或 Personal Access Token（PAT）登录
- **中国版 PAT 登录**：独立入口 `/login qoder-cn`，使用 CN 的 token 兑换接口
- **WAF 绕过**：内置 WAF 混淆与请求体编码（`Encode=1`）
- **COSY 签名**：完整 COSY 请求头签名（RSA / AES-CBC / MD5）
- **动态模型目录**：从 `/algo/api/v2/model/list` 拉取模型限额、effort 配置等
- **思考链支持**：从 API reasoning 或类 HTML 的 `<think>` 标签实时提取思考过程

## 快速开始

### 安装

#### 1. npm（推荐）

```bash
# 如有旧版本可先卸载
omp plugin uninstall pi-qoder-provider
omp plugin uninstall pi-provider-qoder

omp plugin install npm:pi-qoder-provider
# 或
npm install -g pi-qoder-provider
```

完全退出并重启 OMP（不是只开新对话），然后检查：

```bash
omp plugin list
omp plugin doctor
```

应能看到 `pi-qoder-provider` 已启用，且 `pi.extensions` 指向 `./src/index.ts`。

#### 2. 从 GitHub 安装

```bash
omp plugin install github:minglu6/pi-provider-qoder
```

#### 3. 本地克隆（开发 / 调试）

```bash
git clone https://github.com/minglu6/pi-provider-qoder.git
cd pi-provider-qoder
npm install
omp plugin link "$(pwd)"
```

`git pull` 之后请重启 OMP；若依赖 `dist/`，再执行 `npm run build`。

### 登录

国际版：

```text
/login qoder
```

中国版 / VPC：

```text
/login qoder-cn
```

在 CN/VPC 环境下，`/provider` 可能出现同一插件的两行：`Qoder CN (PAT)`（`qoder-cn`）与 `Qoder (CN mode / PAT)`（`qoder`）。VPC 请使用已登录的 `qoder-cn`。

### Personal Access Token（PAT）

Qoder PAT（`pt-...`）不能直接调 API。本扩展会把它兑换成短期 job token（流程对齐官方 `qodercli` / `qoderclicn`），并自动解析账号身份。

**国际版：**

- 执行 `/login qoder`，选择 **Use API Key (PAT)**，粘贴 token
- 或启动 pi 前设置 `QODER_PERSONAL_ACCESS_TOKEN`（或 `QODER_PAT`）

**中国版：**

- 执行 `/login qoder-cn`，粘贴 CN PAT
- 或启动 pi 前设置 `QODERCN_PERSONAL_ACCESS_TOKEN`（或 `QODERCN_PAT`）
- 仅当值以 `pt-` 开头时，`QODER_API_KEY` 才会被当作 CN PAT 别名

> 兑换得到的 job token（`jt-...`）有效期很短。登录后只持久化 **job refresh token**（`jrt-...`），**不会**保存明文 PAT。job token 过期时会调用 `POST /api/v1/jobToken/refresh`；刷新失败请重新用 PAT 登录。

### 区域环境变量

```bash
export QODER_REGION=cn       # 或 QODER_BACKEND=cn / QODER_MODE=cn
```

仅配置 CN PAT、未配置国际版 PAT 时，`qoder` 入口也会自动切到 CN 模式；中国版仍建议显式使用 `/login qoder-cn` 与 `--provider qoder-cn`。

### 企业 VPC

设置 `.vpc.qoder.com.cn` 前面的实例名：

```bash
export QODER_VPC_INSTANCE=sungrow-of-enterprise
```

扩展会推导 Qoder VPC 所需的业务域名：

- `https://<instance>-gateway.vpc.qoder.com.cn`
- `https://<instance>-openapi.vpc.qoder.com.cn`

也接受别名 `QODER_VPC_ENDPOINT`、官方 CLI 变量 `QODERCN_VPC_ENDPOINT`，以及旧写法 `QODERCN_CLI_VPC_ENDPOINT`。原有的 `QODER_CN_BASE_URL`、`QODER_CN_OPENAPI_URL`、`QODER_CN_CENTER_URL` 覆盖仍然有效；若其中是租户控制台域名，会自动归一到对应的 gateway / OpenAPI 主机。

> `<instance>.vpc.qoder.com.cn` 是租户控制台，不是 API 主机。把 PAT 兑换或 COSY 聊天打到这里会返回 `CSRFInvalid`（命中了 Web/Session 中间件）。请始终使用上面的 `-gateway` / `-openapi` 主机。

请使用该 VPC 租户创建的 PAT（例如从 `https://<instance>.vpc.qoder.com.cn/account/integrations`）。把公网/国际版 PAT 拿到租户 OpenAPI 兑换会失败（`open_access_token not found`）。兑换请求体字段仍须为 `personal_token`；PAT 开通问题请联系租户管理员。

调试请求可设 `QODER_COSY_DEBUG=1`。日志会包含 URL、状态码和非敏感的 COSY 签名输入，不会包含凭证、Authorization、`Cosy-Key` 或机器标识。

## 接口端点

**国际版：**

- PAT 兑换：`https://openapi.qoder.sh/api/v1/jobToken/exchange`
- Job token 刷新：`https://openapi.qoder.sh/api/v1/jobToken/refresh`
- 用户信息：`https://openapi.qoder.sh/api/v1/userinfo`
- 用量：`https://openapi.qoder.sh/api/v2/quota/usage`
- 模型 / 对话网关：`https://api3.qoder.sh/algo/api/v2/...`

**中国版：**

- PAT 兑换：`https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- Job token 刷新：`https://openapi.qoder.com.cn/api/v1/jobToken/refresh`
- 用户信息：`https://openapi.qoder.com.cn/api/v1/userinfo`
- 用量：`https://openapi.qoder.com.cn/api/v2/quota/usage`
- 模型 / 对话网关：`https://gateway.qoder.com.cn/algo/api/v2/...`

设置 `QODER_VPC_INSTANCE=<instance>` 后，企业 VPC 会改用 `*.vpc.qoder.com.cn` 下推导出的 `-openapi` / `-gateway` 主机，而不再使用上面的公网中国版主机。

## 模型

### 国际版 `qoder`

暴露 Qoder 返回的底层模型 key，包括：

- **档位模型**：`auto`、`ultimate`、`performance`、`efficient`、`lite`
- **前沿模型**：
  - `qmodel`（Qwen3.7 Plus）
  - `qmodel_latest`（Qwen3.7 Max）
  - `dmodel`（DeepSeek V4 Pro）
  - `dfmodel`（DeepSeek V4 Flash）
  - `gm51model`（GLM）
  - `kmodel`（Kimi）
  - `mmodel`（MiniMax）

### 中国版 `qoder-cn`

中国版对外使用友好模型 ID，请求时再映射回 Qoder CN 内部 key：

| 友好 ID | Qoder CN key | 上下文 | 图片 | 推理 |
| --- | --- | ---: | :---: | :---: |
| `auto` | `auto` | 180K | 是 | 是 |
| `qwen3.7-max` | `qmodel_latest` | 1M | 是 | 是 |
| `qwen3.7-plus` | `qmodel` | 1M | 否 | 是 |
| `qwen3.6-flash` | `q36fmodel` | 1M | 否 | 是 |
| `deepseek-v4-pro` | `dmodel` | 1M | 否 | 是 |
| `deepseek-v4-flash` | `dfmodel` | 1M | 否 | 否 |
| `glm-5.2` | `gm51model` | 200K | 是 | 是 |
| `kimi-k2.6` | `kmodel` | 256K | 是 | 是 |
| `minimax-m2.7` | `mmodel` | 200K | 否 | 否 |

请求映射还接受兼容别名，例如 `qwen3.6-plus` → `qmodel`、`glm-5.1` → `gm51model`、`minimax-m3` → `mmodel`。

## 使用

登录后，在 pi 中选择任意 Qoder 模型：

```text
/model qwen3.7-plus
```

或直接启动：

```bash
pi --provider qoder-cn --model qwen3.7-plus
```

国际版示例：

```bash
pi --provider qoder --model auto
```

## 架构

```text
src/
├── index.ts            # 扩展注册
├── cosy.ts             # COSY 签名、机器 ID、区域/端点、CN 模型别名
├── login.ts            # OAuth 设备码流程 + PAT 登录
├── oauth.ts            # PAT / OAuth 回调编排
├── pat.ts              # PAT → job token 兑换 + 身份解析
├── models.ts           # 模型定义与动态配置缓存
├── stream.ts           # 流式响应主处理
├── transform.ts        # 消息转换（OpenAI schema 映射）
├── usage.ts            # 用量 / 配额
├── thinking-parser.ts  # <think> 标签兜底解析
└── qoder-encoding.ts   # WAF 绕过请求体编码
```

## License

MIT
