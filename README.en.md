<div align="center">

# dsh-ollama-statistical

**Ollama limits + whole-DSH token statistics · DeepSeek Harness plugin**

A dedicated sidebar statistics page plus persistent sidebar bars:
Ollama Cloud 5-hour session and weekly limits plus official request counts, and
**whole-DSH token usage broken down by provider** by **today**, **this week (starting Monday)** and a **custom date range**.

[中文](README.md) · [MIT](LICENSE)

</div>

---

## ✨ Features

| Area | What you get |
| --- | --- |
| **Ollama limits** | Ollama Cloud **5-hour session limit** and **weekly limit**: used/remaining percent, progress bar and reset countdown (official `GET /api/balance`) |
| **Token statistics (all providers)** | **Whole-DSH token usage grouped by provider**: provider filter chips (with per-provider range totals), merged or per-provider model lists, and three views: **today**, **this week (Monday → today)**, **custom range**. **Every metric (totals, input/output/cached tokens (cache-write/reasoning cards appear only when the provider reports them), requests, active days, sessions, provider shares and model lists) is scoped to the selected range**, plus a multi-series SVG trend chart (Input / Output / Cache Read / cache hit rate with a right-hand percent axis; 24 hourly points for today, daily points for week/custom) |
| **Ollama official request counts** | Request counts for the last 24 hours / 7 days / 30 days from the official `GET /api/usage`, with sparklines |
| **Sidebar bars** | Always-visible session (5h, amber) and weekly (teal-green) bars with reset countdown in the tooltip, refreshed every 60 s |
| **Statistics page** | Left sidebar panel icon opens the full page; light/dark themes, narrow-screen layout, keyboard accessible |
| **No configuration** | Reuses the DSH-configured `OLLAMA_API_KEY` (credential store → environment → legacy Ollama CLI login); a key can also be pasted or replaced in the page (the “Change key” button next to the limits header) |
| **Zero dependencies** | Host uses Node built-ins only; Client only `require('react')`, no build step |

## 🔍 Data sources and scope (important)

1. **Limits** come from `https://ollama.com/api/balance`. Legacy plans with session/weekly limits return
   `included.session|weekly.remaining_percent + resets_at`; credit-based plans return
   `included.balance_usd / allowance_usd / period` and the page shows the subscription allowance instead.
2. **Official request counts** come from `https://ollama.com/api/usage?range=24h|7d|30d`.
   For **legacy plans the official API only returns `request_count`, no token figures** (an API limitation,
   not a missing feature). Any token/usage_usd fields that appear later are passed through.
   Official data is bucketed by **UTC** hour/day and covers **all clients** of the account, not only this machine.
3. **Token statistics** are computed from **local DSH session logs** (`usage` on `assistant/message` events)
   **across all providers** (grouped by the event's `provider`/`model`, i.e. the ollama / sub / mgdaas / wb … ids configured in DSH),
   bucketed by **local-timezone** days (week starts Monday). Ollama limits and official request counts still target only the
   `OLLAMA_API_KEY` account; the official request count also includes other clients, so the two are shown side by side for reference. **Archived sessions are included** (archiving is only a
   workspace view flag), and **deleting a session does not shrink the numbers**: the plugin keeps the deleted session's
   per-day token contribution in a local ledger (`$DSH_HOME/storages/ollama-statistical/ledger.json`) and marks it as
   "includes N deleted sessions". Delete that ledger file to clear it (then only existing sessions are counted). A few
   unreadable session logs are reported as "N sessions could not be read"; opening each session once in DSH triggers
   migration and the numbers fill in automatically (the plugin retries every 6 hours).

## 📦 Install

```bash
# from npm, once published:
dsh plugin --profile desktop add dsh-ollama-statistical

# local development (this repository is the package root):
#   plugin_manager install_bundle with target = this directory (linked into the profile)
dsh --profile desktop
```

After installing, **refresh the DSH Web page** (or restart DSH) to load the client bundle; the Host side is live
immediately. An Ollama statistics icon appears in the left sidebar and usage bars at the sidebar foot.

> **Coexistence**: if `dsh-ollama-usage` is still enabled, the sidebar foot shows two sets of bars (its features are
> covered by this plugin); disable the old plugin in Settings → Plugins.

## 🚀 Usage

1. Click the Ollama icon in the left sidebar;
2. If no key is found, create one at [ollama.com/settings/keys](https://ollama.com/settings/keys) and paste it,
   or configure `OLLAMA_API_KEY` for the Ollama provider in DSH settings (the plugin reuses it automatically);
3. Use the `Today` / `This week` / `Custom` tabs for token statistics;
4. `Refresh` forces a refetch (official API allows 10 req/min; `snapshot` has a 60 s cache and `refresh` bypasses it).

> **First run**: the plugin scans the last 30 days of local DSH session logs in background rounds; the page shows
> "filling in historical sessions x/y" and 500+ sessions converge in about 2–4 minutes (one background round has a
> 180 s budget and continues in the next round; `snapshot` keeps returning in milliseconds meanwhile). Later cold
> starts are instant from the local cache; only new sessions need scanning.

## 🔒 Privacy

- The key stays local: the DSH credential store is preferred; a pasted key is stored in
  `$DSH_HOME/storages/ollama-statistical/state.json` (POSIX mode 600; on Windows it relies on the `$DSH_HOME`
  user-directory ACL and the plugin best-effort tightens it to the current user with `icacls`) and can be cleared from the page;
- Network requests go only to `https://ollama.com` (`/api/balance`, `/api/usage`);
- Token aggregation is local and never leaves the machine;
- **The full key is never sent to the browser**; only a masked form such as `sk-****1fdd` is shown.

## 🏗️ Architecture

```
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│ browser (lib/client.js)       │  RPC   │ host (lib/index.js)                      │
│ · statistics page (main)      │◄──────►│ · webServer route /ollama-statistical     │
│ · sidebar footer bars         │envelope│ · /api/balance + /api/usage (60 s cache)  │
│ · sidebar panel icon          │        │ · token scan via ctx.sessionQuery + cache │
│ · i18n (zh/en), theme tokens  │        │ · state.json persisted (600/ACL)         │
└───────────────────────────────┘        └──────────────────────────────────────────┘
```

- RPC: `POST /ollama-statistical/<endpoint>` with `{type:'client-request',rpcId,method,payload}`;
- Endpoints: `snapshot` / `refresh` / `auth-state` / `set-key` / `clear-key`;
- Contract: .dev/protocol.md in the repository (development document, not published).

## 🧩 Compatibility

| DSH | Status |
| --- | --- |
| 0.2.1-rc.2 | ✅ tested (Node 22.22, Windows) |

Node `>=20`; DSH `>=0.2.1-rc.1`. Host services used: `webServer`, `timer`, `credentials`, `sessionQuery`.

## 🛠️ Development

```bash
node --check lib/index.js
node --check lib/client.js
npm test                    # node --test: parsing / aggregation / envelope / key precedence / scan budget
node .dev/verify-rpc.mjs    # live envelope + shape + secret-leak probe against the running DSH Web port
```

> Installed from a local directory as a `link:`, the plugin's Host module is not reloaded by HMR: after editing
> `lib/index.js`, disable and re-enable the bundle in the plugin manager; after editing `lib/client.js`, just
> refresh the page.

## 📄 License

[MIT](LICENSE)
