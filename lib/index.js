/**
 * dsh-ollama-statistical —— Host 半（Cordis 插件，ESM）。
 *
 * 单一 Loader 行（见 cordis.patch.yml）挂载本模块，职责：
 *  1. 在 webServer 上注册 `/ollama-statistical` 前缀路由，用 Connection RPC 信封
 *     （{type:'client-request', rpcId, method, payload} → {type:'server-response', rpcId, result}）
 *     给浏览器端提供 snapshot / refresh / auth-state / set-key / clear-key 五个端点；
 *  2. 读取 Ollama API Key：DSH 凭证库 OLLAMA_API_KEY → 环境变量 → ~/.ollama/auth.json
 *     → 插件自己持久化的手动 key（优先级依次降低，见 .dev/protocol.md 第 1 节）；
 *  3. 请求 https://ollama.com/api/balance（5 小时会话限额 + 周限额 / 余额制额度）与
 *     https://ollama.com/api/usage?range=24h|7d|30d（官方请求数分桶）。官方接口对
 *     legacy 套餐只返回 request_count，没有 token；若将来出现 token/usd 字段则原样透传；
 *  4. 通过 ctx.sessionQuery 读取本机 DSH 会话日志（zstd JSONL 由 Harness 解压），
 *     统计**全部供应商**（不再按 provider 过滤）的 assistant/message 事件 usage，
 *     聚合出最近 30 个本地日的 token / 请求数 / 活跃会话数，并按 provider / model 分类
 *     （tokens.days 全量合计 + tokens.providers[] 分组 + tokens.models[] 全局模型榜）；
 *  5. 把最后一次成功快照与手动 key 持久化到 `$DSH_HOME/storages/ollama-statistical/`，
 *     并给会话日志建「会话级缓存」、给已删除会话记「墓碑账本」，避免每次刷新重读日志、
 *     也避免删除会话后历史 token 统计缩水。
 *
 * 重要坑位（已实测，Open Source 项目请保留说明）：
 *  - balance 的 remaining_percent 是「剩余」百分比，面板要的 usedPercent = 100 - remaining；
 *  - 真实 /api/usage 的 until 是纳秒精度 ISO 字符串（如 2026-10-23T08:08:49.099929399Z），
 *    不要用 new Date() 归一化后再输出，原样透传即可；
 *  - 真实 assistant/message.usage 里 totalTokens 已经等于 input+output+cacheRead
 *    （实测 12372+268+11776=24416），所以有 totalTokens 时直接用，不要再加 cacheRead；
 *  - 会话日志单文件可达几十 MB，readSession 很贵：非 live 会话读一次后必须缓存，
 *    live 会话（ctx.agents.get(sessionId) 有值）每次重读，并受时间/数量预算约束；
 *  - 任何返回浏览器的 JSON 都不允许出现完整 key，只返回 masked（末 4 位）。
 *
 * 本文件顶层只 import node: 内建模块，不 import 任何 @deepseek-ai/* 或浏览器 API，
 * 因此 `node --test test/` 可以在没有 DSH 进程时独立 import 它做纯函数单测。
 */

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

export const name = 'ollama-statistical'

/** webServer / timer 走硬依赖 inject：路由注册与定时器都必须在服务就绪后执行。 */
export const inject = ['timer', 'webServer']

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PACKAGE_NAME = 'dsh-ollama-statistical'
const PACKAGE_VERSION = '0.5.2'
const USER_AGENT = PACKAGE_NAME + '/' + PACKAGE_VERSION

const RPC_CHANNEL = '/ollama-statistical'
const BALANCE_URL = 'https://ollama.com/api/balance'
const USAGE_URL = 'https://ollama.com/api/usage'
const KEY_REF = 'OLLAMA_API_KEY'

/** 官方 API 单次请求超时（契约要求 20s）。 */
const FETCH_TIMEOUT_MS = 20000
/** 整包快照缓存 60s：官方限流 10 请求/分钟，且浏览器 60s 轮询一次。 */
const CACHE_TTL_MS = 60 * 1000
/** 429 缺少 Retry-After 时的默认冷却时长（契约的“60s 限流保护”）。 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000
/** refresh 的最小间隔（契约：15s 内重复刷新直接回缓存，避免 10 请求/分钟限流被打爆）。 */
const REFRESH_MIN_INTERVAL_MS = 15000
/** 启动后预热快照的延迟：不拖慢 DSH 启动，又让首次打开面板时命中缓存。 */
const WARMUP_DELAY_MS = 8 * 1000
/** 后台保活快照间隔：让 lastSnapshot 不会因为长时间没开面板而过期。 */
const AUTO_SNAPSHOT_MS = 5 * 60 * 1000

/** RPC 请求体上限（信封很小，64KB 足够）。 */
const MAX_BODY_BYTES = 64 * 1024

/** token 统计窗口：最近 30 个本地日。 */
const WINDOW_DAYS = 30
/**
 * 候选会话额外回看天数：createdAt >= windowStart - 30 天（契约第 3 节）。
 * 之所以回看这么长：归档/长期运行的会话可能几十天前创建、但今天仍在写入，
 * 按 createdAt 粗筛时回看不足会把它们漏掉（实测有 5 个这样的会话）。
 * 扫描成本由会话级缓存 + 后台 warm 吸收，只在首次冷重建时体现。
 */
const CANDIDATE_LOOKBACK_DAYS = 30
/**
 * 前台扫描预算（契约第 3 节「响应性」）：
 * snapshot / refresh 最多阻塞 8s；到点立刻返回当前聚合结果（scan.partial = true），
 * 剩余会话交给后台补齐，用户不再等 25s+。
 */
const FOREGROUND_SCAN_MS = 8000
const MAX_SCAN_SESSIONS = 400
/** 后台补齐：每片最多 1.5s，片间用 ctx.timeout 让出事件循环。 */
const WARM_SLICE_MS = 1500
/** 片间让出事件循环的延迟（ms）。 */
const WARM_YIELD_MS = 16
/** 后台补齐总预算：超过 180s 就停，等下一次前台快照再续。 */
const MAX_WARM_MS = 180000
/**
 * 会话读取失败的记忆 TTL：6 小时内不再重复 readSession（直接计入 scan.failed），
 * 过期后重试一次——归档/格式迁移后旧格式会话可能就能读了。
 */
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000

/** token 统计不再按 provider 过滤：provider/model 缺失时统一归到 (未知)。 */
const UNKNOWN_LABEL = '(未知)'
/** 模型 / 供应商分布最多 10 条，其余合并。 */
const MAX_MODELS = 10
const REST_MODEL_LABEL = '(其余)'
const REST_PROVIDER_LABEL = '(其余)'

const STORAGE_DIRNAME = 'ollama-statistical'
const STATE_FILE = 'state.json'
const TOKEN_CACHE_FILE = 'token-cache.json'
/** 墓碑账本：known（曾统计过的会话）+ retired（已从 listSessions 消失、但保留 fold 的会话）。 */
const LEDGER_FILE = 'ledger.json'
/** ledger v3：fold 升级为 v4 形状（额外 perHour / perHourProvider），旧版本直接丢弃。 */
const LEDGER_VERSION = 3
/**
 * token-cache.json 结构版本：v4 起 fold 额外含 perHour / perHourProvider（本地小时桶），
 * 支持「今天」按 24 小时分布聚合；更旧版本在 loadPersisted 直接丢弃并冷重建（warm 自动补齐）。
 */
const TOKEN_CACHE_VERSION = 4

const NO_KEY_MESSAGE =
  '未检测到 Ollama API Key：请在 DSH 凭证中配置 OLLAMA_API_KEY，或设置环境变量 OLLAMA_API_KEY、使用 ollama CLI 登录、在面板里手动填写。'

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 读取有限数字；数字字符串也接受（官方接口历史上出现过字符串数值）。 */
function readFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** token 计数：缺失/负数/非数字一律归 0，保证聚合结果单调非负。 */
function tokenCount(value) {
  const parsed = readFiniteNumber(value)
  if (parsed === null || parsed < 0) return 0
  return Math.floor(parsed)
}

/** token 计数，但「缺失」保留 null（用于区分 totalTokens 未提供 vs 0）。 */
function tokenCountOrNull(value) {
  const parsed = readFiniteNumber(value)
  if (parsed === null || parsed < 0) return null
  return Math.floor(parsed)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 百分比保留 2 位小数：官方 remaining_percent 本身是 2 位（72.39），
 *  契约示例 usedPercent=25.64 也对应 2 位，因此不做 1 位截断以免丢精度。 */
function roundPercent(value) {
  return Math.round(clamp(value, 0, 100) * 100) / 100
}

function describeError(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

/** Retry-After 既可能是秒数，也可能是 HTTP 日期；统一换算成毫秒。 */
export function parseRetryAfterMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now())
  return null
}

/** Host 进程本地时区（Windows 上通常是 Asia/Shanghai），用于界面注明数据日界。 */
function hostTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.trim() !== '') return zone
  } catch {
    /* 某些精简运行时没有 Intl 时区数据 */
  }
  return 'UTC'
}

/* ------------------------------------------------------------------ *
 * 时间 / 本地日历纯函数
 * ------------------------------------------------------------------ */

/** 本地日键 YYYY-MM-DD（Host 本地时区，不用 UTC，也不接受浏览器时区）。 */
export function localDayKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) throw new TypeError('localDayKey: invalid date')
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/**
 * 本地小时键 YYYY-MM-DDTHH（Host 本地时区）：
 * 「今天」的 24 小时图用，例如 2026-10-23T14 表示本地 14:00–14:59。
 */
export function localHourKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) throw new TypeError('localHourKey: invalid date')
  return localDayKey(date) + 'T' + String(date.getHours()).padStart(2, '0')
}

/** 按「本地日历日」平移，避免用毫秒加减在夏令时时区错位。 */
export function shiftLocalDays(input, delta) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) throw new TypeError('shiftLocalDays: invalid date')
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(delta))
}

/** YYYY-MM-DD → 本地 00:00 的 Date。 */
export function dayKeyToLocalDate(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey))
  if (!match) throw new TypeError('dayKeyToLocalDate: invalid day key ' + String(dayKey))
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** 本周周一（ISO 周一，周日属于上一周）的本地日键。 */
export function weekStartDate(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) throw new TypeError('weekStartDate: invalid date')
  const weekday = date.getDay() // 0 = 周日, 1 = 周一 ... 6 = 周六
  const offset = weekday === 0 ? -6 : 1 - weekday
  return localDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset))
}

/** 最近 windowDays 个本地日（升序，末位是今天）。 */
export function tokenWindowDates(todayInput = Date.now(), windowDays = WINDOW_DAYS) {
  const today = typeof todayInput === 'string' ? dayKeyToLocalDate(todayInput) : new Date(todayInput)
  if (Number.isNaN(today.getTime())) throw new TypeError('tokenWindowDates: invalid date')
  const dates = []
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    dates.push(localDayKey(shiftLocalDays(today, -offset)))
  }
  return dates
}

/* ------------------------------------------------------------------ *
 * Key 脱敏 / 四级来源解析
 * ------------------------------------------------------------------ */

/**
 * 脱敏：只露出末 4 位（契约承诺「仅末 4 位」）。
 *  - 以 sk- 开头的 key 保留厂商前缀：'sk-****1fdd'；
 *  - 其他 key（如 Ollama 的随机串）不露任何前缀：'****cWjS'；
 *  - 长度 <= 4 一律 '****'。
 * 任何返回浏览器的 key 字段都必须经过它。
 */
export function maskKey(key) {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  if (trimmed === '') return null
  if (trimmed.length <= 4) return '****'
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : ''
  return prefix + '****' + trimmed.slice(-4)
}

function normalizeKey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 按契约优先级解析 key：credentials → env → local-cli → manual。
 *
 * sources 是注入点（单测用 stub 覆盖，不读真实凭证）：
 *  - resolveCredential: async () => string | { value } | null   （DSH 凭证库）
 *  - env: string | () => string|null                            （process.env.OLLAMA_API_KEY）
 *  - readLocalToken: () => string|null                          （~/.ollama/auth.json 的 token）
 *  - readManualKey: () => string|null                           （插件持久化的手动 key）
 *
 * 返回 { key, source, sources }：key 为 null 时 source = 'none'；sources 记录四个来源
 * 是否存在（auth-state 需要展示“还有哪些来源可用”）。
 * 每个来源单独 try/catch：某个来源抛错不会阻断后面的来源。
 */
export async function resolveApiKey(sources = {}) {
  const entries = [
    ['credentials', 'credentials', sources.resolveCredential],
    ['env', 'env', sources.env],
    ['local-cli', 'localCli', sources.readLocalToken],
    ['manual', 'manual', sources.readManualKey],
  ]
  const presence = { credentials: false, env: false, localCli: false, manual: false }
  let chosen = null
  for (const [source, presenceKey, producer] of entries) {
    let raw = null
    try {
      raw = typeof producer === 'function' ? await producer() : producer
    } catch {
      raw = null
    }
    // 凭证服务返回 { value }，其余来源返回字符串；两种都接受。
    const candidate = normalizeKey(isPlainObject(raw) ? raw.value : raw)
    if (candidate === null) continue
    presence[presenceKey] = true
    if (chosen === null) chosen = { key: candidate, source }
  }
  if (chosen === null) return { key: null, source: 'none', sources: presence }
  return { key: chosen.key, source: chosen.source, sources: presence }
}

/* ------------------------------------------------------------------ *
 * /api/balance 解析
 * ------------------------------------------------------------------ */

function parseLimitWindow(raw) {
  const remaining = readFiniteNumber(raw.remaining_percent)
  return {
    usedPercent: remaining === null ? null : roundPercent(100 - remaining),
    remainingPercent: remaining === null ? null : roundPercent(remaining),
    resetsAt: typeof raw.resets_at === 'string' && raw.resets_at.trim() !== '' ? raw.resets_at : null,
  }
}

/** 空 limits（所有数据源失败时的降级值，字段形状仍满足契约）。 */
export function emptyLimits() {
  return { kind: 'none', session: null, weekly: null, credits: null, purchasedUsd: null }
}

/**
 * 解析 GET /api/balance。
 *  - legacy 套餐：included.session / included.weekly = { remaining_percent, resets_at }
 *  - 余额制套餐：included.balance_usd / allowance_usd / period{from,until}
 *  - included 什么都没有 → kind='none'
 * 解析失败（非 JSON / 非对象）抛错，由调用方转成 errors[] 里的 internal。
 */
export function parseBalance(body) {
  let json = body
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error('balance 响应不是合法 JSON')
    }
  }
  if (!isPlainObject(json)) throw new Error('balance 响应格式异常（不是 JSON 对象）')

  const included = isPlainObject(json.included) ? json.included : {}
  const session = isPlainObject(included.session) ? included.session : null
  const weekly = isPlainObject(included.weekly) ? included.weekly : null
  const hasCreditsFields =
    readFiniteNumber(included.balance_usd) !== null ||
    readFiniteNumber(included.allowance_usd) !== null ||
    isPlainObject(included.period)
  const kind = session || weekly ? 'legacy' : hasCreditsFields ? 'credits' : 'none'
  const purchased = isPlainObject(json.purchased) ? json.purchased : null

  let credits = null
  if (kind === 'credits') {
    const period = isPlainObject(included.period) ? included.period : null
    credits = {
      remainingUsd: readFiniteNumber(included.balance_usd),
      allowanceUsd: readFiniteNumber(included.allowance_usd),
      periodFrom: period && typeof period.from === 'string' ? period.from : null,
      periodUntil: period && typeof period.until === 'string' ? period.until : null,
    }
  }

  return {
    kind,
    session: session ? parseLimitWindow(session) : null,
    weekly: weekly ? parseLimitWindow(weekly) : null,
    credits,
    purchasedUsd: purchased ? readFiniteNumber(purchased.balance_usd) : null,
  }
}

/* ------------------------------------------------------------------ *
 * /api/usage 官方用量解析
 * ------------------------------------------------------------------ */

/**
 * 官方 bucket/totals 里的 token 字段：legacy 套餐没有，将来新套餐若出现
 * （input_tokens / cached_input_tokens / output_tokens / usage_usd 等）就如实透传。
 * 一个都没有时返回 null（契约要求 tokens: null）。
 */
function extractOfficialTokens(raw) {
  if (!isPlainObject(raw)) return null
  const input = readFiniteNumber(raw.input_tokens !== undefined ? raw.input_tokens : raw.inputTokens)
  const cachedInput = readFiniteNumber(
    raw.cached_input_tokens !== undefined
      ? raw.cached_input_tokens
      : raw.cachedInputTokens !== undefined
        ? raw.cachedInputTokens
        : raw.cache_read_tokens,
  )
  const output = readFiniteNumber(raw.output_tokens !== undefined ? raw.output_tokens : raw.outputTokens)
  const usd = readFiniteNumber(
    raw.usage_usd !== undefined ? raw.usage_usd : raw.usd !== undefined ? raw.usd : raw.cost_usd,
  )
  if (input === null && cachedInput === null && output === null && usd === null) return null
  return { input, cachedInput, output, usd }
}

function readRequestCount(raw) {
  const value = readFiniteNumber(raw && raw.request_count !== undefined ? raw.request_count : raw && raw.requestCount)
  return value === null || value < 0 ? 0 : Math.floor(value)
}

/**
 * 把 /api/usage 的响应归一化成契约里的 official range 形状：
 * { range, granularity, from, until, requestCount, tokens, buckets:[{from,until,requestCount,partial,tokens}] }
 * from/until 原样透传（实测 until 是纳秒精度 ISO 字符串）。
 */
export function aggregateOfficialUsage(input, range) {
  let json = input
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input)
    } catch {
      throw new Error('usage 响应不是合法 JSON')
    }
  }
  if (!isPlainObject(json)) throw new Error('usage 响应格式异常（不是 JSON 对象）')

  const buckets = (Array.isArray(json.buckets) ? json.buckets : [])
    .filter(isPlainObject)
    .map((bucket) => ({
      from: typeof bucket.from === 'string' ? bucket.from : null,
      until: typeof bucket.until === 'string' ? bucket.until : null,
      requestCount: readRequestCount(bucket),
      partial: bucket.partial === true,
      tokens: extractOfficialTokens(bucket),
    }))

  const totals = isPlainObject(json.totals) ? json.totals : {}
  const totalFromApi = readRequestCount(totals)
  const requestCount =
    readFiniteNumber(totals.request_count !== undefined ? totals.request_count : totals.requestCount) === null
      ? buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0)
      : totalFromApi

  return {
    range: typeof json.range === 'string' ? json.range : typeof range === 'string' ? range : null,
    granularity:
      typeof json.granularity === 'string' ? json.granularity : range === '24h' ? 'hour' : 'day',
    from: typeof json.from === 'string' ? json.from : null,
    until: typeof json.until === 'string' ? json.until : null,
    requestCount,
    tokens: extractOfficialTokens(totals),
    buckets,
  }
}

/* ------------------------------------------------------------------ *
 * 本机 DSH 会话日志 token 聚合（纯函数）
 * ------------------------------------------------------------------ */

function zeroTokenBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0 }
}

function addTokenBucket(target, source) {
  if (!isPlainObject(source)) return target
  target.input += tokenCount(source.input)
  target.output += tokenCount(source.output)
  target.cacheRead += tokenCount(source.cacheRead)
  target.cacheWrite += tokenCount(source.cacheWrite)
  target.reasoning += tokenCount(source.reasoning)
  target.total += tokenCount(source.total)
  target.requests += tokenCount(source.requests)
  return target
}

/**
 * 把一个 assistant/message 事件的 usage 转成 token 桶。
 * total 语义（契约）：有 totalTokens 就用它；否则 input+output。
 * cacheRead/cacheWrite/reasoning 只做展示，不再加到 total 上（totalTokens 已含 cacheRead）。
 */
function bucketFromUsage(usage) {
  const input = tokenCount(usage.inputTokens)
  const output = tokenCount(usage.outputTokens)
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  const reasoning = tokenCount(usage.reasoningTokens)
  const explicitTotal = tokenCountOrNull(usage.totalTokens)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: explicitTotal === null ? input + output : explicitTotal,
    requests: 1,
  }
}

/** provider / model 名取事件 source 原样；缺失或空白归到 "(未知)"。 */
function readLabel(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : UNKNOWN_LABEL
}

/**
 * 单会话事件流 → 折叠结构（v3）：
 *  { requests,
 *    perDay:              { day: bucket },
 *    perDayProvider:      { day: { provider: bucket } },
 *    perDayModel:         { day: { model: bucket } },
 *    perDayProviderModel: { day: { provider: { model: bucket } } } }
 *
 * 不再按 provider 过滤：所有 `assistant/message` 且带 usage 的事件都统计，
 * provider / model 取 `data.message.source` 原样（缺失 → "(未知)"）。
 * 折叠维度（全部是「稀疏对象，只写有事件的键」）：
 *   perDay{day}、perDayProvider{day}{provider}、perDayModel{day}{model}、
 *   perDayProviderModel{day}{provider}{model}、perHour{YYYY-MM-DDTHH}、
 *   perHourProvider{YYYY-MM-DDTHH}{provider}。
 * 「日」维度用于 30 天窗口；「小时」维度（v4 新增）只用于今天的 24 小时图。
 * 为什么要按日/小时折叠：会话可能横跨窗口之外，聚合时只取需要的日期/小时，
 * 才能保证 days / hours / providers / models 全部同口径。
 * 结果形状稳定，可直接进会话级缓存（token-cache v4）跨刷新复用。
 */
export function aggregateSessionEvents(events) {
  const perDay = {}
  const perDayProvider = {}
  const perDayModel = {}
  const perDayProviderModel = {}
  const perHour = {}
  const perHourProvider = {}
  let requests = 0
  if (!Array.isArray(events)) {
    return { requests, perDay, perDayProvider, perDayModel, perDayProviderModel, perHour, perHourProvider }
  }

  for (const event of events) {
    if (!isPlainObject(event) || event.type !== 'assistant/message') continue
    const data = isPlainObject(event.data) ? event.data : null
    if (!data) continue
    const usage = isPlainObject(data.usage) ? data.usage : null
    if (!usage) continue
    const message = isPlainObject(data.message) ? data.message : null
    const source = message && isPlainObject(message.source) ? message.source : null

    let dayKey
    let hourKey
    try {
      const time = typeof event.time === 'number' ? event.time : Date.now()
      dayKey = localDayKey(time)
      hourKey = localHourKey(time)
    } catch {
      continue
    }
    const bucket = bucketFromUsage(usage)
    const provider = readLabel(source && source.provider)
    const model = readLabel(source && source.model)

    addTokenBucket(perDay[dayKey] || (perDay[dayKey] = zeroTokenBucket()), bucket)
    const dayProviders = perDayProvider[dayKey] || (perDayProvider[dayKey] = {})
    addTokenBucket(dayProviders[provider] || (dayProviders[provider] = zeroTokenBucket()), bucket)
    const dayModels = perDayModel[dayKey] || (perDayModel[dayKey] = {})
    addTokenBucket(dayModels[model] || (dayModels[model] = zeroTokenBucket()), bucket)
    const dayProviderModels = perDayProviderModel[dayKey] || (perDayProviderModel[dayKey] = {})
    const providerModels = dayProviderModels[provider] || (dayProviderModels[provider] = {})
    addTokenBucket(providerModels[model] || (providerModels[model] = zeroTokenBucket()), bucket)

    // 小时桶（稀疏：无事件的钟点不写键）
    addTokenBucket(perHour[hourKey] || (perHour[hourKey] = zeroTokenBucket()), bucket)
    const hourProviders = perHourProvider[hourKey] || (perHourProvider[hourKey] = {})
    addTokenBucket(hourProviders[provider] || (hourProviders[provider] = zeroTokenBucket()), bucket)
    requests += 1
  }
  return { requests, perDay, perDayProvider, perDayModel, perDayProviderModel, perHour, perHourProvider }
}

/**
 * 把稀疏的日桶补成固定 windowDays 条升序数组（不足的天补 0），
 * 这样浏览器端可以直接按 tokens.today / tokens.weekStart 切片。
 * dayMap 支持 Map 或普通对象；每项可带 sessions 字段。
 */
export function fillTokenDays(dayMap, todayInput = Date.now(), windowDays = WINDOW_DAYS) {
  const dates = tokenWindowDates(todayInput, windowDays)
  return dates.map((date) => {
    const source = dayMap instanceof Map ? dayMap.get(date) : isPlainObject(dayMap) ? dayMap[date] : null
    const bucket = isPlainObject(source) ? source : null
    return {
      date,
      input: bucket ? tokenCount(bucket.input) : 0,
      output: bucket ? tokenCount(bucket.output) : 0,
      cacheRead: bucket ? tokenCount(bucket.cacheRead) : 0,
      cacheWrite: bucket ? tokenCount(bucket.cacheWrite) : 0,
      reasoning: bucket ? tokenCount(bucket.reasoning) : 0,
      total: bucket ? tokenCount(bucket.total) : 0,
      requests: bucket ? tokenCount(bucket.requests) : 0,
      sessions: bucket ? tokenCount(bucket.sessions) : 0,
    }
  })
}

/**
 * provider 日桶：完整桶（与 tokens.days 同长同序、缺日补 0），
 * sessions = 该供应商当天有调用的去重会话数（与 provider.sessions / day.sessions 同口径）。
 */
function fillProviderDays(providerDaily, providerDaySessions, dates) {
  return dates.map((date) => {
    const bucket = providerDaily instanceof Map ? providerDaily.get(date) : null
    const sessions = providerDaySessions instanceof Map ? providerDaySessions.get(date) : null
    return {
      date,
      input: isPlainObject(bucket) ? tokenCount(bucket.input) : 0,
      output: isPlainObject(bucket) ? tokenCount(bucket.output) : 0,
      cacheRead: isPlainObject(bucket) ? tokenCount(bucket.cacheRead) : 0,
      cacheWrite: isPlainObject(bucket) ? tokenCount(bucket.cacheWrite) : 0,
      reasoning: isPlainObject(bucket) ? tokenCount(bucket.reasoning) : 0,
      total: isPlainObject(bucket) ? tokenCount(bucket.total) : 0,
      requests: isPlainObject(bucket) ? tokenCount(bucket.requests) : 0,
      sessions: sessions instanceof Set ? sessions.size : 0,
    }
  })
}

/** 模型日桶：与 tokens.days 同长同序、缺日补 0，仅图表需要的 {date,total,requests}。 */
function fillModelDays(dayMap, dates) {
  return dates.map((date) => {
    const bucket = dayMap instanceof Map ? dayMap.get(date) : null
    return {
      date,
      total: isPlainObject(bucket) ? tokenCount(bucket.total) : 0,
      requests: isPlainObject(bucket) ? tokenCount(bucket.requests) : 0,
    }
  })
}

/**
 * 今天的 24 小时桶（"00".."23" 升序、缺小时补 0）：
 * 与 providers[].days[] 同字段的完整桶（多序列趋势图需要每小时的 input/output/cache...）；
 * sessions = 该小时有任意供应商调用的去重会话数（provider.hours 时就是该供应商的去重会话数）。
 */
function fillHours(hourTotals, hourSessions) {
  return Array.from({ length: 24 }, (_, index) => {
    const hour = String(index).padStart(2, '0')
    const bucket = hourTotals instanceof Map ? hourTotals.get(hour) : null
    const sessions = hourSessions instanceof Map ? hourSessions.get(hour) : null
    return {
      hour,
      input: isPlainObject(bucket) ? tokenCount(bucket.input) : 0,
      output: isPlainObject(bucket) ? tokenCount(bucket.output) : 0,
      cacheRead: isPlainObject(bucket) ? tokenCount(bucket.cacheRead) : 0,
      cacheWrite: isPlainObject(bucket) ? tokenCount(bucket.cacheWrite) : 0,
      reasoning: isPlainObject(bucket) ? tokenCount(bucket.reasoning) : 0,
      total: isPlainObject(bucket) ? tokenCount(bucket.total) : 0,
      requests: isPlainObject(bucket) ? tokenCount(bucket.requests) : 0,
      sessions: sessions instanceof Set ? sessions.size : 0,
    }
  })
}

/** 往「日 → {total,requests}」Map 里累加一个桶（模型日桶聚合用）。 */
function addDayPoint(dayMap, date, bucket) {
  if (!(dayMap instanceof Map)) return
  const target = dayMap.get(date) || { total: 0, requests: 0 }
  target.total += isPlainObject(bucket) ? tokenCount(bucket.total) : 0
  target.requests += isPlainObject(bucket) ? tokenCount(bucket.requests) : 0
  dayMap.set(date, target)
}

/** 合并两个「日 → {total,requests}」Map（(其余) 合并时用）。 */
function mergeDayMaps(target, source) {
  if (!(source instanceof Map) || !(target instanceof Map)) return target
  for (const [date, bucket] of source) addDayPoint(target, date, bucket)
  return target
}

/**
 * 单个供应商的模型榜：按 total 降序，最多 10 条；其余合并成 model:"(其余)"。
 * 每条都带与 tokens.days 对齐的 days 数组；(其余) 的 days 由被合并模型逐日相加。
 */
function rankProviderModels(entries, dates) {
  const rows = [...entries.entries()].map(([model, entry]) => ({
    model,
    bucket: isPlainObject(entry && entry.bucket) ? entry.bucket : zeroTokenBucket(),
    daysMap: entry && entry.days instanceof Map ? entry.days : new Map(),
  }))
  rows.sort((left, right) => {
    if (tokenCount(right.bucket.total) !== tokenCount(left.bucket.total)) {
      return tokenCount(right.bucket.total) - tokenCount(left.bucket.total)
    }
    if (tokenCount(right.bucket.requests) !== tokenCount(left.bucket.requests)) {
      return tokenCount(right.bucket.requests) - tokenCount(left.bucket.requests)
    }
    return left.model < right.model ? -1 : left.model > right.model ? 1 : 0
  })
  const toRow = (row) => ({ model: row.model, ...row.bucket, days: fillModelDays(row.daysMap, dates) })
  if (rows.length <= MAX_MODELS) return rows.map(toRow)
  const top = rows.slice(0, MAX_MODELS).map(toRow)
  const rest = zeroTokenBucket()
  const restDays = new Map()
  for (const row of rows.slice(MAX_MODELS)) {
    addTokenBucket(rest, row.bucket)
    mergeDayMaps(restDays, row.daysMap)
  }
  top.push({ model: REST_MODEL_LABEL, ...rest, days: fillModelDays(restDays, dates) })
  return top
}

/**
 * 全供应商合并模型榜：按 total 降序，最多 10 条；其余合并成 {provider:"(其余)",model:"(其余)"}。
 * 每条都带与 tokens.days 对齐的 days 数组；(其余) 的 days 由被合并条目逐日相加。
 */
function rankGlobalModels(entries, dates) {
  const rows = [...entries.values()].map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    bucket: isPlainObject(entry.bucket) ? entry.bucket : zeroTokenBucket(),
    daysMap: entry.days instanceof Map ? entry.days : new Map(),
  }))
  rows.sort((left, right) => {
    if (tokenCount(right.bucket.total) !== tokenCount(left.bucket.total)) {
      return tokenCount(right.bucket.total) - tokenCount(left.bucket.total)
    }
    if (tokenCount(right.bucket.requests) !== tokenCount(left.bucket.requests)) {
      return tokenCount(right.bucket.requests) - tokenCount(left.bucket.requests)
    }
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1
    return left.model < right.model ? -1 : left.model > right.model ? 1 : 0
  })
  const toRow = (row) => ({
    provider: row.provider,
    model: row.model,
    ...row.bucket,
    days: fillModelDays(row.daysMap, dates),
  })
  if (rows.length <= MAX_MODELS) return rows.map(toRow)
  const top = rows.slice(0, MAX_MODELS).map(toRow)
  const rest = zeroTokenBucket()
  const restDays = new Map()
  for (const row of rows.slice(MAX_MODELS)) {
    addTokenBucket(rest, row.bucket)
    mergeDayMaps(restDays, row.daysMap)
  }
  top.push({
    provider: REST_PROVIDER_LABEL,
    model: REST_MODEL_LABEL,
    ...rest,
    days: fillModelDays(restDays, dates),
  })
  return top
}

/**
 * 多会话折叠结果 → { days, providers, models, hours }（契约第 3 节 tokens 的核心数据）：
 *  - days：全部供应商合计的固定 windowDays 条日桶（sessions = 当天有任意供应商调用的去重会话数）；
 *  - hours：**本地今天**的 24 个小时桶（hour "00".."23"，缺小时补 0；历史日期不输出）；
 *  - providers：按 total 降序，每项含窗口 totals、模型榜（每条带日桶）、与 days 对齐的完整日桶、
 *    与 hours 对齐的今日小时桶；
 *  - models：全供应商合并模型榜（top10 + 一条 (其余)，每条带日桶），每条带 provider。
 * 所有求和都只取 windowKeys 内日期 / today 内小时，保证：
 *   sum(providers[].days[].total) === providers[].total；
 *   sum(models[].days[].total) === models[].total；
 *   sum(tokens.days[].total) === sum(models[].total)；
 *   sum(tokens.hours[].total) === tokens.days[last].total（今天）；
 *   sum(providers[].hours[].total) === providers[].days[last].total。
 */
export function aggregateTokenStats(sessions, options = {}) {
  const todayKey =
    typeof options.today === 'string' && options.today !== '' ? options.today : localDayKey(Date.now())
  const windowDays =
    typeof options.windowDays === 'number' && options.windowDays > 0
      ? Math.floor(options.windowDays)
      : WINDOW_DAYS
  const dates = tokenWindowDates(todayKey, windowDays)
  const windowKeys = new Set(dates)
  const todayPrefix = todayKey + 'T'

  const daily = new Map()
  const daySessions = new Map()
  const hourTotals = new Map() // hour("00".."23") → bucket（仅今天）
  const hourSessions = new Map() // hour → Set(sessionId)
  const providerTotals = new Map()
  const providerSessions = new Map()
  const providerDaily = new Map() // provider → Map(day → 完整 bucket)
  const providerDaySessions = new Map() // provider → Map(day → Set(sessionId))
  const providerHourTotals = new Map() // provider → Map(hour → bucket)
  const providerHourSessions = new Map() // provider → Map(hour → Set(sessionId))
  const providerModels = new Map() // provider → Map(model → { bucket, days: Map })
  const globalModels = new Map() // "provider\u0000model" → { provider, model, bucket, days }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isPlainObject(session) || !isPlainObject(session.fold)) continue
    const sessionId = typeof session.id === 'string' ? session.id : null
    const fold = session.fold

    // 全部供应商合计日桶 + 当天去重会话数
    const perDay = isPlainObject(fold.perDay) ? fold.perDay : {}
    for (const [date, bucket] of Object.entries(perDay)) {
      if (!windowKeys.has(date) || !isPlainObject(bucket)) continue
      const target = daily.get(date) || zeroTokenBucket()
      addTokenBucket(target, bucket)
      daily.set(date, target)
      if (tokenCount(bucket.requests) > 0 && sessionId !== null) {
        const set = daySessions.get(date) || new Set()
        set.add(sessionId)
        daySessions.set(date, set)
      }
    }

    // 供应商合计 + 供应商完整日桶 + 供应商去重会话数（窗口内）
    const perDayProvider = isPlainObject(fold.perDayProvider) ? fold.perDayProvider : {}
    for (const [date, providers] of Object.entries(perDayProvider)) {
      if (!windowKeys.has(date) || !isPlainObject(providers)) continue
      for (const [provider, bucket] of Object.entries(providers)) {
        if (!isPlainObject(bucket)) continue
        const target = providerTotals.get(provider) || zeroTokenBucket()
        addTokenBucket(target, bucket)
        providerTotals.set(provider, target)

        let dayMap = providerDaily.get(provider)
        if (!dayMap) {
          dayMap = new Map()
          providerDaily.set(provider, dayMap)
        }
        const dayBucket = dayMap.get(date) || zeroTokenBucket()
        addTokenBucket(dayBucket, bucket)
        dayMap.set(date, dayBucket)

        if (sessionId !== null && tokenCount(bucket.requests) > 0) {
          const set = providerSessions.get(provider) || new Set()
          set.add(sessionId)
          providerSessions.set(provider, set)
          let sessionDayMap = providerDaySessions.get(provider)
          if (!sessionDayMap) {
            sessionDayMap = new Map()
            providerDaySessions.set(provider, sessionDayMap)
          }
          const daySet = sessionDayMap.get(date) || new Set()
          daySet.add(sessionId)
          sessionDayMap.set(date, daySet)
        }
      }
    }

    // 今天的小时桶（只有 todayKey 当天；稀疏 fold 里其它日期的小时直接忽略）
    const perHour = isPlainObject(fold.perHour) ? fold.perHour : {}
    for (const [hourKey, bucket] of Object.entries(perHour)) {
      if (!hourKey.startsWith(todayPrefix) || !isPlainObject(bucket)) continue
      const hour = hourKey.slice(todayPrefix.length)
      if (!/^\d{2}$/.test(hour) || Number(hour) > 23) continue
      const target = hourTotals.get(hour) || zeroTokenBucket()
      addTokenBucket(target, bucket)
      hourTotals.set(hour, target)
      if (tokenCount(bucket.requests) > 0 && sessionId !== null) {
        const set = hourSessions.get(hour) || new Set()
        set.add(sessionId)
        hourSessions.set(hour, set)
      }
    }

    // 供应商小时桶（同样只取今天）
    const perHourProvider = isPlainObject(fold.perHourProvider) ? fold.perHourProvider : {}
    for (const [hourKey, providers] of Object.entries(perHourProvider)) {
      if (!hourKey.startsWith(todayPrefix) || !isPlainObject(providers)) continue
      const hour = hourKey.slice(todayPrefix.length)
      if (!/^\d{2}$/.test(hour) || Number(hour) > 23) continue
      for (const [provider, bucket] of Object.entries(providers)) {
        if (!isPlainObject(bucket)) continue
        let hourMap = providerHourTotals.get(provider)
        if (!hourMap) {
          hourMap = new Map()
          providerHourTotals.set(provider, hourMap)
        }
        const hourBucket = hourMap.get(hour) || zeroTokenBucket()
        addTokenBucket(hourBucket, bucket)
        hourMap.set(hour, hourBucket)

        if (tokenCount(bucket.requests) > 0 && sessionId !== null) {
          let sessionHourMap = providerHourSessions.get(provider)
          if (!sessionHourMap) {
            sessionHourMap = new Map()
            providerHourSessions.set(provider, sessionHourMap)
          }
          const hourSet = sessionHourMap.get(hour) || new Set()
          hourSet.add(sessionId)
          sessionHourMap.set(hour, hourSet)
        }
      }
    }

    // 供应商模型榜 + 全供应商合并模型榜（都只取窗口内日期；每条带自己的日桶）
    const perDayProviderModel = isPlainObject(fold.perDayProviderModel) ? fold.perDayProviderModel : {}
    for (const [date, providers] of Object.entries(perDayProviderModel)) {
      if (!windowKeys.has(date) || !isPlainObject(providers)) continue
      for (const [provider, models] of Object.entries(providers)) {
        if (!isPlainObject(models)) continue
        let modelMap = providerModels.get(provider)
        if (!modelMap) {
          modelMap = new Map()
          providerModels.set(provider, modelMap)
        }
        for (const [model, bucket] of Object.entries(models)) {
          if (!isPlainObject(bucket)) continue
          let modelEntry = modelMap.get(model)
          if (!modelEntry) {
            modelEntry = { bucket: zeroTokenBucket(), days: new Map() }
            modelMap.set(model, modelEntry)
          }
          addTokenBucket(modelEntry.bucket, bucket)
          addDayPoint(modelEntry.days, date, bucket)

          const globalKey = provider + '\u0000' + model
          let globalEntry = globalModels.get(globalKey)
          if (!globalEntry) {
            globalEntry = { provider, model, bucket: zeroTokenBucket(), days: new Map() }
            globalModels.set(globalKey, globalEntry)
          }
          addTokenBucket(globalEntry.bucket, bucket)
          addDayPoint(globalEntry.days, date, bucket)
        }
      }
    }
  }

  const days = fillTokenDays(daily, todayKey, windowDays).map((day) => ({
    ...day,
    sessions: (daySessions.get(day.date) || new Set()).size,
  }))

  const providers = [...providerTotals.entries()].map(([provider, totals]) => ({
    provider,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    reasoning: totals.reasoning,
    total: totals.total,
    requests: totals.requests,
    sessions: (providerSessions.get(provider) || new Set()).size,
    models: rankProviderModels(providerModels.get(provider) || new Map(), dates),
    days: fillProviderDays(providerDaily.get(provider), providerDaySessions.get(provider), dates),
    hours: fillHours(providerHourTotals.get(provider), providerHourSessions.get(provider)),
  }))
  providers.sort((left, right) => {
    if (right.total !== left.total) return right.total - left.total
    if (right.requests !== left.requests) return right.requests - left.requests
    return left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0
  })

  return {
    days,
    providers,
    models: rankGlobalModels(globalModels, dates),
    hours: fillHours(hourTotals, hourSessions),
  }
}

/** 空 tokens 块：30 天全 0；sessionQuery 不可用或扫描失败时用它兜底。 */
export function emptyTokenStats(now = Date.now()) {
  const today = localDayKey(now)
  return {
    generatedAt: new Date(now).toISOString(),
    timeZone: hostTimeZone(),
    today,
    weekStart: weekStartDate(now),
    windowDays: WINDOW_DAYS,
    scope: 'all-providers',
    days: fillTokenDays(null, today, WINDOW_DAYS),
    // 今天 24 小时（hour:"00".."23"，缺小时补 0）；历史日期不输出小时桶
    hours: fillHours(null, null),
    providers: [],
    models: [],
    scan: {
      sessions: 0,
      candidates: 0,
      scanned: 0,
      fromCache: 0,
      covered: 0,
      failed: 0,
      retired: 0,
      pending: 0,
      elapsedMs: 0,
      partial: false,
    },
  }
}

/* ------------------------------------------------------------------ *
 * snapshot 组装（纯函数）
 * ------------------------------------------------------------------ */

export function emptyOfficial(fetchedAt = new Date().toISOString()) {
  return { fetchedAt, range24h: null, range7d: null, range30d: null }
}

function sanitizeErrors(errors) {
  const list = Array.isArray(errors) ? errors : []
  const result = []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    if (typeof item.source !== 'string' || typeof item.code !== 'string') continue
    result.push({
      source: item.source,
      code: item.code,
      message: typeof item.message === 'string' ? item.message : '',
    })
  }
  return result
}

/**
 * 组装 snapshot / refresh 的 value（契约第 3 节，version 1）。
 * 所有子块都有稳定默认值，保证浏览器端永远能按同一形状消费。
 */
export function buildSnapshot(parts = {}) {
  const now = typeof parts.now === 'number' ? parts.now : Date.now()
  const updatedAt = typeof parts.updatedAt === 'string' ? parts.updatedAt : new Date(now).toISOString()
  const key = isPlainObject(parts.key) ? parts.key : {}
  return {
    version: 1,
    updatedAt,
    cached: parts.cached === true,
    key: {
      source: typeof key.source === 'string' ? key.source : 'none',
      masked: typeof key.masked === 'string' ? key.masked : null,
    },
    limits: isPlainObject(parts.limits) ? parts.limits : emptyLimits(),
    official: isPlainObject(parts.official) ? parts.official : emptyOfficial(updatedAt),
    tokens: isPlainObject(parts.tokens) ? parts.tokens : emptyTokenStats(now),
    errors: sanitizeErrors(parts.errors),
  }
}

/* ------------------------------------------------------------------ *
 * 持久化（$DSH_HOME/storages/ollama-statistical/）
 * ------------------------------------------------------------------ */

/** 与旧插件不同，这里不依赖 @deepseek-ai/dsh-home-paths，只用 DSH_HOME / homedir。 */
function resolveDshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function storageDir() {
  return join(resolveDshHome(), 'storages', STORAGE_DIRNAME)
}

function statePath() {
  return join(storageDir(), STATE_FILE)
}

function tokenCachePath() {
  return join(storageDir(), TOKEN_CACHE_FILE)
}

function ledgerPath() {
  return join(storageDir(), LEDGER_FILE)
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把文件权限收紧到「仅当前用户可读写」。
 *
 * 平台差异（实测）：
 *  - POSIX：chmodSync(0o600) 就是契约承诺的 0600；
 *  - Windows：Node 的 fs mode 会被忽略，普通继承 ACL 下实测仍是 0666，
 *    因此额外 best-effort 调 `icacls /inheritance:r /grant:r <user>:(R,W)`
 *    去掉继承、只授权当前用户。失败静默（例如 icacls 不存在 / 路径被占用），
 *    不影响写盘本身；README 里已注明这是「尽力收紧」而非严格 0600。
 */
function tightenFilePermissions(filePath) {
  try {
    chmodSync(filePath, 0o600)
  } catch {
    /* Windows / 特殊文件系统上 chmod 可能无效，交给下面的 icacls */
  }
  if (process.platform !== 'win32') return
  const user = typeof process.env.USERNAME === 'string' ? process.env.USERNAME.trim() : ''
  if (user === '') return
  try {
    spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', user + ':(R,W)'], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    })
  } catch {
    /* best effort：权限收紧失败不影响功能 */
  }
}

/**
 * 原子写：先写同目录临时文件再 rename，避免进程被杀时留下半截 JSON；
 * 写盘后尽力把权限收紧到 0600（POSIX chmod / Windows icacls）。
 * 返回 true 表示写盘成功；任何异常返回 false（调用方静默降级）。
 * 导出供单测直接验证成功/失败分支。
 */
export function writeJsonAtomic(filePath, value) {
  let tempPath = null
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    // 临时文件与目标同目录，rename 保持原子性；先收紧临时文件权限，
    // Windows rename 会保留文件自身的安全描述符，目标文件因此一起被收紧。
    tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tempPath, JSON.stringify(value), { mode: 0o600 })
    tightenFilePermissions(tempPath)
    renameSync(tempPath, filePath)
    return true
  } catch {
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath)
      } catch {
        /* 清理失败无所谓，下次覆盖 */
      }
    }
    return false
  }
}

function createRuntime(ctx) {
  return {
    ctx,
    /** 磁盘状态：{ version:1, manualKey?, lastSnapshot?, lastSnapshotAt? } */
    state: { version: 1, manualKey: null, lastSnapshot: null, lastSnapshotAt: null },
    /** 会话级 token 缓存：sessionId → { createdAt, fold }（内存 Map + 磁盘 token-cache.json） */
    tokenCache: new Map(),
    /** 最近一次采集结果：{ value, fetchedAt }（60s TTL） */
    snapshotCache: null,
    /** 采集去重：并发 snapshot 共享同一次采集 */
    inflight: null,
    /** 最近一次「成功完成采集」的时间（ms）：refresh 的 15s 最小间隔保护用 */
    lastCollectAt: 0,
    /**
     * 读取失败的会话记忆：sessionId → { at, message }（内存 + token-cache.json failures 字段）。
     * FAILURE_TTL_MS 内不再 readSession，直接计入 scan.failed；过期后重试一次。
     */
    scanFailures: new Map(),
    /**
     * 墓碑账本（内存 Map + 磁盘 ledger.json）：
     *  - known:   sessionId → { createdAt }，曾经成功统计过的会话，用于检测「消失」；
     *  - retired: sessionId → { createdAt, fold }，已从 listSessions 消失的会话墓碑，
     *             保留 fold 原样继续计入聚合（删除会话后 token 统计不缩水）。
     * token-cache 只是加速缓存，账本是事实来源，两者互不依赖。
     */
    ledger: { known: new Map(), retired: new Map() },
    ledgerDirty: false,
    /** 官方 429 冷却截止时间 */
    rateLimitedUntil: 0,
    cacheDirty: false,
    /**
     * 后台补齐状态：{ running, cancelled, plan, disposers:Set, yieldFinish }
     * plan = { sessionQuery, isLive, todayKey, sessionsTotal, candidateCount,
     *          coveredIds:Set, pending:[record], fromCache, scanned, failures, startedAt, deadlineAt }
     */
    warm: {
      running: false,
      cancelled: false,
      plan: null,
      disposers: new Set(),
      yieldFinish: null,
    },
  }
}

/** 载入 state/token-cache/ledger；导出供单测验证「旧版本缓存/账本被丢弃」。 */
export function loadPersisted(rt) {
  const state = readJsonFile(statePath())
  if (state && state.version === 1) {
    if (typeof state.manualKey === 'string' && state.manualKey.trim() !== '') {
      rt.state.manualKey = state.manualKey.trim()
    }
    if (isPlainObject(state.lastSnapshot) && state.lastSnapshot.version === 1) {
      rt.state.lastSnapshot = state.lastSnapshot
      rt.state.lastSnapshotAt =
        typeof state.lastSnapshotAt === 'string'
          ? state.lastSnapshotAt
          : typeof state.lastSnapshot.updatedAt === 'string'
            ? state.lastSnapshot.updatedAt
            : null
    }
  }

  // token-cache v2 起 fold 用 perDayModel；旧版本直接丢弃，避免旧 fold（perModel）误用。
  const cache = readJsonFile(tokenCachePath())
  if (cache && cache.version === TOKEN_CACHE_VERSION && isPlainObject(cache.sessions)) {
    for (const [sessionId, entry] of Object.entries(cache.sessions)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!isPlainObject(entry) || typeof entry.createdAt !== 'number' || !isPlainObject(entry.fold)) continue
      rt.tokenCache.set(sessionId, { createdAt: entry.createdAt, fold: entry.fold })
    }
  }
  // 读取失败记忆随缓存一起持久化（可选字段；旧文件没有也能正常加载）。
  if (cache && isPlainObject(cache.failures)) {
    const now = Date.now()
    for (const [sessionId, entry] of Object.entries(cache.failures)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!isPlainObject(entry) || typeof entry.at !== 'number') continue
      if (now - entry.at >= FAILURE_TTL_MS) continue // 过期的不加载，下次自然重试
      rt.scanFailures.set(sessionId, {
        at: entry.at,
        message: typeof entry.message === 'string' ? entry.message : '会话日志读取失败',
      })
    }
  }

  // 墓碑账本与 token-cache 互不依赖：cache 是加速，ledger 是「删除会话后仍保留 token 贡献」的账。
  loadLedger(rt)
}

/** 清掉超过 FAILURE_TTL_MS 的失败记忆，避免 map / 磁盘无限增长。 */
function pruneScanFailures(rt, now = Date.now()) {
  let removed = 0
  for (const [sessionId, entry] of rt.scanFailures) {
    if (!isPlainObject(entry) || typeof entry.at !== 'number' || now - entry.at >= FAILURE_TTL_MS) {
      rt.scanFailures.delete(sessionId)
      removed += 1
    }
  }
  if (removed > 0) rt.cacheDirty = true
}

function persistState(rt) {
  writeJsonAtomic(statePath(), {
    version: 1,
    manualKey: rt.state.manualKey || undefined,
    lastSnapshot: rt.state.lastSnapshot || undefined,
    lastSnapshotAt: rt.state.lastSnapshotAt || undefined,
  })
}

function persistTokenCache(rt) {
  pruneScanFailures(rt)
  if (!rt.cacheDirty) return
  const sessions = {}
  for (const [sessionId, entry] of rt.tokenCache) {
    sessions[sessionId] = { createdAt: entry.createdAt, fold: entry.fold }
  }
  const failures = {}
  for (const [sessionId, entry] of rt.scanFailures) {
    if (isPlainObject(entry)) failures[sessionId] = { at: entry.at, message: entry.message }
  }
  const written = writeJsonAtomic(tokenCachePath(), {
    version: TOKEN_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    sessions,
    failures,
  })
  if (written) rt.cacheDirty = false
}

/* ------------------------------------------------------------------ *
 * 墓碑账本（ledger.json）：
 * 会话日志被删除后，它贡献的 per-day token 不能从「今天/本周/自定义」里消失。
 * 账本记录 known（曾统计过的会话）与 retired（已从 listSessions 消失的会话 fold 墓碑），
 * 聚合时把 retired 的 fold 一起并入（aggregateTokenStats 仍按 30 天窗口过滤）。
 * ------------------------------------------------------------------ */

/** 读取账本；文件缺失/损坏/版本不符 → 当作空账本继续（不报错）。导出供单测。 */
export function loadLedger(rt) {
  const raw = readJsonFile(ledgerPath())
  if (!raw || raw.version !== LEDGER_VERSION) return { loaded: false, known: 0, retired: 0 }
  let knownCount = 0
  let retiredCount = 0
  if (isPlainObject(raw.known)) {
    for (const [sessionId, entry] of Object.entries(raw.known)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!isPlainObject(entry) || typeof entry.createdAt !== 'number') continue
      rt.ledger.known.set(sessionId, { createdAt: entry.createdAt })
      knownCount += 1
    }
  }
  if (isPlainObject(raw.retired)) {
    for (const [sessionId, entry] of Object.entries(raw.retired)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!isPlainObject(entry) || typeof entry.createdAt !== 'number' || !isPlainObject(entry.fold)) continue
      rt.ledger.retired.set(sessionId, { createdAt: entry.createdAt, fold: entry.fold })
      retiredCount += 1
    }
  }
  return { loaded: true, known: knownCount, retired: retiredCount }
}

/** 账本按需落盘（只在有变更时写）；写失败静默（writeJsonAtomic 返回 false），不影响主流程。导出供单测。 */
export function persistLedger(rt) {
  if (!rt || !rt.ledgerDirty) return false
  const known = {}
  for (const [sessionId, entry] of rt.ledger.known) {
    if (isPlainObject(entry)) known[sessionId] = { createdAt: entry.createdAt }
  }
  const retired = {}
  for (const [sessionId, entry] of rt.ledger.retired) {
    if (isPlainObject(entry)) retired[sessionId] = { createdAt: entry.createdAt, fold: entry.fold }
  }
  const written = writeJsonAtomic(ledgerPath(), { version: LEDGER_VERSION, known, retired })
  if (written) rt.ledgerDirty = false
  return written
}

/** retired 的 fold 是否还有窗口内的日期（没有就剪掉，避免窗口滚动后账本永久残留）。 */
function foldTouchesWindow(fold, windowKeys) {
  if (!(windowKeys instanceof Set)) return true // 无法判定时保守保留
  if (!isPlainObject(fold)) return false
  const perDay = isPlainObject(fold.perDay) ? fold.perDay : {}
  for (const date of Object.keys(perDay)) {
    if (windowKeys.has(date)) return true
  }
  return false
}

/**
 * 维护墓碑账本（纯函数，导出供单测）：
 *  1. 本次 covered 的会话写入 known；若它曾退休（会话恢复/回收站还原）→ 删 retired，避免双计；
 *  2. 会话重新出现在 listSessions.currentIds（即使本次还没扫到）→ 删 retired（不再算删除）；
 *  3. known 里已从 listSessions 消失的会话 → fold 取 tokenCache，其次已有 retired fold，
 *     有则移入 retired（保留 createdAt）并从 known / tokenCache 删除；
 *  4. 修剪：createdAt < candidateMinMs 的 known/retired；retired 的 fold 无窗口内日期也删。
 *
 * options: { known, retired, tokenCache: Map, currentIds: Set, covered: [{id,createdAt}],
 *            candidateMinMs, windowKeys: Set }
 * 返回 { changed, retiredFolds: [{id, fold}], retiredCount }
 */
export function reconcileLedger(options = {}) {
  const known = options.known instanceof Map ? options.known : new Map()
  const retired = options.retired instanceof Map ? options.retired : new Map()
  const tokenCache = options.tokenCache instanceof Map ? options.tokenCache : new Map()
  const currentIds = options.currentIds instanceof Set ? options.currentIds : new Set()
  const covered = Array.isArray(options.covered) ? options.covered : []
  const candidateMinMs = readFiniteNumber(options.candidateMinMs)
  const windowKeys = options.windowKeys instanceof Set ? options.windowKeys : null
  let changed = false

  // 1) 本次 covered：写 known；曾退休的会话恢复 → 删墓碑
  for (const item of covered) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue
    if (typeof item.createdAt === 'number') {
      const existing = known.get(item.id)
      if (!isPlainObject(existing) || existing.createdAt !== item.createdAt) changed = true
      known.set(item.id, { createdAt: item.createdAt })
    }
    if (retired.delete(item.id)) changed = true
  }

  // 2) 会话重新出现在 listSessions（即使还没扫到）→ 不再算删除
  for (const sessionId of [...retired.keys()]) {
    if (currentIds.has(sessionId)) {
      retired.delete(sessionId)
      changed = true
    }
  }

  // 3) known 里已消失的会话 → 移入 retired（保留 fold，token 贡献不缩水）
  for (const [sessionId, entry] of [...known]) {
    if (currentIds.has(sessionId)) continue
    const cached = tokenCache.get(sessionId)
    const fold = cached && isPlainObject(cached.fold) ? cached.fold : retired.get(sessionId)?.fold ?? null
    if (isPlainObject(fold)) retired.set(sessionId, { createdAt: entry.createdAt, fold })
    known.delete(sessionId)
    tokenCache.delete(sessionId)
    changed = true
  }

  // 4) 修剪：窗口外 createdAt；retired 的 fold 无窗口内日期
  if (candidateMinMs !== null) {
    for (const [sessionId, entry] of [...known]) {
      if (!isPlainObject(entry) || !(entry.createdAt >= candidateMinMs)) {
        known.delete(sessionId)
        changed = true
      }
    }
    for (const [sessionId, entry] of [...retired]) {
      if (
        !isPlainObject(entry) ||
        !(entry.createdAt >= candidateMinMs) ||
        !foldTouchesWindow(entry.fold, windowKeys)
      ) {
        retired.delete(sessionId)
        changed = true
      }
    }
  }

  const retiredFolds = []
  for (const [id, entry] of retired) {
    if (isPlainObject(entry) && isPlainObject(entry.fold)) retiredFolds.push({ id, fold: entry.fold })
  }
  return { changed, retiredFolds, retiredCount: retiredFolds.length }
}

/* ------------------------------------------------------------------ *
 * key 的真实来源（注入给 resolveApiKey）
 * ------------------------------------------------------------------ */

function readLocalCliToken() {
  const filePath = join(homedir(), '.ollama', 'auth.json')
  const parsed = readJsonFile(filePath)
  if (parsed && typeof parsed.token === 'string' && parsed.token.trim() !== '') {
    return parsed.token.trim()
  }
  return null
}

function runtimeKeySources(rt) {
  return {
    resolveCredential: async () => {
      const ctx = rt.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      const service = ctx.get('credentials')
      if (!service || typeof service.resolve !== 'function') return null
      const resolved = await service.resolve(KEY_REF)
      return resolved && typeof resolved.value === 'string' ? resolved.value : null
    },
    env: () => process.env.OLLAMA_API_KEY,
    readLocalToken: () => readLocalCliToken(),
    readManualKey: () => rt.state.manualKey,
  }
}

/* ------------------------------------------------------------------ *
 * 官方 HTTP 请求（20s 超时 + 错误分类）
 * ------------------------------------------------------------------ */

/**
 * GET 一个 Ollama 官方接口。
 * 成功 → { ok:true, json }
 * 失败 → { ok:false, code, message, status, retryAfterMs? }，code 与契约错误码一致：
 *   unauthorized / rate-limit / network / http / internal。
 * 导出供单测用 stub fetch 覆盖 429/超时/非 JSON 等分支。
 */
export async function requestJson(url, key) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + key,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    const errorName = error && error.name
    const message =
      errorName === 'TimeoutError' || errorName === 'AbortError'
        ? '请求 Ollama 超时（' + FETCH_TIMEOUT_MS + 'ms）'
        : '请求 Ollama 失败：' + describeError(error)
    return { ok: false, code: 'network', message, status: null }
  }

  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  let text
  try {
    text = await response.text()
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: '读取 Ollama 响应失败：' + describeError(error),
      status: response.status,
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'Ollama 拒绝了该 API Key（HTTP ' + response.status + '），请检查 OLLAMA_API_KEY 是否有效。',
      status: response.status,
    }
  }
  if (response.status === 429) {
    const seconds = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000)
    return {
      ok: false,
      code: 'rate-limit',
      message:
        'Ollama 接口限流（HTTP 429）' + (seconds === null ? '' : '，请等待约 ' + seconds + ' 秒'),
      status: 429,
      retryAfterMs: retryAfterMs === null ? DEFAULT_RATE_LIMIT_COOLDOWN_MS : retryAfterMs,
    }
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      code: 'http',
      message: 'Ollama 接口返回 HTTP ' + response.status,
      status: response.status,
    }
  }

  try {
    return { ok: true, json: JSON.parse(text), status: response.status }
  } catch {
    return { ok: false, code: 'internal', message: 'Ollama 返回的不是合法 JSON', status: response.status }
  }
}

/* ------------------------------------------------------------------ *
 * 采集：官方数据 + 本机 token
 * ------------------------------------------------------------------ */

/** 导出供单测（stub fetch 验证 429 冷却窗口）。 */
export async function collectOfficial(rt, key) {
  // balance 与 24h/7d/30d usage 并行发（契约要求），4 个请求远低于 10/分钟限流。
  const [balance, usage24h, usage7d, usage30d] = await Promise.all([
    requestJson(BALANCE_URL, key),
    requestJson(USAGE_URL + '?range=24h', key),
    requestJson(USAGE_URL + '?range=7d', key),
    requestJson(USAGE_URL + '?range=30d', key),
  ])

  const errors = []
  let maxRetryAfterMs = 0
  const noteFailure = (source, failure) => {
    errors.push({ source, code: failure.code, message: failure.message })
    if (typeof failure.retryAfterMs === 'number' && failure.retryAfterMs > maxRetryAfterMs) {
      maxRetryAfterMs = failure.retryAfterMs
    }
  }

  let limits = emptyLimits()
  if (balance.ok) {
    try {
      limits = parseBalance(balance.json)
    } catch (error) {
      errors.push({ source: 'balance', code: 'internal', message: describeError(error) })
    }
  } else {
    noteFailure('balance', balance)
  }

  const official = emptyOfficial(new Date().toISOString())
  const ranges = [
    ['range24h', usage24h, 'usage24h', '24h'],
    ['range7d', usage7d, 'usage7d', '7d'],
    ['range30d', usage30d, 'usage30d', '30d'],
  ]
  for (const [slot, result, source, range] of ranges) {
    if (!result.ok) {
      noteFailure(source, result)
      continue
    }
    try {
      official[slot] = aggregateOfficialUsage(result.json, range)
    } catch (error) {
      errors.push({ source, code: 'internal', message: describeError(error) })
    }
  }

  // 命中 429 时记下冷却窗口，后续 snapshot 在冷却期内直接走缓存，避免继续打官方接口。
  if (maxRetryAfterMs > 0) {
    rt.rateLimitedUntil = Math.max(rt.rateLimitedUntil, Date.now() + maxRetryAfterMs)
  }

  // 四个官方请求全部因为网络异常失败 → 视为“无网络”，交给调用方回退到 lastSnapshot
  // （契约第 3 节：snapshot 无网络时返回 lastSnapshot + cached:true + errors 说明）。
  const allNetworkFailed =
    balance.ok === false &&
    balance.code === 'network' &&
    usage24h.ok === false &&
    usage24h.code === 'network' &&
    usage7d.ok === false &&
    usage7d.code === 'network' &&
    usage30d.ok === false &&
    usage30d.code === 'network'

  return { limits, official, errors, allNetworkFailed }
}

function tokenScanError(source, code, message) {
  return { source, code, message }
}

/**
 * 记录一次会话读取失败（FAILURE_TTL_MS 内不再重试）。
 * 若该会话是旧格式（migration-required），message 里补一句可操作提示——
 * formatStatus 只用于提示，不再作为整类跳过候选的依据。
 */
export function noteScanFailure(rt, record, error, now = Date.now()) {
  const header = record && record.header
  if (!rt || !rt.scanFailures || !header || typeof header.id !== 'string') return null
  const rawMessage = typeof error === 'string' ? error : describeError(error)
  const hint =
    record.formatStatus === 'migration-required'
      ? '（旧格式，需在 DSH 中打开一次完成迁移）'
      : ''
  const entry = { at: now, message: rawMessage + hint }
  rt.scanFailures.set(header.id, entry)
  rt.cacheDirty = true
  return entry
}

/** 该会话在 FAILURE_TTL_MS 内读取失败过？命中时顺手删除过期记录（过期后重试一次）。 */
export function isSessionFailed(rt, sessionId, now = Date.now()) {
  if (!rt || !rt.scanFailures || typeof sessionId !== 'string') return false
  const entry = rt.scanFailures.get(sessionId)
  if (!isPlainObject(entry) || typeof entry.at !== 'number') return false
  if (now - entry.at >= FAILURE_TTL_MS) {
    rt.scanFailures.delete(sessionId)
    rt.cacheDirty = true
    return false
  }
  return true
}

/**
 * token 扫描统计（契约第 3 节 scan 形状，纯函数）。
 *
 * 身份关系：covered + failed + pending === candidates
 *  - covered：已并入本次聚合的会话（fromCache + 成功 scanned）；
 *  - failed ：读取失败且仍在 FAILURE_TTL_MS 记忆内的会话（数据缺失，单独告知，不钉死 partial）；
 *  - retired：已从 listSessions 消失、但账本保留 fold 并继续并入聚合的墓碑会话数（不属于 candidates）；
 *  - pending：尚未处理、交给后台补齐的会话；
 *  - partial = pending > 0（failed 不再让 partial 永久为 true）。
 * 兼容旧参数：未提供 failed 时接受 input.failures（上一版字段名）。
 */
export function summarizeTokenScan(input = {}) {
  const sessions = tokenCount(input.sessions)
  const candidates = tokenCount(input.candidates)
  const covered = Math.min(candidates, tokenCount(input.covered))
  const failed = Math.min(candidates - covered, tokenCount(input.failed !== undefined ? input.failed : input.failures))
  const pending = Math.max(0, candidates - covered - failed)
  return {
    sessions,
    candidates,
    scanned: tokenCount(input.scanned),
    fromCache: tokenCount(input.fromCache),
    covered,
    failed,
    retired: tokenCount(input.retired),
    pending,
    elapsedMs: tokenCount(input.elapsedMs),
    partial: pending > 0,
  }
}

/**
 * 前台扫描核心（纯逻辑 + 注入依赖，便于单测预算切片）：
 *
 *  1. 第一遍「缓存优先」：非 live 且 tokenCache 里有同 createdAt 的 fold → 直接并入聚合，
 *     绝不 readSession（这是 snapshot 快速返回的关键）；
 *  2. 「已知失败」：FAILURE_TTL_MS 内读取失败过的会话不再 readSession，直接计 failed，
 *     避免每次刷新/每轮 warm 都重试读不了的旧格式或损坏会话；
 *  3. 第二遍「增量读」：只对 live / 无缓存 / 非已知失败的会话 readSession，
 *     受 budgetMs（默认 FOREGROUND_SCAN_MS）与 maxSessions 双重预算约束，
 *     预算用尽后剩余候选原样放进 pending，交给后台补齐；读取失败 → onFailure 记录 + 计 failed。
 *
 * 身份关系：covered + failed + pending === candidates；partial = pending > 0。
 *
 * options:
 *  - candidates: [{ header: { id, createdAt }, live?, formatStatus? }]
 *  - isLive(record): boolean
 *  - getCachedFold(sessionId): { createdAt, fold } | null | undefined
 *  - readSession(sessionId): Promise<{ events }>（失败抛错）
 *  - storeFold(record, fold): 成功读取后写缓存
 *  - isKnownFailed(sessionId): boolean（失败记忆 TTL 内 → 跳过读取、计 failed）
 *  - onFailure(record, error): 实际读取失败回调（写 rt.scanFailures）
 *  - clearFailure(sessionId): 读取成功后清除失败记忆
 *  - aggregate(events): 默认 aggregateSessionEvents(events)
 *  - now(): 可注入时钟；budgetMs / maxSessions：预算覆盖
 *
 * 返回 { folds, coveredIds, failedIds, failedRecords, pending, candidates, covered,
 *        failed, pendingCount, scanned, scannedSuccess, fromCache, failures, elapsedMs, partial }
 */
export async function runForegroundScan(options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : []
  const isLive = typeof options.isLive === 'function' ? options.isLive : () => false
  const readSession = typeof options.readSession === 'function' ? options.readSession : null
  const getCachedFold = typeof options.getCachedFold === 'function' ? options.getCachedFold : () => null
  const storeFold = typeof options.storeFold === 'function' ? options.storeFold : null
  const isKnownFailed = typeof options.isKnownFailed === 'function' ? options.isKnownFailed : () => false
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : null
  const clearFailure = typeof options.clearFailure === 'function' ? options.clearFailure : null
  const aggregate =
    typeof options.aggregate === 'function'
      ? options.aggregate
      : (events) => aggregateSessionEvents(events)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const budgetMs =
    readFiniteNumber(options.budgetMs) === null ? FOREGROUND_SCAN_MS : Math.max(0, options.budgetMs)
  const maxSessions =
    readFiniteNumber(options.maxSessions) === null
      ? MAX_SCAN_SESSIONS
      : Math.max(0, Math.floor(options.maxSessions))
  const startedAt = now()

  const seen = new Set()
  const folds = []
  const coveredIds = []
  const failedIds = []
  const failedRecords = []
  const needsRead = []
  let fromCache = 0

  // 第一遍：缓存优先（不 readSession）+ 已知失败跳过
  for (const record of candidates) {
    const header = record && record.header
    if (!header || typeof header.id !== 'string') continue
    if (seen.has(header.id)) continue
    seen.add(header.id)
    if (!isLive(record)) {
      const cached = getCachedFold(header.id)
      if (cached && cached.createdAt === header.createdAt && isPlainObject(cached.fold)) {
        folds.push({ id: header.id, fold: cached.fold })
        coveredIds.push(header.id)
        fromCache += 1
        continue
      }
    }
    if (isKnownFailed(header.id)) {
      failedIds.push(header.id)
      failedRecords.push(record)
      continue
    }
    needsRead.push(record)
  }

  // 第二遍：增量读取（前台预算 + 会话数上限）
  const pending = []
  let scanned = 0
  let scannedSuccess = 0
  let failures = 0
  let stopped = false
  for (const record of needsRead) {
    if (stopped) {
      pending.push(record)
      continue
    }
    if (readSession === null || scanned >= maxSessions || now() - startedAt >= budgetMs) {
      stopped = true
      pending.push(record)
      continue
    }
    const header = record.header
    scanned += 1 // 契约：scanned = 本次真正 readSession 的会话数（含读取失败）
    try {
      const session = await readSession(header.id)
      const fold = aggregate(session && session.events)
      folds.push({ id: header.id, fold })
      coveredIds.push(header.id)
      scannedSuccess += 1
      if (storeFold !== null) storeFold(record, fold)
      if (clearFailure !== null) clearFailure(header.id)
    } catch (error) {
      failures += 1
      failedIds.push(header.id)
      failedRecords.push(record)
      if (onFailure !== null) onFailure(record, error)
    }
  }

  return {
    folds,
    coveredIds,
    failedIds,
    failedRecords,
    pending,
    candidates: seen.size,
    covered: coveredIds.length,
    failed: failedIds.length,
    pendingCount: pending.length,
    scanned,
    scannedSuccess,
    fromCache,
    failures,
    elapsedMs: now() - startedAt,
    partial: pending.length > 0,
  }
}

/* ------------------------------------------------------------------ *
 * 后台增量补齐（warm）：
 * 前台 8s 预算用尽后剩下的 pending 会话切片补扫（每片 ≤1.5s），
 * 每片结束把结果写进 tokenCache / 磁盘，并就地刷新 lastSnapshot.tokens 的
 * scan 进度，客户端 60s 轮询就能看到 covered/pending 在收敛。
 * 同一时间只允许一个 warm；插件 dispose 时取消所有定时器。
 * ------------------------------------------------------------------ */

/** 启动（或替换）后台补齐计划；已有 warm 在跑时只替换 plan 并由其循环接管。 */
function scheduleWarm(rt, plan) {
  const warm = rt.warm
  if (!warm || warm.cancelled) return
  warm.plan = plan
  if (warm.running) return
  warm.running = true
  runWarm(rt)
    .catch((error) => {
      console.warn('[ollama-statistical] 后台补齐失败：' + describeError(error))
    })
    .finally(() => {
      warm.running = false
    })
}

async function runWarm(rt) {
  const warm = rt.warm
  while (!warm.cancelled) {
    const plan = warm.plan
    if (!plan) return
    if (plan.pending.length === 0) {
      updateSnapshotTokens(rt, plan)
      return
    }
    if (Date.now() >= plan.deadlineAt) return
    await warmSlice(rt, plan)
    persistTokenCache(rt)
    // 若这一片期间前台又提交了新计划，旧计划的覆盖率已过期，不能拿它回写进度。
    if (warm.plan === plan) updateSnapshotTokens(rt, plan)
    if (warm.cancelled || plan.pending.length === 0) return
    await warmYield(rt)
  }
}

/** 一片：最多 WARM_SLICE_MS 或直到 pending 清空。失败会话从队列移除、计入 failed（不进 pending）。 */
export async function warmSlice(rt, plan) {
  const sliceStartedAt = Date.now()
  const isKnownFailed = typeof plan.isKnownFailed === 'function' ? plan.isKnownFailed : () => false
  const onFailure = typeof plan.onFailure === 'function' ? plan.onFailure : null
  const clearFailure = typeof plan.clearFailure === 'function' ? plan.clearFailure : null
  while (plan.pending.length > 0 && Date.now() - sliceStartedAt < WARM_SLICE_MS && !rt.warm.cancelled) {
    const record = plan.pending[0]
    const header = record && record.header
    if (!header || typeof header.id !== 'string') {
      plan.pending.shift()
      continue
    }
    // 前台快照可能已把该会话折进缓存（非 live），直接标记覆盖，避免重复读
    if (!plan.isLive(record)) {
      const cached = rt.tokenCache.get(header.id)
      if (cached && cached.createdAt === header.createdAt && isPlainObject(cached.fold)) {
        plan.pending.shift()
        plan.coveredIds.add(header.id)
        continue
      }
    }
    // FAILURE_TTL_MS 内的已知失败：不再 readSession，直接计 failed（否则 warm 永远跑不完）
    if (isKnownFailed(header.id)) {
      plan.pending.shift()
      plan.failedIds.add(header.id)
      continue
    }
    plan.pending.shift()
    plan.scanned += 1
    try {
      const session = await plan.sessionQuery.readSession(header.id)
      const fold = aggregateSessionEvents(session && session.events)
      rt.tokenCache.set(header.id, { createdAt: header.createdAt, fold })
      rt.cacheDirty = true
      plan.coveredIds.add(header.id)
      if (clearFailure !== null) clearFailure(header.id)
    } catch (error) {
      // 读取失败：从 pending 队列移除、计入 failed，不阻塞 warm 完成（partial 只看 pending）
      plan.failures += 1
      plan.failedIds.add(header.id)
      if (onFailure !== null) onFailure(record, error)
    }
  }
}

/** 片间让出事件循环：用 ctx.timeout 注册，dispose 时由 cancelWarm 取消。 */
function warmYield(rt) {
  const warm = rt.warm
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (warm.yieldFinish === finish) warm.yieldFinish = null
      resolve()
    }
    const dispose = rt.ctx.timeout(() => {
      warm.disposers.delete(dispose)
      finish()
    }, WARM_YIELD_MS)
    warm.disposers.add(dispose)
    warm.yieldFinish = finish
  })
}

/** 取消后台补齐（插件 dispose / HMR 卸载时调用），并让挂起的 yield 立即返回。 */
function cancelWarm(rt) {
  const warm = rt.warm
  if (!warm) return
  warm.cancelled = true
  warm.plan = null
  for (const dispose of warm.disposers) {
    try {
      dispose()
    } catch {
      /* 定时器可能已被宿主清理 */
    }
  }
  warm.disposers.clear()
  if (typeof warm.yieldFinish === 'function') warm.yieldFinish()
}

/** 从 tokenCache 里「只读聚合」当前已覆盖会话（纯求和不涉及 readSession）。 */
export function buildWarmStats(rt, plan) {
  const folds = []
  for (const sessionId of plan.coveredIds) {
    const entry = rt.tokenCache.get(sessionId)
    if (entry && isPlainObject(entry.fold)) folds.push({ id: sessionId, fold: entry.fold })
  }
  // 墓碑会话也要并入，否则 warm 期间「删除会话」的 token 会从数字里掉出去。
  const retiredFolds = Array.isArray(plan.retiredFolds)
    ? plan.retiredFolds.filter((item) => isPlainObject(item) && !plan.coveredIds.has(item.id))
    : []
  for (const item of retiredFolds) folds.push({ id: item.id, fold: item.fold })
  const aggregated = aggregateTokenStats(folds, { today: plan.todayKey, windowDays: WINDOW_DAYS })
  const stats = emptyTokenStats(Date.now())
  stats.today = plan.todayKey
  stats.weekStart = weekStartDate(dayKeyToLocalDate(plan.todayKey))
  stats.days = aggregated.days
  stats.providers = aggregated.providers
  stats.models = aggregated.models
  stats.hours = aggregated.hours
  stats.scan = summarizeTokenScan({
    sessions: plan.sessionsTotal,
    candidates: plan.candidateCount,
    scanned: plan.scanned,
    fromCache: plan.fromCache,
    covered: plan.coveredIds.size,
    failed: plan.failedIds ? plan.failedIds.size : 0,
    retired: retiredFolds.length,
    elapsedMs: Date.now() - plan.startedAt,
  })
  return stats
}

/** 把 tokens 扫描错误替换成当前失败数（不重复堆积）。 */
function mergeTokenScanError(errors, failures) {
  const base = (Array.isArray(errors) ? errors : []).filter(
    (item) => !(isPlainObject(item) && item.source === 'tokens' && item.code === 'internal'),
  )
  if (failures > 0) {
    base.push({
      source: 'tokens',
      code: 'internal',
      message: '有 ' + failures + ' 个 DSH 会话日志读取失败，token 统计可能不完整。',
    })
  }
  return base
}

/**
 * 后台每完成一批：就地更新内存 + 磁盘 lastSnapshot.tokens 的 scan 进度
 * （lastSnapshot 与 snapshotCache.value 通常是同一个对象，客户端 60s 轮询直接读到新进度）。
 */
function updateSnapshotTokens(rt, plan) {
  const snapshot = rt.state.lastSnapshot
  if (!isPlainObject(snapshot)) return
  const stats = buildWarmStats(rt, plan)
  snapshot.tokens = stats
  snapshot.errors = mergeTokenScanError(snapshot.errors, plan.failures)
  persistState(rt)
  const cachedValue = rt.snapshotCache && rt.snapshotCache.value
  if (isPlainObject(cachedValue) && cachedValue !== snapshot) {
    cachedValue.tokens = stats
    cachedValue.errors = snapshot.errors
  }
}

/**
 * 只有「本次真的又尝试读取并失败」的会话才生成 tokens 错误（已知失败跳过不报错，
 * 否则每次刷新都会常驻一个 error 条）；若失败集合里有旧格式会话，补一句可操作提示。
 */
function tokenScanErrorForFailures(failures, failedRecords) {
  if (!(failures > 0)) return null
  const hasMigrationRequired =
    Array.isArray(failedRecords) &&
    failedRecords.some((record) => record && record.formatStatus === 'migration-required')
  return tokenScanError(
    'tokens',
    'internal',
    '有 ' + failures + ' 个 DSH 会话日志读取失败，token 统计可能不完整。' +
      (hasMigrationRequired ? '（其中包含旧格式会话，需在 DSH 中打开一次完成迁移）' : ''),
  )
}

/**
 * 扫描本机 DSH 会话日志，聚合**全部供应商**的 token 使用量（按 provider / model 分类）。
 *
 * 性能策略（契约第 3 节「响应性」+「后台补齐」）：
 *  - 候选会话：窗口内 + createdAt >= 窗口起点 - CANDIDATE_LOOKBACK_DAYS(30 天)；
 *  - 聚合输入全部来自 tokenCache 里已折好的 per-session day/model 表（纯求和）；
 *    只有 live 会话或没有缓存的会话才在前台 readSession；
 *  - 前台预算 FOREGROUND_SCAN_MS / MAX_SCAN_SESSIONS，到点立即返回（partial=true），绝不 25s 阻塞；
 *  - 仍有 pending 时启动后台补齐（warm），每片 ≤1.5s 边补边刷新 scan 进度；
 *  - warm 进行中再次 snapshot/refresh：直接复用 warm 计划从缓存聚合（<200ms），不重复读取；
 *  - sessionQuery 不可用时返回全 0 的 30 天结构 + errors[source=tokens]。
 */
async function collectTokens(rt) {
  const startedAt = Date.now()
  const now = Date.now()
  const todayKey = localDayKey(now)

  const sessionQuery = rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('sessionQuery') : undefined
  if (
    !sessionQuery ||
    typeof sessionQuery.listSessions !== 'function' ||
    typeof sessionQuery.readSession !== 'function'
  ) {
    const stats = emptyTokenStats(now)
    stats.scan.elapsedMs = Date.now() - startedAt
    return {
      stats,
      error: tokenScanError(
        'tokens',
        'internal',
        '当前 DSH 版本未提供 sessionQuery 服务，无法统计本机 DSH 会话日志。',
      ),
    }
  }

  // 后台补齐进行中：直接复用它的候选/覆盖集合，从缓存聚合（不 listSessions、不 readSession），
  // 保证 warm 期间用户点刷新也是毫秒级返回，而且能看到 covered/pending 进度。
  if (rt.warm && rt.warm.running && rt.warm.plan) {
    return { stats: buildWarmStats(rt, rt.warm.plan), error: tokenScanErrorForFailures(rt.warm.plan.failures) }
  }

  let records
  try {
    records = await sessionQuery.listSessions()
  } catch (error) {
    const stats = emptyTokenStats(now)
    stats.scan.elapsedMs = Date.now() - startedAt
    return {
      stats,
      error: tokenScanError('tokens', 'internal', '枚举 DSH 会话失败：' + describeError(error)),
    }
  }
  if (!Array.isArray(records)) records = []

  // 当前仍存在的全部会话 id（含窗口外的）：账本只把「真的从 listSessions 消失」的会话记为墓碑，
  // 超出窗口但还存在的会话不算消失。
  const currentIds = new Set()
  for (const record of records) {
    const id = record && record.header && record.header.id
    if (typeof id === 'string' && id !== '') currentIds.add(id)
  }
  const windowKeys = new Set(tokenWindowDates(todayKey, WINDOW_DAYS))

  // 窗口起点（本地 00:00）再往前回看 CANDIDATE_LOOKBACK_DAYS（30 天）作为候选阈值：
  // 几十天前创建、仍在写入的长期会话（含归档后又继续使用的）也可能有窗口内用量。
  const windowStart = dayKeyToLocalDate(tokenWindowDates(todayKey, WINDOW_DAYS)[0])
  const candidateMinMs = shiftLocalDays(windowStart, -CANDIDATE_LOOKBACK_DAYS).getTime()
  const agentsService = typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined

  const isLive = (record) => {
    const header = record && record.header
    if (!header || typeof header.id !== 'string') return false
    try {
      if (agentsService && typeof agentsService.get === 'function' && agentsService.get(header.id)) return true
    } catch {
      /* agents 服务异常时退回 record.live */
    }
    return record.live === true
  }

  // 候选会话：窗口内 + createdAt >= windowStart - CANDIDATE_LOOKBACK_DAYS（已调成 30 天，
  // 覆盖「几十天前创建、仍在写入」的长期会话）。不再按 formatStatus 整类跳过：
  // 归档/旧格式会话大多能被 readSession 正常读取，真正读不了的交给失败记忆 + scan.failed。
  const candidates = records.filter(
    (record) =>
      record &&
      isPlainObject(record.header) &&
      typeof record.header.id === 'string' &&
      typeof record.header.createdAt === 'number' &&
      record.header.createdAt >= candidateMinMs,
  )

  // live 会话优先扫（必须保持最新），其余按创建时间从新到旧，预算用尽时保最新数据。
  candidates.sort((left, right) => {
    const leftLive = isLive(left) ? 0 : 1
    const rightLive = isLive(right) ? 0 : 1
    if (leftLive !== rightLive) return leftLive - rightLive
    return right.header.createdAt - left.header.createdAt
  })

  // 前台扫描：缓存优先 + 短预算增量（预算用尽后剩余候选进 pending，交给后台补齐）。
  // 读取失败（旧格式/损坏）写进 rt.scanFailures（TTL 6h），后续扫描不再重试、计入 scan.failed。
  const result = await runForegroundScan({
    candidates,
    isLive,
    budgetMs: FOREGROUND_SCAN_MS,
    maxSessions: MAX_SCAN_SESSIONS,
    getCachedFold: (sessionId) => rt.tokenCache.get(sessionId),
    readSession: (sessionId) => sessionQuery.readSession(sessionId),
    storeFold: (record, fold) => {
      rt.tokenCache.set(record.header.id, { createdAt: record.header.createdAt, fold })
      rt.cacheDirty = true
    },
    isKnownFailed: (sessionId) => isSessionFailed(rt, sessionId),
    onFailure: (record, error) => {
      noteScanFailure(rt, record, error)
    },
    clearFailure: (sessionId) => {
      if (rt.scanFailures.delete(sessionId)) rt.cacheDirty = true
    },
  })

  // 墓碑账本维护（必须在 tokenCache 修剪之前：消失会话的 fold 还可能在缓存里）：
  //   - covered 的会话写 known；曾退休但再次出现的会话删墓碑（不双计）；
  //   - known 里从 listSessions 消失的会话 → 移入 retired 并保留 fold（删除后 token 不缩水）；
  //   - 修剪窗口外 / 无窗口内日期的账本条目。
  const candidateCreatedAt = new Map()
  for (const record of candidates) candidateCreatedAt.set(record.header.id, record.header.createdAt)
  const coveredEntries = result.coveredIds.map((sessionId) => ({
    id: sessionId,
    createdAt: candidateCreatedAt.has(sessionId)
      ? candidateCreatedAt.get(sessionId)
      : rt.tokenCache.get(sessionId)?.createdAt,
  }))
  const reconciled = reconcileLedger({
    known: rt.ledger.known,
    retired: rt.ledger.retired,
    tokenCache: rt.tokenCache,
    currentIds,
    covered: coveredEntries,
    candidateMinMs,
    windowKeys,
  })
  if (reconciled.changed) rt.ledgerDirty = true
  persistLedger(rt)
  // retired 的 fold 全部并入本次聚合（aggregateTokenStats 仍按窗口过滤）；防御性排除已覆盖 id。
  const coveredSet = new Set(result.coveredIds)
  const retiredFolds = reconciled.retiredFolds.filter((item) => !coveredSet.has(item.id))

  // 修剪缓存：候选窗口之外的会话以后不会再进入候选，直接丢弃，避免缓存无限增长。
  for (const [sessionId, entry] of rt.tokenCache) {
    if (!entry || typeof entry.createdAt !== 'number' || entry.createdAt < candidateMinMs) {
      rt.tokenCache.delete(sessionId)
      rt.cacheDirty = true
    }
  }
  persistTokenCache(rt)

  // 聚合 = 本次 covered 的 fold + 墓碑 retired 的 fold（删除会话的 token 继续计入）。
  const aggregated = aggregateTokenStats(result.folds.concat(retiredFolds), {
    today: todayKey,
    windowDays: WINDOW_DAYS,
  })
  const stats = emptyTokenStats(now)
  stats.days = aggregated.days
  stats.providers = aggregated.providers
  stats.models = aggregated.models
  stats.hours = aggregated.hours
  stats.scan = summarizeTokenScan({
    sessions: records.length,
    candidates: result.candidates,
    scanned: result.scanned,
    fromCache: result.fromCache,
    covered: result.covered,
    failed: result.failed,
    retired: retiredFolds.length,
    elapsedMs: Date.now() - startedAt,
  })

  // 前台预算用尽且仍有 pending：启动后台补齐；已有 warm 在跑时只替换计划，不并发。
  if (result.pendingCount > 0) {
    scheduleWarm(rt, {
      sessionQuery,
      isLive,
      todayKey,
      sessionsTotal: records.length,
      candidateCount: result.candidates,
      coveredIds: new Set(result.coveredIds),
      failedIds: new Set(result.failedIds),
      retiredFolds,
      pending: result.pending.slice(),
      fromCache: result.fromCache,
      scanned: result.scanned,
      failures: result.failures,
      isKnownFailed: (sessionId) => isSessionFailed(rt, sessionId),
      onFailure: (record, error) => {
        noteScanFailure(rt, record, error)
      },
      clearFailure: (sessionId) => {
        if (rt.scanFailures.delete(sessionId)) rt.cacheDirty = true
      },
      startedAt,
      deadlineAt: Date.now() + MAX_WARM_MS,
    })
  }

  return { stats, error: tokenScanErrorForFailures(result.failures, result.failedRecords) }
}

/* ------------------------------------------------------------------ *
 * 快照采集 / 端点实现
 * ------------------------------------------------------------------ */

function mergeErrorList(baseErrors, extraErrors) {
  const merged = []
  const seen = new Set()
  for (const item of [...(Array.isArray(baseErrors) ? baseErrors : []), ...(Array.isArray(extraErrors) ? extraErrors : [])]) {
    if (!isPlainObject(item) || typeof item.source !== 'string' || typeof item.code !== 'string') continue
    const errorKey = item.source + '|' + item.code + '|' + (item.message || '')
    if (seen.has(errorKey)) continue
    seen.add(errorKey)
    merged.push({ source: item.source, code: item.code, message: typeof item.message === 'string' ? item.message : '' })
  }
  return merged
}

/** 有缓存就返回 lastSnapshot（cached:true）+ 本次降级原因，没有就返回 null。 */
function cachedFallback(rt, errorEntries) {
  const value = rt.snapshotCache ? rt.snapshotCache.value : rt.state.lastSnapshot
  if (!isPlainObject(value)) return null
  return {
    ...value,
    cached: true,
    errors: mergeErrorList(value.errors, errorEntries),
  }
}

function freshSnapshot(rt, now) {
  if (rt.snapshotCache && now - rt.snapshotCache.fetchedAt < CACHE_TTL_MS) return rt.snapshotCache.value
  return null
}

function rateLimitEntry(rt, now) {
  const remainingMs = Math.max(0, rt.rateLimitedUntil - now)
  return {
    source: 'balance',
    code: 'rate-limit',
    message: 'Ollama 官方接口限流中，请等待约 ' + Math.ceil(remainingMs / 1000) + ' 秒后重试。',
  }
}

async function runCollect(rt, options = {}) {
  const allowCachedFallback = options.allowCachedFallback !== false

  let keyInfo
  try {
    keyInfo = await resolveApiKey(runtimeKeySources(rt))
  } catch {
    keyInfo = { key: null, source: 'none', sources: {} }
  }

  if (keyInfo.key === null) {
    const noKeyEntry = { source: 'key', code: 'no-key', message: NO_KEY_MESSAGE }
    if (allowCachedFallback) {
      const fallback = cachedFallback(rt, [noKeyEntry])
      if (fallback) return { ok: true, value: fallback }
    }
    return fail(allowCachedFallback ? 'no-data' : 'no-key', NO_KEY_MESSAGE, { sources: keyInfo.sources || {} })
  }

  try {
    // 官方数据（网络）与本机日志扫描（磁盘）并行；两者独立降级。
    const [official, tokens] = await Promise.all([
      collectOfficial(rt, keyInfo.key),
      collectTokens(rt),
    ])
    const errors = [...official.errors]
    if (tokens.error) errors.push(tokens.error)
    // 记下「上一次采集完成时间」：refresh 的 15s 最小间隔保护用它（含失败/降级采集，
    // 避免用户连点刷新时反复打官方接口）。
    rt.lastCollectAt = Date.now()

    // 网络整体不可用且磁盘上有上次快照：按契约返回旧数据（cached:true）+ errors。
    if (official.allNetworkFailed) {
      const fallback = cachedFallback(rt, errors)
      if (fallback) return { ok: true, value: fallback }
    }

    const value = buildSnapshot({
      now: Date.now(),
      key: { source: keyInfo.source, masked: maskKey(keyInfo.key) },
      limits: official.limits,
      official: official.official,
      tokens: tokens.stats,
      errors,
      cached: false,
    })

    rt.snapshotCache = { value, fetchedAt: Date.now() }
    rt.state.lastSnapshot = value
    rt.state.lastSnapshotAt = value.updatedAt
    persistState(rt)
    return { ok: true, value }
  } catch (error) {
    // 预期之外的异常：有旧快照就降级返回，否则 internal。
    // 注意 protocol 的 errors[].source 只允许 balance|usage24h|usage7d|usage30d|tokens|key，
    // 整体采集异常无法细分来源，统一归到 balance 通道，code 用 internal 表达真实语义。
    rt.lastCollectAt = Date.now()
    const entry = {
      source: 'balance',
      code: 'internal',
      message: '采集 Ollama 统计失败：' + describeError(error),
    }
    const fallback = cachedFallback(rt, [entry])
    if (fallback) return { ok: true, value: fallback }
    return fail('internal', entry.message, {})
  }
}

async function resolveSnapshot(rt, force) {
  const now = Date.now()
  if (!force) {
    const cached = freshSnapshot(rt, now)
    if (cached) return { ok: true, value: { ...cached, cached: true } }
  }
  if (rt.rateLimitedUntil > now) {
    const fallback = cachedFallback(rt, [rateLimitEntry(rt, now)])
    if (fallback) return { ok: true, value: fallback }
    const remainingMs = Math.max(0, rt.rateLimitedUntil - now)
    return fail('rate-limit', 'Ollama 官方接口限流中，请等待约 ' + Math.ceil(remainingMs / 1000) + ' 秒后重试。', {
      retryAfterMs: remainingMs,
    })
  }
  if (rt.inflight) return rt.inflight
  const promise = runCollect(rt, { allowCachedFallback: !force }).finally(() => {
    if (rt.inflight === promise) rt.inflight = null
  })
  rt.inflight = promise
  return promise
}

/** snapshot：优先 60s 缓存；无缓存时同步采集（首次可能 1-3s）。 */
async function handleSnapshot(rt, payload = {}) {
  if (isPlainObject(payload) && payload.force === true) return handleRefresh(rt)
  return resolveSnapshot(rt, false)
}

/**
 * refresh 的 15s 最小间隔判定（纯函数，便于单测）。
 * 「距上次采集 < 15s」→ true；从未采集过（lastCollectAt<=0）→ false。
 */
export function shouldThrottleRefresh(now, lastCollectAt, minIntervalMs = REFRESH_MIN_INTERVAL_MS) {
  const last = readFiniteNumber(lastCollectAt)
  const current = readFiniteNumber(now)
  if (last === null || last <= 0 || current === null) return false
  const diff = current - last
  return diff >= 0 && diff < Math.max(0, minIntervalMs)
}

/**
 * refresh：显式强制重取（cached=false）；但契约的 15s 限流保护优先：
 * 距上次采集 < REFRESH_MIN_INTERVAL_MS 时直接返回 lastSnapshot（cached:true），
 * 并附 [{source:'balance',code:'rate-limit'}] 说明，避免连点刷新撞官方 10 请求/分钟。
 * 首次 refresh / 正常间隔 refresh 不受影响；没有缓存时仍会走正常采集。
 * 导出供单测（间隔内不得进入采集路径）。
 */
export async function handleRefresh(rt) {
  const now = Date.now()
  if (rt && shouldThrottleRefresh(now, rt.lastCollectAt)) {
    const fallback = cachedFallback(rt, [
      {
        source: 'balance',
        code: 'rate-limit',
        message: '刷新过于频繁，已返回缓存（15s 最小间隔）',
      },
    ])
    if (fallback) return { ok: true, value: fallback }
  }
  return resolveSnapshot(rt, true)
}

/** auth-state：只解析 key，不发网络请求。 */
async function handleAuthState(rt) {
  let keyInfo
  try {
    keyInfo = await resolveApiKey(runtimeKeySources(rt))
  } catch {
    keyInfo = { key: null, source: 'none', sources: {} }
  }
  const masked = maskKey(keyInfo.key)
  const value = {
    hasKey: keyInfo.key !== null,
    // 协议 v1 的规范形状（value.key / value.sources）；顶层 source/masked 是兼容旧探针的冗余字段。
    key: { source: keyInfo.source, masked },
    sources: {
      credentials: keyInfo.sources.credentials === true,
      env: keyInfo.sources.env === true,
      localCli: keyInfo.sources.localCli === true,
      manual: keyInfo.sources.manual === true,
    },
    source: keyInfo.source,
    masked,
  }
  return { ok: true, value }
}

/** set-key：先用 /api/balance 校验，成功才持久化手动 key。 */
async function handleSetKey(rt, payload) {
  const token = isPlainObject(payload) && typeof payload.token === 'string' ? payload.token.trim() : ''
  if (token === '') {
    return fail('bad-request', '缺少 token：payload.token 必须是非空字符串。', { field: 'token' })
  }
  const balance = await requestJson(BALANCE_URL, token)
  if (!balance.ok) {
    return fail(balance.code, balance.message, {
      status: balance.status === undefined ? null : balance.status,
      retryAfterMs: balance.retryAfterMs === undefined ? null : balance.retryAfterMs,
    })
  }
  rt.state.manualKey = token
  persistState(rt)
  // 手动 key 可能成为生效来源（当其他三个来源都没有时），清掉缓存让下次 snapshot 重采。
  rt.snapshotCache = null
  rt.rateLimitedUntil = 0
  // 协议 v1（Lead 更新后）要求 value = { valid:true, key:{source:'manual',masked} }；
  // 同时保留旧的扁平 source/masked 字段，兼容按初版协议写的浏览器端，多出的字段无害。
  const masked = maskKey(token)
  return { ok: true, value: { valid: true, key: { source: 'manual', masked }, source: 'manual', masked } }
}

/** clear-key：只删除插件自己的手动 key，不动 DSH 凭证库。 */
async function handleClearKey(rt) {
  rt.state.manualKey = null
  persistState(rt)
  rt.snapshotCache = null
  let keyInfo
  try {
    keyInfo = await resolveApiKey(runtimeKeySources(rt))
  } catch {
    keyInfo = { key: null, source: 'none', sources: {} }
  }
  return {
    ok: true,
    value: {
      cleared: true,
      key: { source: keyInfo.source, masked: maskKey(keyInfo.key) },
    },
  }
}

/* ------------------------------------------------------------------ *
 * RPC 信封（沿用 0.2.x 已实测协议，勿改）
 * ------------------------------------------------------------------ */

/**
 * Canonical Connection RPC failure result：
 * error.details 必须是对象——浏览器端 parseConnectionResponse 对缺失 details 的失败
 * 会直接 reject（TypeError: connection: invalid server-response failure）。
 */
export function fail(code, message, details) {
  return {
    ok: false,
    error: {
      code: String(code),
      message: String(message),
      details: isPlainObject(details) ? details : {},
    },
  }
}

export function buildServerResponse(rpcId, result) {
  return { type: 'server-response', rpcId: rpcId, result: result }
}

export function buildBadRequestResponse(rpcId, issues) {
  return buildServerResponse(
    typeof rpcId === 'string' && rpcId !== '' ? rpcId : 'invalid-request',
    fail('bad-request', 'invalid client-request message', { issues: Array.isArray(issues) ? issues : [] }),
  )
}

/**
 * 校验 client-request 信封。返回 { ok, rpcId, method, payload } 或 { ok:false, rpcId, issues }。
 * payload 允许缺省（当 {}）；非对象 payload 也宽容成 {}，避免浏览器端小改动直接 500。
 */
export function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    return { ok: false, rpcId: null, issues: ['envelope must be a JSON object'] }
  }
  const issues = []
  if (envelope.type !== 'client-request') issues.push('type must be "client-request"')
  if (typeof envelope.rpcId !== 'string') issues.push('rpcId must be a string')
  if (typeof envelope.method !== 'string' || envelope.method === '') {
    issues.push('method must be a non-empty string')
  }
  const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : null
  if (issues.length > 0) return { ok: false, rpcId, issues }
  return {
    ok: true,
    rpcId: envelope.rpcId,
    method: envelope.method,
    payload: isPlainObject(envelope.payload) ? envelope.payload : {},
  }
}

export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    parts[0] === '127'
  )
}

export function isLoopbackHost(rawHost) {
  let host = typeof rawHost === 'string' ? rawHost.trim() : ''
  if (host === '') return false
  if (host.startsWith('[')) {
    const closing = host.indexOf(']')
    if (closing === -1) return false
    host = host.slice(0, closing + 1)
  } else {
    const colon = host.indexOf(':')
    if (colon !== -1) host = host.slice(0, colon)
  }
  return isLoopbackHostname(host)
}

/** '/ollama-statistical/snapshot' → 'snapshot'；空段 / . / .. 一律视为非法。 */
export function endpointFromPath(channel, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(channel + '/')) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.length === 0) return undefined
  if (endpoint.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return undefined
  }
  return endpoint
}

/**
 * 信封 + 路由核心（与 HTTP 解耦，便于单测覆盖 404/415/403/bad-request 分支）。
 * 输入 { method, contentType, host, url, body }；输出 { status, json? , text? }。
 * dispatchFn(endpoint, payload) 由调用方注入，返回 RpcResult。
 */
export async function handleBridgeCore(input, dispatchFn) {
  const method = typeof input.method === 'string' ? input.method : ''
  if (method !== 'POST') return { status: 404, text: 'not found' }

  const contentType = (typeof input.contentType === 'string' ? input.contentType : '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    return { status: 415, text: 'content type must be application/json' }
  }
  if (typeof input.host !== 'string' || !isLoopbackHost(input.host)) {
    return { status: 403, text: 'forbidden' }
  }

  const raw = typeof input.body === 'string' ? input.body : ''
  let envelope
  try {
    envelope = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    return { status: 400, text: 'body is not JSON' }
  }

  const validated = validateEnvelope(envelope)
  if (!validated.ok) {
    return { status: 200, json: buildBadRequestResponse(validated.rpcId, validated.issues) }
  }

  let pathname = '/'
  try {
    pathname = new URL(typeof input.url === 'string' && input.url !== '' ? input.url : '/', 'http://dsh.internal')
      .pathname
  } catch {
    return { status: 200, json: buildBadRequestResponse(validated.rpcId, ['invalid request url']) }
  }
  const endpoint = endpointFromPath(RPC_CHANNEL, pathname)
  if (endpoint === undefined || endpoint !== validated.method) {
    return {
      status: 200,
      json: buildBadRequestResponse(validated.rpcId, ['url endpoint does not match envelope method']),
    }
  }

  const result = await dispatchFn(endpoint, validated.payload)
  return { status: 200, json: buildServerResponse(validated.rpcId, result) }
}

/** 端点分派：未知 endpoint → 200 + bad-request（契约）。 */
export async function dispatch(rt, endpoint, payload = {}) {
  try {
    switch (endpoint) {
      case 'snapshot':
        return await handleSnapshot(rt, payload)
      case 'refresh':
        return await handleRefresh(rt)
      case 'auth-state':
        return await handleAuthState(rt)
      case 'set-key':
        return await handleSetKey(rt, payload)
      case 'clear-key':
        return await handleClearKey(rt)
      default:
        return fail('bad-request', 'unknown endpoint: ' + String(endpoint), { endpoint: String(endpoint) })
    }
  } catch (error) {
    return fail('internal', '插件内部错误：' + describeError(error), {})
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 桥（镜像 Connection RPC 信封协议）
 * ------------------------------------------------------------------ */

/** 读请求体并按上限拒绝（导出供单测覆盖 413 超长 body 分支）。 */
export function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const abort = (error) => {
      if (done) return
      done = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (done) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      size += buffer.length
      if (size > limit) {
        abort(Object.assign(new Error('request body too large'), { code: 'LIMIT' }))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => abort(error))
  })
}

function sendPlain(res, status, text) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(text)
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function handleHttpRequest(rt, req, res) {
  const outcome = await handleBridgeRequest(rt, req)
  if (outcome.json !== undefined) {
    sendJson(res, outcome.status, outcome.json)
  } else {
    sendPlain(res, outcome.status, outcome.text || '')
  }
}

async function handleBridgeRequest(rt, req) {
  const method = typeof req.method === 'string' ? req.method : ''
  const contentType = typeof req.headers === 'object' && req.headers !== null ? req.headers['content-type'] : ''
  const host = typeof req.headers === 'object' && req.headers !== null ? req.headers.host : ''

  // 先做轻量拒绝，避免为明显非法请求读 body。
  if (method !== 'POST') return { status: 404, text: 'not found' }
  const baseType = (typeof contentType === 'string' ? contentType : '').split(';', 1)[0].trim().toLowerCase()
  if (baseType !== 'application/json') return { status: 415, text: 'content type must be application/json' }
  if (typeof host !== 'string' || !isLoopbackHost(host)) return { status: 403, text: 'forbidden' }

  let body
  try {
    body = await readRequestBody(req, MAX_BODY_BYTES)
  } catch (error) {
    if (error && error.code === 'LIMIT') return { status: 413, text: 'request body too large' }
    return { status: 400, text: 'body is not JSON' }
  }

  return handleBridgeCore(
    { method, contentType, host, url: typeof req.url === 'string' ? req.url : '/', body },
    (endpoint, payload) => dispatch(rt, endpoint, payload),
  )
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const rt = createRuntime(ctx)
  try {
    loadPersisted(rt)
  } catch (error) {
    console.warn('[ollama-statistical] 读取本地状态失败：' + describeError(error))
  }

  // 1) RPC 路由：webServer 已由 inject 保证就绪。
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: RPC_CHANNEL,
          handler: (req, res) => {
            handleHttpRequest(rt, req, res).catch((error) => {
              console.error('[ollama-statistical] 处理 RPC 请求失败：' + describeError(error))
              try {
                sendPlain(res, 500, 'internal error')
              } catch {
                /* 响应可能已写出 */
              }
            })
          },
        }),
      'ollama-statistical: rpc bridge',
    )
    console.log('[ollama-statistical] RPC 路由已注册：' + RPC_CHANNEL)
  } catch (error) {
    console.error('[ollama-statistical] RPC 路由注册失败：' + describeError(error))
  }

  // 2) 后台保活：每 5 分钟刷新一次快照（有 60s 缓存，不会打爆官方限流），
  //    这样 lastSnapshot 持久化后，下次打开 DSH 首次 snapshot 能立刻命中磁盘缓存。
  try {
    ctx.effect(
      () =>
        ctx.interval(() => {
          resolveSnapshot(rt, false).catch(() => {
            /* 后台失败静默，等下一轮或用户手动刷新 */
          })
        }, AUTO_SNAPSHOT_MS),
      'ollama-statistical: auto snapshot',
    )
  } catch (error) {
    console.error('[ollama-statistical] 自动刷新定时器不可用：' + describeError(error))
  }

  // 3) 启动预热：延迟 8s，且只在本机既无内存快照也无磁盘快照时触发，避免拖慢 DSH 启动。
  try {
    ctx.effect(
      () =>
        ctx.timeout(() => {
          if (!rt.snapshotCache && !isPlainObject(rt.state.lastSnapshot)) {
            resolveSnapshot(rt, false).catch(() => {
              /* 预热失败无所谓，首次打开面板会再采一次 */
            })
          }
        }, WARMUP_DELAY_MS),
      'ollama-statistical: warmup',
    )
  } catch (error) {
    console.error('[ollama-statistical] 预热定时器不可用：' + describeError(error))
  }

  // 4) dispose / HMR 卸载：取消后台补齐和片间定时器，避免旧实例继续读会话日志。
  try {
    ctx.effect(
      () => () => {
        cancelWarm(rt)
      },
      'ollama-statistical: warm cleanup',
    )
  } catch (error) {
    console.error('[ollama-statistical] warm 清理钩子注册失败：' + describeError(error))
  }
}
