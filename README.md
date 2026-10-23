<div align="center">

# dsh-ollama-statistical

**Ollama 限额 + 整个 DSH 的 Token 统计 · DeepSeek Harness 插件**

侧栏独立统计页 + 侧栏底部常驻双横条：Ollama Cloud 的 5 小时会话限额、周限额与官方请求量，
以及**整个 DSH 按供应商分类**的 token 用量（今天 / 本周（周一开始）/ 自定义日期）。

[English](README.en.md) · [MIT](LICENSE)

[![CI](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml/badge.svg)](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ollama-statistical.svg)](https://www.npmjs.com/package/dsh-ollama-statistical)

</div>

---

## ✨ 功能

| 区域 | 内容 |
| --- | --- |
| **Ollama 限额** | Ollama Cloud 的 **5 小时会话限额** 与 **周限额**：已用 / 剩余百分比、进度条、重置倒计时（来自官方 `GET /api/balance`）；周限额另有 **token 额度估算**（用本机 Ollama token 用量 ÷ 已用百分比反推总量/已用/剩余） |
| **Token 统计（全部供应商）** | **整个 DSH 的 token 用量，按供应商（provider）分类**：供应商筛选 chips（含各供应商范围合计）、合并/单供应商模型榜；三视图 **今天** / **本周（周一开始 → 今天）** / **自定义日期区间**；**所有指标（总/输入/输出/缓存读写/推理、缓存命中率（有缓存读时才显示）、请求数、活跃天数、会话数、供应商分布、模型榜）都按所选时间范围统计**，多序列趋势图（Input / Output / Cache Read / 缓存命中率，今天按 24 小时、本周与自定义按天，右轴为命中率百分比） |
| **Ollama 官方请求量** | 官方 `GET /api/usage` 的近 24 小时 / 近 7 天 / 近 30 天请求数（含 sparkline） |
| **侧栏底部双横条** | 会话 5h（琥珀）+ 本周（青绿）常驻显示，悬停看重置倒计时与更新时间，每 60 秒自动刷新 |
| **独立统计页** | 左侧栏面板图标 → 完整统计页；亮/暗主题、窄屏自适应、键盘可达 |
| **无需配置** | 自动复用 DSH 已配置的 `OLLAMA_API_KEY`（凭证库 → 环境变量 → 旧版 Ollama CLI 登录），也可在页面里手动粘贴 / 随时更换 Key（A 区标题右侧「更换 Key」按钮） |
| **零依赖** | Host 只用 Node 内建能力；Client 只 `require('react')`，无构建步骤 |

## 🔍 数据来源与口径（重要）

1. **限额**：`https://ollama.com/api/balance`。带 5h/周限额的 legacy 套餐返回
   `included.session|weekly.remaining_percent + resets_at`，插件换算成已用百分比并原样透传重置时间；
   余额制套餐返回 `included.balance_usd / allowance_usd / period`，此时页面显示订阅额度。
2. **官方请求数**：`https://ollama.com/api/usage?range=24h|7d|30d`。
   官方对 **legacy 套餐只返回 `request_count`，不返回 token 数**（这是接口限制，不是插件缺功能）；
   接口若某天返回 token / usage_usd 字段，插件会如实展示。官方数据 **按 UTC 小时/日归集**，
   且统计该账号下**所有客户端**，不限于本机。
3. **Token 统计**：来自**本机 DSH 会话日志**（`assistant/message` 事件的 `usage`），
   **统计全部供应商**（按事件里的 `provider` / `model` 分类，即你在 DSH 设置里配置的 ollama / sub / mgdaas / wb …），
   按**本机时区**的日界聚合（周一开始）。Ollama 限额与官方请求数仍只针对 `OLLAMA_API_KEY` 账号；
   官方页面上的请求数还包含你在其它客户端的用量，与本机 DSH 统计口径不同，两者并排展示可互相参照。**归档会话也计入**（归档只是工作区视图标记，不改日志）；
   **删除会话后数字也不缩水**：插件会把已消失会话的 per-day token 贡献保存在本地账本
   `$DSH_HOME/storages/ollama-statistical/ledger.json`，继续计入并标注「含 N 个已删除会话」；
   删除该账本文件即可清空（此后只统计现存会话）。个别日志读取失败的会话会提示「N 个会话日志读取失败」，
   在 DSH 里打开一次对应会话触发迁移后会自动补上（插件每 6 小时重试）。

## 📦 安装

```bash
# 发布到 npm 后：
dsh plugin --profile desktop add dsh-ollama-statistical

# 本地目录开发（本仓库即插件包根目录）：
#   plugin_manager install_bundle，target 指向本目录（会被 link 进 profile）
dsh --profile desktop
```

安装后**刷新 DSH Web 页面**（或重启 DSH）加载前端 bundle；Host 侧即时生效。左侧栏出现 Ollama 统计图标，
侧栏底部出现用量双横条。

## 🚀 使用

1. 点左侧栏的 Ollama 图标进入统计页；
2. 若未检测到 Key：按页面引导在 [ollama.com/settings/keys](https://ollama.com/settings/keys) 创建 Key，
   粘贴后点「检测」（也可以先在 DSH 设置里给 Ollama provider 配好 `OLLAMA_API_KEY`，插件自动复用）；
3. `今天` / `本周` / `自定义` 三个 tab 查看 token 统计；
4. 顶部「刷新」立即重取（官方接口限流 10 次/分钟；`snapshot` 有 60 秒快照缓存，`refresh` 强制重取）。

> **首次使用**：插件会在后台分轮扫描本机最近 30 天的 DSH 会话日志，页面显示「正在补齐历史会话 x/y」，
> 本机 500+ 会话约 2~4 分钟补齐（单轮后台预算 180s，未补完会自动接下一轮；期间 `snapshot` 仍在毫秒级返回已有数据）；
> 之后冷启动靠本地缓存秒开，只有新增会话需要补扫。

## 🔒 隐私

- Key 只在本机：优先复用 DSH 凭证库，手动 Key 明文存储于
  `$DSH_HOME/storages/ollama-statistical/state.json`（POSIX 模式 600；Windows 上依赖 `$DSH_HOME`
  用户目录 ACL，插件写入后尽力用 `icacls` 收紧到当前用户），可随时在页面清除；
- 网络请求只发往 `https://ollama.com`（`/api/balance`、`/api/usage`）；
- Token 统计完全在本机计算，不外发；
- **完整 Key 永远不会返回给浏览器端**，页面只显示 `sk-****1fdd` 形态的掩码。

## 🏗️ 架构

```
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│ browser (lib/client.js)       │  RPC   │ host (lib/index.js)                      │
│ · 侧栏统计页（main）          │◄──────►│ · webServer 路由 /ollama-statistical      │
│ · 侧栏底部双横条              │ 信封协议 │ · /api/balance + /api/usage（60s 缓存）   │
│ · 侧栏面板图标                │        │ · ctx.sessionQuery 聚合 token（会话级缓存）│
│ · i18n（zh/en）、主题 token   │        │ · state.json 持久化（600/ACL）           │
└───────────────────────────────┘        └──────────────────────────────────────────┘
```

- RPC：`POST /ollama-statistical/<endpoint>`，信封 `{type:'client-request',rpcId,method,payload}`；
- 端点：`snapshot` / `refresh` / `auth-state` / `set-key` / `clear-key`；
- 契约细节见仓库内 .dev/protocol.md（开发文档，不随 npm 包发布）。

## 🧩 兼容性

| DSH | 状态 |
| --- | --- |
| 0.2.1-rc.2 | ✅ 实测（Node 22.22，Windows） |

Node `>=20`；DSH `>=0.2.1-rc.1`。依赖的 Host 服务：`webServer`、`timer`、`credentials`、`sessionQuery`。

## 🛠️ 开发

```bash
node --check lib/index.js
node --check lib/client.js
npm test          # node --test：解析 / 聚合 / 信封 / key 优先级 / 扫描预算
node .dev/verify-rpc.mjs   # 对运行中的 DSH Web 端口做信封+形状+安全集成探针
```

> 本插件以 `link:` 本地目录安装，DSH 的 HMR 不会重载 Host 模块：改 `lib/index.js` 后需在插件管理里
> 先停用再启用本 bundle；改 `lib/client.js` 后刷新页面即可。

## 📄 许可证

[MIT](LICENSE)
