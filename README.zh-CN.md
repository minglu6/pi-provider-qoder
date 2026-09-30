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
4. 执行 /login。中国版登录依次输入 VPC 实例/网址和 PAT，成功后自动保存；
   后续启动和续期不需要 PAT 或 VPC 环境变量。

按场景只选一套：

A) 国际版：
   执行 /login qoder，输入 PAT（也可选择浏览器登录）。

B) 中国公有云：
   执行 /login qoder-cn，VPC 提示处留空（或输入 public），再输入 CN PAT。

C) 中国企业 VPC（最容易漏配）：
   执行 /login qoder-cn，先输入实例名或租户网址，再输入该 VPC 租户签发的 PAT。

硬性规则：
- VPC 地址在登录时填写；插件自动推导 -gateway / -openapi，不要手工猜测公网主机。
- 已有路由环境变量优先于保存的配置；要在登录界面修改实例，先移除这些覆盖变量。
- 先完成 /login；PAT 环境变量仅为可选的登录输入，不是自动续期的前提。
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

#### 4. Android / Termux

从 0.3.1 开始，安装源码包不再自动构建，也不需要安装 `esbuild`。Pi 直接加载 `src/index.ts`；仅开发或发布时才需要执行 `npm run build`。

```bash
# Pi：从 GitHub 安装；已有相同来源时使用下方更新命令
pi install git:github.com/minglu6/pi-provider-qoder
# 已有 GitHub 安装：
pi update git:github.com/minglu6/pi-provider-qoder
```

OMP 使用 `omp plugin install github:minglu6/pi-provider-qoder`。只保留一份启用的插件；从 npm 切换来源前先移除旧副本。完全退出并重启宿主，再执行一次 `/login qoder-cn`。

原生 Android（`process.platform === "android"`）不会加载原生 keyring 包。PAT 以**明文**保存到 `~/.pi/agent/qoder-pats/`（设置 `PI_CODING_AGENT_DIR` 时为该目录下的 `qoder-pats/`），目录权限 `0700`、文件权限 `0600`。按 OpenAPI 地址和账号分别保存，采用原子写入。必须放在 Termux 私有目录，不要放在共享 `/sdcard`。文件权限不等于加密，不能防御 root 或同一用户下的恶意进程。

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

没有显式路由环境变量时，中国版登录先提示 VPC 实例名或网址，再提示 PAT。首次留空使用中国公有云；已有配置时回车保留，输入 `public` 切回中国公有云。只有登录成功才保存新配置，取消或失败不会切换原来的实例。

### Personal Access Token（PAT）

Qoder PAT（`pt-...`）不能直接调 API。本扩展会把它兑换成短期 job token（流程对齐官方 `qodercli` / `qoderclicn`），并自动解析账号身份。

**国际版：**

- 执行 `/login qoder`，选择 **Use API Key (PAT)**，粘贴 token
- 或启动 pi 前设置 `QODER_PERSONAL_ACCESS_TOKEN`（或 `QODER_PAT`），再执行 `/login qoder`

**中国版：**

- 执行 `/login qoder-cn`，选择 VPC / 中国公有云后粘贴 CN PAT
- 或启动 pi 前设置 `QODERCN_PERSONAL_ACCESS_TOKEN`（或 `QODERCN_PAT`），再执行 `/login qoder-cn`
- 仅当值以 `pt-` 开头时，`QODER_API_KEY` 才会被当作 CN PAT 别名

登录成功后，PAT 自动保存在 **macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service**；**Android/Termux 使用上述私有明文文件**。各平台均按 OpenAPI 地址和账号隔离；`auth.json` 仍只保存短期令牌和 JRT，不保存明文 PAT。

- 日常使用优先通过 `POST /api/v1/jobToken/refresh` 续期。JRT 明确过期或失效后，自动读取已保存的 PAT 重新兑换，不需要配置 PAT 环境变量。
- 网络异常、限流和服务端 5xx 保留错误，不会自动改用 PAT，也不会一律要求重新登录。PAT 本身被服务端拒绝后，才需重新 `/login` 更新密钥。
- 升级前的 JRT-only 登录没有保存 PAT：升级并重启 Pi 后，需要再登录一次。旧版曾内嵌 PAT 的凭据会在成功续期时迁移到当前平台的凭据存储。
- 桌面/服务器平台需要安装可选依赖，并确保系统凭据库可用且已解锁；Linux 需要持久化 Secret Service（如 GNOME Keyring / KWallet）。原生库缺失或凭据库锁定时不会静默降级为明文文件；Android 明确使用文件存储。保存失败会报错，不会声称登录已完成。
- `/logout` 删除宿主登录状态，但 Pi 的插件接口没有退出登录回调，因此不会删除已保存的 PAT；插件不会仅凭该 PAT 自动重新登录。彻底移除时，在系统凭据管理器中删除服务名为 `pi-qoder-provider:<OpenAPI 地址>`、账号为对应 userID 的条目；Android 上删除 `qoder-pats/` 会清除该 agent 目录下所有账号保存的 PAT。需要吊销访问权限时，在 Qoder 控制台撤销 PAT。

**PAT 和企业 VPC 配置均可通过一次交互登录保存，无需任何 Qoder 环境变量。** PAT 使用当前平台对应的存储，非敏感实例配置另存本地文件。

### 区域环境变量

```bash
export QODER_REGION=cn       # 或 QODER_BACKEND=cn / QODER_MODE=cn
```

仅配置 CN PAT、未配置国际版 PAT 时，`qoder` 入口也会自动切到 CN 模式；中国版仍建议显式使用 `/login qoder-cn` 与 `--provider qoder-cn`。

### 企业 VPC

执行 `/login qoder-cn`，在 VPC 提示处输入实例名，例如：

```text
sungrow-of-enterprise
```

也可粘贴 `https://sungrow-of-enterprise.vpc.qoder.com.cn`，或对应的 `-gateway` / `-openapi` 地址。随后输入该租户的 PAT。

登录成功后，归一化后的实例名写入 `~/.pi/agent/qoder-cn-config.json`（设置 `PI_CODING_AGENT_DIR` 时使用该目录），例如：

```json
{ "vpcInstance": "sungrow-of-enterprise" }
```

文件不保存 PAT。重启后会自动读取，登录、模型列表、聊天、用量查询和令牌续期共用这一配置。再次登录可修改实例；输入 `public` 会保存为中国公有云。手工编辑配置文件后需重启 Pi。退出登录不会清除这份非敏感配置。

扩展会推导 Qoder VPC 所需的业务域名：

- `https://<instance>-gateway.vpc.qoder.com.cn`
- `https://<instance>-openapi.vpc.qoder.com.cn`

已有环境变量继续作为**显式覆盖**，不是必需配置：`QODER_VPC_INSTANCE`、`QODER_VPC_ENDPOINT`、`QODERCN_VPC_ENDPOINT`、`QODERCN_CLI_VPC_ENDPOINT`，以及 `QODER_CN_BASE_URL`、`QODER_CN_OPENAPI_URL`、`QODER_CN_CENTER_URL`。存在覆盖时，登录会提示使用环境配置并跳过 VPC 输入；成功登录后也会保存可识别的 VPC 实例，之后可以移除环境变量。任意自定义 API 地址仍只作为环境覆盖，不写入实例配置文件。

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
├── dsml.ts             # 原生 DSML 文本 → 可执行工具调用
├── transform.ts        # 消息转换（OpenAI schema 映射）
├── usage.ts            # 用量 / 配额
├── thinking-parser.ts  # <think> 标签兜底解析
└── qoder-encoding.ts   # WAF 绕过请求体编码
```

对于使用 `TranscriptContext` 的 Pi 宿主（包括 Pi 0.99.1），插件调用宿主的
`getCurrentSystemPrompt` 和 `getCurrentTools` 重放全部 system 消息，处理
sections 更新/删除及工具增删。没有 system 消息时，继续使用旧版
`Context.systemPrompt` / `Context.tools`。折叠后的提示同时放入 Qoder 顶层
`system` 字段和 messages 首条 system 消息，确保 GLM-5.3/OpenAI 兼容路由读取。

流式回归测试通过仅开发依赖 `pi-ai-transcript` 别名加载真实 Pi 0.99.1 compat API，
类型检查仍覆盖旧版 SDK 契约。无需修改 Pi 核心，也不依赖解析 GLM 伪工具调用文本。

DeepSeek 系列模型可能在 `delta.content` 中输出原生 DSML 标记，而不是结构化
`tool_calls`。流式解析器将支持的 DSML 块转换为工具调用，并设置
`stopReason: "toolUse"`，保留普通正文及参数类型。支持逐字符分片、多个 invoke，
以及从截断的 invoke 中恢复已完整接收的参数。无法识别或超出缓冲上限的未完成
标记回退为文本；不会改写已有会话历史。

## License

MIT
