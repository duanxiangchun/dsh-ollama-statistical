<div align="center">

# dsh-ollama-statistical

**整个 DSH 的 Token 统计 + Ollama / OpenCode 限额 · DeepSeek Harness 插件**

侧栏独立统计页 + 侧栏底部横条：**Key 可选**——不配置 Key 也能看**整个 DSH 按供应商分类**的 token 用量
（今天 / 本周（周一开始）/ 自定义日期）；配置 Key 后额外显示 Ollama Cloud 的 5 小时会话限额、
周限额与官方请求量，以及 OpenCode Go 的滚动 5 小时 / 周 / 月额度与本机 opencode CLI 的 token/费用用量。

[English](README.en.md) · [MIT](LICENSE)

[![CI](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml/badge.svg)](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ollama-statistical.svg)](https://www.npmjs.com/package/dsh-ollama-statistical)

</div>

---

## ✨ 功能

| 区域 | 内容 |
| --- | --- |
| **Token 统计（全部供应商）** | **无需 Key，默认显示**：**整个 DSH 的 token 用量，按供应商（provider）分类**：供应商筛选 chips（含各供应商范围合计）、合并/单供应商模型榜；三视图 **今天** / **本周（周一开始 → 今天）** / **自定义日期区间**；**所有指标（总/输入/输出/缓存读写/推理、缓存命中率（有缓存读时才显示）、请求数、活跃天数、会话数、供应商分布、模型榜）都按所选时间范围统计**，多序列趋势图（Input / Output / Cache Read / 缓存命中率，今天按 24 小时、本周与自定义按天，右轴为命中率百分比） |
| **Key 可选** | Ollama / OpenCode 的 Key **都不是必填项**：不配置时页面只显示本地 token 统计，该 provider 的限额、官方请求量、本机 OpenCode CLI 用量与侧栏行自动隐藏，也不显示「未配置」占位（两个 Key 都没有时限额区整体不渲染）；会自动复用 DSH 凭证 / 环境变量 / CLI 登录，页面头部「配置 Key」可随时补配；已配置后仍可在页面上方的限额区更换 / 清除 Key；OpenCode 还支持「移除 Key」（插件级停用，见下） |
| **显示开关（Ollama / OpenCode）** | 页头「显示范围」有两个开关（Ollama / OpenCode，默认都开）：可只显示其中一个 provider 的限额、官方请求量、本机 OpenCode CLI 用量与侧栏行；关闭只是**隐藏显示**，**不会删除 Key**，重新打开立即恢复；「Token 统计（全部供应商）」区始终显示全部供应商，不受开关影响。与「移除 Key」不同：开关不改变 Key 的使用状态 |
| **Ollama 限额** | **配置 Ollama Key 后显示**：Ollama Cloud 的 **5 小时会话限额** 与 **周限额**：已用 / 剩余百分比、进度条、重置倒计时（来自官方 `GET /api/balance`）；周限额另有 **token 额度估算**（用本机 Ollama token 用量 ÷ 已用百分比反推总量/已用/剩余） |
| **Ollama 官方请求量** | **仅在配置 Ollama Key 后显示**：官方 `GET /api/usage` 的 **今天** / **本周（UTC 周一起）** / **本月（UTC 1 日起）**请求数（含 sparkline；今天/周/月由官方小时/日桶按 UTC 日界重过滤，与官方配额周期一致） |
| **OpenCode Go 限额** | **配置 OpenCode Key 后显示**：OpenCode Go 订阅的**滚动 5 小时 / 本周 / 本月**额度：已用 / 剩余百分比、进度条、重置倒计时（来自官方 `GET /zen/go/v1/usage`）。官方只提供**已用百分比 + 重置时间**，没有金额或绝对 token；**Zen 按量计费（PAYG）没有官方额度接口**，金额只在 OpenCode 控制台可见。三张卡另显示 **token 估算**（估算总量 / 已用 / 剩余，口径同 Ollama 周卡：本机对应窗口用量 ÷ 官方已用百分比；仅本机 CLI、其它客户端不计、历史不全时偏小，滚动 5h 用最近 5 个本机小时桶近似；**只是估算，不是官方额度**，官方百分比 / 重置时间仍以 API 为准） |
| **本机 OpenCode CLI 用量** | **仅在配置 OpenCode Key 且页头「显示开关」打开时显示**（且需要 **Node ≥22.5** / `node:sqlite`）：从本机 `opencode.db` 统计 opencode CLI 用量，**今天 / 本周 / 本月三张卡片**：总 token、费用、请求数、输入 / 缓存读 / 输出，以及 sparkline（今天按本机 24 小时，本周 / 本月按天）与日期范围；与「Token 统计（全部供应商）」的 DSH 会话日志口径不同，分开显示；同一窗口用量也用于 OpenCode 额度卡的 token 估算 |
| **移除 Key（OpenCode）** | OpenCode 已配置时（无论 Key 来自手动、DSH 凭证、环境变量还是 opencode CLI 登录），页面上方限额区标题右侧显示「移除 Key」按钮：点击后插件不再使用该 Key（包括 DSH 凭证、环境变量、opencode CLI 登录），OpenCode 限额、本机 CLI 用量与侧栏行随之隐藏。插件会**尽力删除 DSH 凭证记录**，但**不会删除环境变量或 opencode CLI 登录文件**（仍由外部工具管理）；之后可在页头「配置 Key」面板点「恢复外部 Key」，或直接粘贴新 Key（自动恢复）。页头显示开关只隐藏显示、不移除 Key |
| **侧栏底部横条** | 只显示显示开关已打开且确有数据的数据行：配置 Ollama Key 且限额可用时显示会话 5h（琥珀）+ 本周（青绿）；有 OpenCode Go 数据时追加一行 OpenCode 汇总（取三个窗口已用百分比最大者）；一行都没有时整条横条不显示。悬停看重置倒计时与更新时间，每 60 秒自动刷新 |
| **独立统计页** | 左侧栏「Token 统计」入口 → 完整统计页（页面标题「Token 统计」）；亮/暗主题、窄屏自适应、键盘可达 |
| **零依赖** | Host 只用 Node 内建能力；Client 只 `require('react')`，无构建步骤 |

## 🔍 数据来源与口径（重要）

本机 token 统计（第 3 条）**不需要任何 Key**；第 1、2、4 条只在对应 provider 配置了 Key 时才会请求与显示，第 5 条仅在配置 OpenCode Key 后显示（本机 DB 读取本身不依赖网络）。

1. **限额**：`https://ollama.com/api/balance`。带 5h/周限额的 legacy 套餐返回
   `included.session|weekly.remaining_percent + resets_at`，插件换算成已用百分比并原样透传重置时间；
   余额制套餐返回 `included.balance_usd / allowance_usd / period`，此时页面显示订阅额度。
2. **官方请求数**：`https://ollama.com/api/usage?range=24h|7d|30d`。
   官方对 **legacy 套餐只返回 `request_count`，不返回 token 数**（这是接口限制，不是插件缺功能）；
   接口若某天返回 token / usage_usd 字段，插件会如实展示。官方数据 **按 UTC 小时/日归集**，
   且统计该账号下**所有客户端**，不限于本机。接口只有滚动 24h/7d/30d 窗口，插件把其小时/日桶按
   **今天 / 本周（UTC 周一起）/ 本月（UTC 1 日起）→ 现在** 重过滤后展示——窗口与官方桶严格对齐，
   且官方周限额就在 UTC 周一 00:00 重置，「本周」即当前官方配额周期。
3. **Token 统计（默认视图，不需要 Key）**：来自**本机 DSH 会话日志**（`assistant/message` 事件的 `usage`），
   **统计全部供应商**（按事件里的 `provider` / `model` 分类，即你在 DSH 设置里配置的 ollama / sub / mgdaas / wb …），
   按**本机时区**的日界聚合（周一开始）。Ollama 限额与官方请求数仍只针对 `OLLAMA_API_KEY` 账号；
   官方页面上的请求数还包含你在其它客户端的用量，与本机 DSH 统计口径不同，两者并排展示可互相参照。**归档会话也计入**（归档只是工作区视图标记，不改日志）；
   **删除会话后数字也不缩水**：插件会把已消失会话的 per-day token 贡献保存在本地账本
   `$DSH_HOME/storages/ollama-statistical/ledger.json`，继续计入并标注「含 N 个已删除会话」；
   删除该账本文件即可清空（此后只统计现存会话）。个别日志读取失败的会话会提示「N 个会话日志读取失败」，
   在 DSH 里打开一次对应会话触发迁移后会自动补上（插件每 6 小时重试）。
4. **OpenCode Go 限额**：`https://opencode.ai/zen/go/v1/usage`（`Authorization: Bearer <key>`）。
   官方只返回**已用百分比 + 重置时间**（`rolling` / `weekly` / `monthly`），没有金额或绝对 token；
   **Zen 按量计费（PAYG）没有官方额度接口**，金额只在 OpenCode 控制台可见。
   **OpenCode 也没有官方的金额 / 请求量统计接口**——本机 opencode CLI 的金额与请求数来自下一条的本地数据库，
   不代表账号总额。Key 默认复用 opencode CLI 登录文件 `~/.local/share/opencode/auth.json`
   （`opencode-go.key`，其次 `opencode.key`），也可在页面手动粘贴（手动 Key 优先）。
   卡片还会显示 **token 估算**（估算总量 / 已用 / 剩余），口径与 Ollama 周卡估算一致：用**本机 opencode.db**
   在对应窗口（本周 / 本月 / 最近 5 个本机小时桶）的 token 用量 ÷ 官方已用百分比反推。注意：只统计本机
   opencode CLI，其它客户端不计入；历史统计不完整时估算偏小；滚动 5h 用最近 5 个本机小时桶近似；
   **估算不是官方额度**——官方百分比与重置时间仍以 API 返回为准。
5. **本机 OpenCode CLI 用量**：`~/.local/share/opencode/opencode.db`（SQLite，仅用 Node 内建 `node:sqlite`，
   **只读打开、绝不写库**；Node 20 没有该模块，此时该区域不显示）。统计最近 30 天内 `role==='assistant'`
   的消息，按**本机时区**日界聚合（周一开始、月从 1 日起），今天另外按本机小时聚合成 24 个小时桶；
   金额取记录里的 `cost`（USD），模型榜按 `provider/model` 取 top 10。路径可用 `OPENCODE_DB_PATH` 覆盖（默认
   `~/.local/share/opencode/opencode.db`，其次 `%LOCALAPPDATA%/opencode/opencode.db`）。
   页面以**今天 / 本周 / 本月三张卡片**展示（今天 sparkline 用 24 小时桶，本周 / 本月按天），
   其窗口用量也用于上一条的 OpenCode 额度估算；这部分与上面第 3 条的 DSH token 统计**互不混算**。

## 📦 安装

```bash
# 发布到 npm 后：
dsh plugin --profile desktop add dsh-ollama-statistical

# 本地目录开发（本仓库即插件包根目录）：
#   plugin_manager install_bundle，target 指向本目录（会被 link 进 profile）
dsh --profile desktop
```

安装后**刷新 DSH Web 页面**（或重启 DSH）加载前端 bundle；Host 侧即时生效。左侧栏出现「Token 统计」入口，
未配置 Key 时页面默认显示本地 token 统计（不显示限额区与侧栏横条）；配置 Ollama / OpenCode Key 后，
对应限额、官方请求量与本机 OpenCode CLI 用量才会出现。

## 🚀 使用

1. 点左侧栏的「Token 统计」图标进入统计页：**无需配置 Key**，默认显示本机 DSH 会话日志聚合的按供应商 token 统计；
2. 需要看 Ollama / OpenCode 限额时，点页面头部的「配置 Key」按钮（至少一个 provider 未配置时可见），
   在展开的面板里为未配置的 provider 补配 Key（可同时配置 Ollama / OpenCode）；保存走既有校验
   （Ollama `/api/balance`，OpenCode `/zen/go/v1/usage`）；
3. 配置 Ollama Key：按页面引导在 [ollama.com/settings/keys](https://ollama.com/settings/keys) 创建后粘贴检测，
   也可以先在 DSH 设置里给 Ollama provider 配好 `OLLAMA_API_KEY`（插件自动复用）；
4. OpenCode 默认复用 opencode CLI 登录的 Key；若本机 Key 已过期（页面提示 401 / Key 失效，如 `api_key_expired`），
   到 [OpenCode Console](https://opencode.ai/auth) 重新创建后，在页面的「配置 Key / 更换 Key」粘贴即可；
   有 Go 订阅时显示三个窗口的百分比与重置倒计时；没有订阅或获取失败时显示空态 / 错误提示
   （保留上次成功数据，点「刷新」重试）；
5. 已配置的 provider 仍可在页面上方限额区标题右侧更换 / 清除 Key；
6. 页头的「显示范围」开关（Ollama / OpenCode，默认都开）可只显示其中一个 provider 的对应区块：关闭只是隐藏该 provider 的
   限额、官方请求量、本机 OpenCode CLI 用量与侧栏行，**不会删除或停用 Key**，重新打开立即恢复；
   「Token 统计（全部供应商）」区始终显示全部供应商，不受开关影响；
7. OpenCode 已配置时，可在该区标题右侧点「移除 Key」（只影响 OpenCode，不影响 Ollama）：插件不再使用该 Key（包括 DSH 凭证、环境变量、
   opencode CLI 登录），OpenCode 限额、本机 CLI 用量与侧栏行随之隐藏；插件会尽力删除 DSH 凭证记录，
   但**不会删除环境变量或 opencode CLI 登录文件**（这些仍归外部工具管理）。之后可在页头「配置 Key」面板
   点「恢复外部 Key」，或直接粘贴新 Key（自动恢复）；
8. `今天` / `本周` / `自定义` 三个 tab 查看 token 统计；
9. 打开页面永远秒开：`snapshot` 采用 stale-while-revalidate——只要手上有快照（含重启后的磁盘缓存）
   就立即返回，数据过期时后台自动重采、页面约 10 秒后自动换新，绝不前台卡等网络或日志扫描；
   顶部「刷新」强制立即重取（15s 节流；官方接口限流 10 次/分钟）。

**Key 优先级**（配置 Key 后）

不配置 Key 时不会触发对应官方请求；以下顺序只用于已存在多个来源时选择。
对 OpenCode 而言，在页面「移除 Key」后上述所有来源都会停用，直到点「恢复外部 Key」或粘贴新 Key。

- **OpenCode**（高 → 低）：页面手动 Key（「更换 Key」/「配置 Key」，**最高**，可覆盖已过期的 CLI Key）→ DSH 凭证
  `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` → 环境变量 → opencode CLI 登录
  （`~/.local/share/opencode/auth.json` 的 `opencode-go.key`，其次 `opencode.key`）；「清除手动 Key」后回退到后续来源。
- **Ollama** 保持原有顺序：DSH 凭证库 → 环境变量 → 旧版 Ollama CLI 登录 → 页面手动 Key。

> **首次使用**：插件会在后台分轮扫描本机最近 30 天的 DSH 会话日志，页面显示「正在补齐历史会话 x/y」，
> 本机 500+ 会话约 2~4 分钟补齐（单轮后台预算 180s，未补完会自动接下一轮；期间 `snapshot` 仍在毫秒级返回已有数据）；
> 之后冷启动靠本地缓存秒开（日常打开亦然：SWR 旧快照立即返回 + 后台自动补新），只有新增会话需要补扫。

> **无 Key 也能用**：token 统计完全来自本机会话日志，不需要 Ollama / OpenCode Key；限额区与侧栏横条只在配置对应 Key 后出现。

## 🔒 隐私

- Key 只在本机：优先复用 DSH 凭证库与 opencode CLI 登录文件，手动 Key（Ollama / OpenCode）明文存储于
  `$DSH_HOME/storages/ollama-statistical/state.json`（POSIX 模式 600；Windows 上依赖 `$DSH_HOME`
  用户目录 ACL，插件写入后尽力用 `icacls` 收紧到当前用户），可随时在页面清除；
- 页面「移除 Key」只让插件停用该 Key 并尽力删除 DSH 凭证记录，**不会修改或删除环境变量、opencode.db 或 opencode CLI 登录文件**（`~/.local/share/opencode/auth.json` 仍由外部工具管理）；
- 网络请求只发往 `https://ollama.com`（`/api/balance`、`/api/usage`）与 `https://opencode.ai`
  （`/zen/go/v1/usage`）；
- **不配置 Key 时不会发起任何网络请求**：token 统计完全来自本机会话日志，不需要 Key；
- Token 与费用统计完全在本机聚合，不外发；`opencode.db` 以只读模式打开，绝不写库；
- **完整 Key（Ollama / OpenCode）永远不会返回给浏览器端**，页面只显示 `sk-****1fdd` 形态的掩码。

## 🏗️ 架构

```
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│ browser (lib/client.js)       │  RPC   │ host (lib/index.js)                      │
│ · 侧栏统计页（main）          │◄──────►│ · webServer 路由 /ollama-statistical     │
│ · 侧栏底部横条                │ 信封协议 │ · /api/balance + /api/usage（60s 缓存）  │
│ · OpenCode 限额 / 本机用量    │        │ · /zen/go/v1/usage + opencode.db（只读） │
│ · 面板图标、i18n、主题        │        │ · key 解析 / state.json / 会话缓存       │
└───────────────────────────────┘        └──────────────────────────────────────────┘
```

- RPC：`POST /ollama-statistical/<endpoint>`，信封 `{type:'client-request',rpcId,method,payload}`；
- 端点：`snapshot` / `refresh` / `auth-state` / `set-key` / `clear-key`；
- Key 可选：两个 Key 都缺失时 `snapshot` 仍返回成功（只含本地 token 统计与空 limits / official），不再返回 `no-key` / `no-data`；
- 契约细节见仓库内 .dev/protocol.md（开发文档，不随 npm 包发布）。

## 🧩 兼容性

| DSH | 状态 |
| --- | --- |
| 0.2.1-rc.3 | ✅ 实测（Node 22.22，Windows，v0.8 OpenCode 限额 / 本机用量；v0.9 Key 可选 / 默认 token 统计；v0.9.1 移除 Key；v0.9.2 显示开关；v0.9.3 本机用量卡片；v0.9.4 额度估算） |
| 0.2.1-rc.2 | ✅ 实测（Node 22.22，Windows；v0.7 及以前） |

Node `>=20`；**本机 OpenCode CLI 用量需要 Node `>=22.5`**（`node:sqlite`；Node 20 上该区域自动不显示，其余功能正常）。
DSH `>=0.2.1-rc.1`。依赖的 Host 服务：`webServer`、`timer`、`credentials`、`sessionQuery`。

## 🛠️ 开发

```bash
node --check lib/index.js
node --check lib/client.js
npm test          # node --test：解析 / 聚合 / 信封 / key 优先级 / 扫描预算 / OpenCode
node --test test/opencode.test.mjs   # 仅 OpenCode：usage 解析 / key 优先级 / 本机 DB（Node 20 自动跳过 sqlite 用例）
node .dev/verify-rpc.mjs   # 对运行中的 DSH Web 端口做信封+形状+安全集成探针（旧 host 无 opencode 字段时跳过）
```

> 本插件以 `link:` 本地目录安装，DSH 的 HMR 不会重载 Host 模块：改 `lib/index.js` 后需在插件管理里
> 先停用再启用本 bundle；改 `lib/client.js` 后刷新页面即可。

## 📄 许可证

[MIT](LICENSE)
