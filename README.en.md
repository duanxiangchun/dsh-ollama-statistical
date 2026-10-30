<div align="center">

# dsh-ollama-statistical

**Whole-DSH token statistics + Ollama / OpenCode limits · DeepSeek Harness plugin**

A dedicated sidebar statistics page plus sidebar bars: **keys are optional** — without any key you still get
**whole-DSH token usage broken down by provider** by **today**, **this week (starting Monday)** and a **custom date range**;
with keys configured it also shows Ollama Cloud 5-hour session and weekly limits plus official request counts,
and OpenCode Go rolling 5-hour / weekly / monthly quotas plus local opencode CLI token/cost usage.

[中文](README.md) · [MIT](LICENSE)

[![CI](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml/badge.svg)](https://github.com/duanxiangchun/dsh-ollama-statistical/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ollama-statistical.svg)](https://www.npmjs.com/package/dsh-ollama-statistical)

</div>

---

## ✨ Features

| Area | What you get |
| --- | --- |
| **Token statistics (all providers)** | **No key required — shown by default**: **whole-DSH token usage grouped by provider**: provider filter chips (with per-provider range totals), merged or per-provider model lists, and three views: **today**, **this week (Monday → today)**, **custom range**. **Every metric (totals, input/output/cached tokens (cache-write/reasoning cards appear only when the provider reports them), requests, active days, sessions, provider shares and model lists) is scoped to the selected range**, plus a multi-series SVG trend chart (Input / Output / Cache Read / cache hit rate with a right-hand percent axis; 24 hourly points for today, daily points for week/custom) |
| **Optional keys** | Ollama / OpenCode keys are **both optional**: without a key the page shows only local token statistics and hides that provider's limits, official request counts, local OpenCode CLI usage and sidebar row — no “not configured” placeholder either (with neither key the whole limits section is not rendered). Keys are reused automatically from the DSH credential store / environment / CLI login; the header's “Configure keys” button adds them later, and configured providers can still change / clear keys in the limits section at the top of the page; OpenCode also supports “Remove key” (plugin-level disable, see below) |
| **Display toggles (Ollama / OpenCode)** | “Visibility” toggles in the page header (Ollama / OpenCode, both on by default): show only one provider's limits, official request counts, local OpenCode CLI usage and sidebar row; turning one off only **hides** that provider — it **does not delete the key**, and turning it back on restores the sections immediately; the token statistics (all providers) section always shows every provider and is not affected. Unlike “Remove key”, a toggle never changes whether a key is used |
| **Ollama limits** | **Shown after configuring an Ollama key**: Ollama Cloud **5-hour session limit** and **weekly limit**: used/remaining percent, progress bar and reset countdown (official `GET /api/balance`) ; the weekly quota is also **estimated in tokens** (local Ollama token usage ÷ official used percent) |
| **Ollama official request counts** | **Only shown after configuring an Ollama key**: request counts for **today** / **this week (UTC Monday onward)** / **this month (UTC 1st onward)** from the official `GET /api/usage`, with sparklines (day/week/month re-filtered from official hour/day buckets at UTC day boundaries, matching the official quota cycles) |
| **OpenCode Go limits** | **Shown after configuring an OpenCode key**: OpenCode Go subscription **rolling 5-hour / weekly / monthly** quotas: used/remaining percent, progress bar and reset countdown (official `GET /zen/go/v1/usage`). The official API only returns **used percent + reset time** — no money or absolute token figures; **Zen pay-as-you-go (PAYG) has no official quota API**, so cost is only visible in the OpenCode console. The three cards also show a **token estimate** (estimated total / used / remaining, same basis as the Ollama weekly card: local window usage ÷ official used percent; local CLI only, other clients are not counted, low when history is incomplete, and the rolling 5h window is approximated by the last 5 local hourly buckets; **an estimate only, not the official quota** — official percentages and reset times still come from the API) |
| **Local OpenCode CLI usage** | **Only shown after configuring an OpenCode key and with the header “Visibility” toggle on** (and requires **Node ≥22.5** / `node:sqlite`): token and cost statistics from the local `opencode.db` in **three cards for today / this week / this month**: total tokens, cost, requests, input / cache read / output, plus a sparkline (24 local hours for today, daily points for week / month) and the date range; kept separate from the **Token statistics (all providers)** scope based on DSH session logs; its window usage also feeds the OpenCode quota token estimate |
| **Remove key (OpenCode)** | When OpenCode is configured (whatever the source: manual, DSH credential, environment variable or opencode CLI login), a “Remove key” button appears at the right of the limits-section title: clicking it makes the plugin stop using that key (including the DSH credential, environment variables and the opencode CLI login), so the OpenCode limits, local CLI usage and sidebar row are hidden. The plugin makes a **best-effort deletion of the DSH credential record** but **does not delete environment variables or the opencode CLI login file** (still managed by external tools); afterwards use “Restore external key” in the header “Configure keys” panel, or paste a new key (restores automatically). Header display toggles only hide sections; they do not remove the key |
| **Sidebar bars** | Only rows for enabled providers with data appear: with an Ollama key and available limits, session (5h, amber) + weekly (teal-green); when OpenCode Go data exists, an extra **OpenCode summary** row (largest used percent across the three windows); when there is no row the whole bar is not rendered. Reset countdown and last update in the tooltip, refreshed every 60 s |
| **Statistics page** | “Token stats” entry in the left sidebar opens the full page (page title “Token stats”); light/dark themes, narrow-screen layout, keyboard accessible |
| **Zero dependencies** | Host uses Node built-ins only; Client only `require('react')`, no build step |

## 🔍 Data sources and scope (important)

Local token statistics (item 3) **need no key**; items 1, 2 and 4 are only requested and shown when the corresponding provider has a key configured, and item 5 is only shown with an OpenCode key (reading the local DB does not need the network).

1. **Limits** come from `https://ollama.com/api/balance`. Legacy plans with session/weekly limits return
   `included.session|weekly.remaining_percent + resets_at`; credit-based plans return
   `included.balance_usd / allowance_usd / period` and the page shows the subscription allowance instead.
2. **Official request counts** come from `https://ollama.com/api/usage?range=24h|7d|30d`.
   For **legacy plans the official API only returns `request_count`, no token figures** (an API limitation,
   not a missing feature). Any token/usage_usd fields that appear later are passed through.
   Official data is bucketed by **UTC** hour/day and covers **all clients** of the account, not only this machine.
   The API only offers rolling 24h/7d/30d windows; the plugin re-filters their hour/day buckets to
   **today / this week (UTC Monday onward) / this month (UTC 1st onward) → now** — exactly aligned with
   the official buckets, and the official weekly quota resets at UTC Monday 00:00, so "this week"
   is the current official quota cycle.
3. **Token statistics (default view, no key needed)** are computed from **local DSH session logs** (`usage` on `assistant/message` events)
   **across all providers** (grouped by the event's `provider`/`model`, i.e. the ollama / sub / mgdaas / wb … ids configured in DSH),
   bucketed by **local-timezone** days (week starts Monday). Ollama limits and official request counts still target only the
   `OLLAMA_API_KEY` account; the official request count also includes other clients, so the two are shown side by side for reference. **Archived sessions are included** (archiving is only a
   workspace view flag), and **deleting a session does not shrink the numbers**: the plugin keeps the deleted session's
   per-day token contribution in a local ledger (`$DSH_HOME/storages/ollama-statistical/ledger.json`) and marks it as
   "includes N deleted sessions". Delete that ledger file to clear it (then only existing sessions are counted). A few
   unreadable session logs are reported as "N sessions could not be read"; opening each session once in DSH triggers
   migration and the numbers fill in automatically (the plugin retries every 6 hours).
4. **OpenCode Go limits** come from `https://opencode.ai/zen/go/v1/usage` (`Authorization: Bearer <key>`).
   The official API only returns **used percent + reset time** for `rolling` / `weekly` / `monthly`; there is no
   money or absolute token figure and **Zen pay-as-you-go (PAYG) has no official quota API** — cost is only visible in the
   OpenCode console. **OpenCode also has no official cost / request-count API**: the local opencode CLI cost and request
   counts below come from the local database and do not represent account totals. Keys are reused from the opencode CLI
   login file `~/.local/share/opencode/auth.json` (`opencode-go.key`, then `opencode.key`), or pasted in the page
   (a manual key wins). The cards also show a **token estimate** (estimated total / used / remaining) on the same
   basis as the Ollama weekly card: local opencode.db usage for the matching window (this week / this month / the last
   5 local hourly buckets) divided by the official used percent. Note: only the local opencode CLI is counted, other
   clients are not; the estimate is low when history is incomplete; the rolling 5h window is approximated by the last
   5 local hourly buckets; **it is an estimate, not the official quota** — official percentages and reset times still
   come from the API.
5. **Local OpenCode CLI usage** comes from `~/.local/share/opencode/opencode.db` (SQLite, opened **read-only** with Node's
   built-in `node:sqlite`; Node 20 lacks that module, so this section is hidden there). It sums `role==='assistant'`
   messages from the last 30 days, bucketed by **local-timezone** days (week starts Monday, month on the 1st), with an
   extra 24-hour local-time bucket set for today; it uses each record's `cost` (USD), with a top-10 model list grouped
   by `provider/model`. Override the path with `OPENCODE_DB_PATH` (default `~/.local/share/opencode/opencode.db`, then
   `%LOCALAPPDATA%/opencode/opencode.db`). The section renders **three cards for today / this week / this month**
   (today's sparkline uses the 24-hour buckets, week / month use daily buckets). Its window usage also feeds the OpenCode
   quota estimate above. These numbers are **never mixed** with the DSH token statistics in item 3.

## 📦 Install

```bash
# from npm, once published:
dsh plugin --profile desktop add dsh-ollama-statistical

# local development (this repository is the package root):
#   plugin_manager install_bundle with target = this directory (linked into the profile)
dsh --profile desktop
```

After installing, **refresh the DSH Web page** (or restart DSH) to load the client bundle; the Host side is live
immediately. A “Token stats” entry appears in the left sidebar. Without any key the page shows local token statistics
by default (no limits section, no sidebar bars); after configuring an Ollama / OpenCode key, the corresponding limits,
official request counts and local OpenCode CLI usage appear.

## 🚀 Usage

1. Click the “Token stats” icon in the left sidebar: **no key is required** — the page shows provider-grouped token
   statistics from local DSH session logs by default;
2. To see Ollama / OpenCode limits, click the “Configure keys” button in the page header (visible while at least one
   provider is unconfigured) and add the missing key(s) in the panel that opens (Ollama and OpenCode can both be
   configured); saving goes through the existing checks (`/api/balance` for Ollama, `/zen/go/v1/usage` for OpenCode);
3. Ollama key: create one at [ollama.com/settings/keys](https://ollama.com/settings/keys) and paste it, or configure
   `OLLAMA_API_KEY` for the Ollama provider in DSH settings (the plugin reuses it automatically);
4. OpenCode reuses the opencode CLI login key by default; if that key has expired (the page shows a 401 / invalid-key
   message such as `api_key_expired`), recreate it in the [OpenCode Console](https://opencode.ai/auth) and paste it via
   “Configure keys / Change key”; with a Go subscription the three quota windows show percentages and reset countdowns;
   without a subscription or on fetch failure an empty / error state explains why (the last successful data is kept;
   use “Refresh” to retry);
5. Configured providers can still change / clear their key from the header of the limits section at the top of the page;
6. Use the “Visibility” toggles in the page header (Ollama / OpenCode, both on by default) to show only one provider's sections:
   turning one off only hides that provider's limits, official request counts, local OpenCode CLI usage and sidebar row —
   it **does not delete or disable the key**, and turning it back on restores them immediately; the token statistics
   (all providers) section always shows every provider and is not affected;
7. When OpenCode is configured, use the “Remove key” button at the right of that section title (it affects OpenCode only, not Ollama): the plugin stops using
   that key (including the DSH credential, environment variables and the opencode CLI login), so the OpenCode limits,
   local CLI usage and sidebar row are hidden. The plugin makes a best-effort deletion of the DSH credential record but
   **does not delete environment variables or the opencode CLI login file** (still managed by external tools). Afterwards
   use “Restore external key” in the header “Configure keys” panel, or paste a new key (restores automatically);
8. Use the `Today` / `This week` / `Custom` tabs for token statistics;
9. Opening the page is always instant: `snapshot` serves stale-while-revalidate — any existing snapshot
   (including the on-disk one after a restart) is returned immediately while a background refetch refreshes
   it (the page picks up new data in ~10 s). `Refresh` forces a refetch (15 s throttle; official API allows
   10 req/min).

**Key precedence** (once a key is configured)

Without any key no official request is made; the order below only picks between multiple configured sources.
For OpenCode, using “Remove key” on the page disables all of the sources below until “Restore external key” is used or a new key is pasted.

- **OpenCode** (high → low): a manual key in the page (“Configure keys” / “Change key”, **highest** — overrides an expired CLI key) → DSH
  credentials `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` → environment → opencode CLI login (`opencode-go.key`, then
  `opencode.key` in `~/.local/share/opencode/auth.json`). “Clear manual key” falls back to the remaining sources.
- **Ollama** keeps its existing order: DSH credential store → environment → legacy Ollama CLI login → a manual key in the page.

> **First run**: the plugin scans the last 30 days of local DSH session logs in background rounds; the page shows
> "filling in historical sessions x/y" and 500+ sessions converge in about 2–4 minutes (one background round has a
> 180 s budget and continues in the next round; `snapshot` keeps returning in milliseconds meanwhile). Later cold
> starts are instant from the local cache (everyday opens too: SWR returns the existing snapshot
> immediately while the background refetches); only new sessions need scanning.

> **No key required**: token statistics come entirely from local session logs and need no Ollama / OpenCode key; the
> limits sections and sidebar bars appear only after the corresponding key is configured.

## 🔒 Privacy

- Keys stay local: the DSH credential store and opencode CLI login files are reused; a pasted key (Ollama or OpenCode)
  is stored in `$DSH_HOME/storages/ollama-statistical/state.json` (POSIX mode 600; on Windows it relies on the `$DSH_HOME`
  user-directory ACL and the plugin best-effort tightens it to the current user with `icacls`) and can be cleared from the page;
- “Remove key” only makes the plugin stop using the key and best-effort deletes the DSH credential record; it **does not modify or delete environment variables, `opencode.db` or the opencode CLI login file** (`~/.local/share/opencode/auth.json`, still managed by external tools);
- Network requests go only to `https://ollama.com` (`/api/balance`, `/api/usage`) and `https://opencode.ai`
  (`/zen/go/v1/usage`);
- **Without any key no network request is made**: token statistics come entirely from local session logs and need no key;
- Token and cost aggregation is local and never leaves the machine; `opencode.db` is opened read-only and never written;
- **The full key (Ollama or OpenCode) is never sent to the browser**; only a masked form such as `sk-****1fdd` is shown.

## 🏗️ Architecture

```
┌───────────────────────────────┐        ┌──────────────────────────────────────────┐
│ browser (lib/client.js)       │  RPC   │ host (lib/index.js)                      │
│ · statistics page (main)      │◄──────►│ · webServer route /ollama-statistical    │
│ · sidebar footer bars         │envelope│ · /api/balance + /api/usage (60 s cache) │
│ · OpenCode quota / local CLI  │        │ · /zen/go/v1/usage + opencode.db (RO)    │
│ · panel icon, i18n, themes    │        │ · key resolve / state.json / cache       │
└───────────────────────────────┘        └──────────────────────────────────────────┘
```

- RPC: `POST /ollama-statistical/<endpoint>` with `{type:'client-request',rpcId,method,payload}`;
- Endpoints: `snapshot` / `refresh` / `auth-state` / `set-key` / `clear-key`;
- Keys are optional: with neither key, `snapshot` still succeeds (local token statistics with empty limits / official) instead of returning `no-key` / `no-data`;
- Contract: .dev/protocol.md in the repository (development document, not published).

## 🧩 Compatibility

| DSH | Status |
| --- | --- |
| 0.2.1-rc.3 | ✅ tested (Node 22.22, Windows, v0.8 OpenCode quotas / local usage; v0.9 optional keys / default token statistics; v0.9.1 remove key; v0.9.2 display toggles; v0.9.3 local-usage cards; v0.9.4 quota estimates) |
| 0.2.1-rc.2 | ✅ tested (Node 22.22, Windows; v0.7 and earlier) |

Node `>=20`; **local OpenCode CLI usage requires Node `>=22.5`** (`node:sqlite`; on Node 20 that section is hidden and
everything else works). DSH `>=0.2.1-rc.1`. Host services used: `webServer`, `timer`, `credentials`, `sessionQuery`.

## 🛠️ Development

```bash
node --check lib/index.js
node --check lib/client.js
npm test                    # node --test: parsing / aggregation / envelope / key precedence / scan budget / OpenCode
node --test test/opencode.test.mjs   # OpenCode only: usage parsing / key precedence / local DB (sqlite cases skip on Node 20)
node .dev/verify-rpc.mjs    # live envelope + shape + secret-leak probe (skips when the running host has no opencode field)
```

> Installed from a local directory as a `link:`, the plugin's Host module is not reloaded by HMR: after editing
> `lib/index.js`, disable and re-enable the bundle in the plugin manager; after editing `lib/client.js`, just
> refresh the page.

## 📄 License

[MIT](LICENSE)
