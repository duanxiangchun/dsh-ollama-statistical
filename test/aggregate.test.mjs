/**
 * 官方用量解析 + 本机 token 聚合 + snapshot 组装的纯函数单测。
 * 所有日期都用本地 Date 构造，避免测试结果依赖运行机时区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateOfficialUsage,
  aggregateSessionEvents,
  aggregateTokenStats,
  buildSnapshot,
  emptyLimits,
  emptyTokenStats,
  fillTokenDays,
} from '../lib/index.js'

const at = (year, monthIndex, day, hour = 12) => new Date(year, monthIndex, day, hour).getTime()

/* --------------------------- aggregateOfficialUsage --------------------------- */

const USAGE_24H = {
  range: '24h',
  scope: 'self',
  granularity: 'hour',
  from: '2026-10-22T08:00:00Z',
  until: '2026-10-23T08:08:49.099929399Z',
  totals: { request_count: 254 },
  buckets: [
    { from: '2026-10-22T08:00:00Z', until: '2026-10-22T09:00:00Z', request_count: 169 },
    { from: '2026-10-23T07:00:00Z', until: '2026-10-23T08:00:00Z', request_count: 0 },
    {
      from: '2026-10-23T08:00:00Z',
      until: '2026-10-23T08:08:49.099929399Z',
      partial: true,
      request_count: 85,
    },
  ],
}

test('aggregateOfficialUsage: legacy 套餐只有 request_count，tokens 为 null，纳秒 until 原样透传', () => {
  const result = aggregateOfficialUsage(USAGE_24H, '24h')
  assert.equal(result.range, '24h')
  assert.equal(result.granularity, 'hour')
  assert.equal(result.from, '2026-10-22T08:00:00Z')
  assert.equal(result.until, '2026-10-23T08:08:49.099929399Z')
  assert.equal(result.requestCount, 254)
  assert.equal(result.tokens, null)
  assert.equal(result.buckets.length, 3)
  assert.equal(result.buckets[0].requestCount, 169)
  assert.equal(result.buckets[0].partial, false)
  assert.equal(result.buckets[0].tokens, null)
  assert.equal(result.buckets[2].partial, true)
  assert.equal(result.buckets[2].requestCount, 85)
})

test('aggregateOfficialUsage: 新套餐出现 token 字段时如实透传', () => {
  const usage = {
    range: '7d',
    granularity: 'day',
    from: '2026-10-16T00:00:00Z',
    until: '2026-10-23T08:00:00Z',
    totals: {
      request_count: 10,
      input_tokens: 1000,
      cached_input_tokens: 200,
      output_tokens: 300,
      usage_usd: 0.25,
    },
    buckets: [
      {
        from: '2026-10-16T00:00:00Z',
        until: '2026-10-17T00:00:00Z',
        request_count: 10,
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 300,
        usage_usd: 0.25,
      },
    ],
  }
  const result = aggregateOfficialUsage(usage, '7d')
  assert.deepEqual(result.tokens, { input: 1000, cachedInput: 200, output: 300, usd: 0.25 })
  assert.deepEqual(result.buckets[0].tokens, { input: 1000, cachedInput: 200, output: 300, usd: 0.25 })
  assert.equal(result.granularity, 'day')
})

test('aggregateOfficialUsage: totals 缺 request_count 时回退为 buckets 求和', () => {
  const result = aggregateOfficialUsage(
    {
      range: '30d',
      granularity: 'day',
      totals: {},
      buckets: [{ request_count: 2 }, { request_count: 3 }, {}],
    },
    '30d',
  )
  assert.equal(result.requestCount, 5)
})

test('aggregateOfficialUsage: 异常响应体抛错', () => {
  assert.throws(() => aggregateOfficialUsage('nope', '24h'), /不是合法 JSON/)
  assert.throws(() => aggregateOfficialUsage([], '24h'), /格式异常/)
})

/* --------------------------- aggregateSessionEvents -------------------------- */

const OLLAMA_SOURCE = { kind: 'model', provider: 'ollama', model: 'deepseek-v4.1-flash:1017' }
const WB_SOURCE = { kind: 'model', provider: 'wb', model: 'deepseek-v4.1-flash' }

function assistantEvent(time, usage, source) {
  return { type: 'assistant/message', seq: 1, time, data: { usage, message: { source } } }
}

test('aggregateSessionEvents: 全部供应商统计、按 provider/model 折叠、totalTokens 回退', () => {
  const events = [
    // 1) ollama：无 totalTokens → total = input + output = 120；cacheRead 只展示不重复加
    assistantEvent(
      at(2026, 9, 23, 10),
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      OLLAMA_SOURCE,
    ),
    // 2) ollama：有 totalTokens → 直接用 999
    assistantEvent(at(2026, 9, 23, 11), { inputTokens: 10, outputTokens: 5, totalTokens: 999 }, OLLAMA_SOURCE),
    // 3) 别的供应商也计入（不再按 provider 过滤）
    assistantEvent(at(2026, 9, 23, 12), { inputTokens: 7, outputTokens: 7 }, WB_SOURCE),
    // 4) source 缺失 → provider/model 都归 "(未知)"
    assistantEvent(at(2026, 9, 23, 13), { inputTokens: 1, outputTokens: 1 }),
    // 5) 没有 usage：忽略
    { type: 'assistant/message', seq: 5, time: at(2026, 9, 23, 14), data: { message: { source: OLLAMA_SOURCE } } },
    // 6) 非 assistant/message：忽略
    { type: 'tool/result', seq: 6, time: at(2026, 9, 23, 15), data: {} },
  ]

  const fold = aggregateSessionEvents(events)
  assert.equal(fold.requests, 4)

  const day = fold.perDay['2026-10-23']
  assert.equal(day.input, 118)
  assert.equal(day.output, 33)
  assert.equal(day.cacheRead, 50)
  assert.equal(day.requests, 4)
  assert.equal(day.total, 120 + 999 + 14 + 2, 'cacheRead 不应重复加进 total')

  // 按供应商折叠
  const providers = fold.perDayProvider['2026-10-23']
  assert.deepEqual(Object.keys(providers).sort(), ['(未知)', 'ollama', 'wb'])
  assert.equal(providers.ollama.total, 1119)
  assert.equal(providers.ollama.requests, 2)
  assert.equal(providers.wb.total, 14)
  assert.equal(providers['(未知)'].total, 2)

  // 按模型折叠（全供应商合并）
  const dayModels = fold.perDayModel['2026-10-23']
  assert.deepEqual(Object.keys(dayModels).sort(), ['(未知)', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash:1017'])
  assert.equal(dayModels['deepseek-v4.1-flash:1017'].total, 1119)
  assert.equal(dayModels['deepseek-v4.1-flash'].total, 14)
  assert.equal(dayModels['(未知)'].total, 2)

  // 按 provider → model 折叠
  const providerModels = fold.perDayProviderModel['2026-10-23']
  assert.equal(providerModels.ollama['deepseek-v4.1-flash:1017'].total, 1119)
  assert.equal(providerModels.wb['deepseek-v4.1-flash'].total, 14)
  assert.equal(providerModels['(未知)']['(未知)'].total, 2)
})

test('aggregateSessionEvents: 非法输入不抛错（v3 折叠形状）', () => {
  const empty = {
    requests: 0,
    perDay: {},
    perDayProvider: {},
    perDayModel: {},
    perDayProviderModel: {},
  }
  assert.deepEqual(aggregateSessionEvents(null), empty)
  assert.deepEqual(aggregateSessionEvents([]), empty)
  assert.deepEqual(aggregateSessionEvents([null, 1, 'x']).requests, 0)
})

test('aggregateSessionEvents: provider/model 空白归到 (未知)，负数 token 归 0', () => {
  const events = [
    assistantEvent(
      at(2026, 9, 23, 10),
      { inputTokens: -5, outputTokens: 3, totalTokens: -1 },
      { kind: 'model', provider: '   ', model: '' },
    ),
  ]
  const fold = aggregateSessionEvents(events)
  const providers = fold.perDayProvider['2026-10-23']
  assert.deepEqual(Object.keys(providers), ['(未知)'])
  assert.equal(providers['(未知)'].input, 0)
  assert.equal(providers['(未知)'].output, 3)
  assert.equal(providers['(未知)'].total, 3)
  const providerModels = fold.perDayProviderModel['2026-10-23']
  assert.deepEqual(Object.keys(providerModels['(未知)']), ['(未知)'])
  assert.equal(providerModels['(未知)']['(未知)'].total, 3)
})

/* ------------------------------- fillTokenDays ------------------------------ */

const EMPTY_BUCKET = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  requests: 0,
}

test('fillTokenDays: 稀疏日桶补成 30 条升序、空天补 0', () => {
  const days = fillTokenDays(
    { '2026-10-23': { ...EMPTY_BUCKET, input: 10, output: 5, total: 15, requests: 2, sessions: 1 } },
    '2026-10-23',
    30,
  )
  assert.equal(days.length, 30)
  assert.equal(days[0].date, '2026-09-24')
  assert.equal(days[29].date, '2026-10-23')
  assert.equal(days[29].total, 15)
  assert.equal(days[29].requests, 2)
  assert.equal(days[29].sessions, 1)
  // 其余天全 0
  assert.equal(days[0].total, 0)
  assert.equal(days[0].input, 0)
  for (let index = 1; index < days.length - 1; index += 1) {
    assert.equal(days[index].total, 0)
  }
  // 升序
  const sorted = days.map((day) => day.date).slice().sort()
  assert.deepEqual(days.map((day) => day.date), sorted)
})

test('fillTokenDays: 传入 Map 也可以', () => {
  const map = new Map([['2026-10-22', { ...EMPTY_BUCKET, total: 7, requests: 1 }]])
  const days = fillTokenDays(map, '2026-10-23', 30)
  const day = days.find((item) => item.date === '2026-10-22')
  assert.equal(day.total, 7)
})

/* ----------------------------- aggregateTokenStats ---------------------------- */

const B = (total, requests = 1) => ({ ...EMPTY_BUCKET, total, requests })

/** 两个会话：s1 同时用 ollama+wb（另有窗口外日期），s2 只用 wb。 */
function multiProviderSessions() {
  return [
    {
      id: 's1',
      fold: {
        requests: 9,
        perDay: {
          '2026-10-23': { ...EMPTY_BUCKET, input: 110, output: 30, total: 140, requests: 4 },
          '2026-10-22': { ...EMPTY_BUCKET, total: 7, requests: 1 },
          '2026-09-01': { ...EMPTY_BUCKET, total: 700, requests: 5 }, // 窗口外
        },
        perDayProvider: {
          '2026-10-23': { ollama: B(100, 3), wb: B(40, 1) },
          '2026-10-22': { ollama: B(7, 1) },
          '2026-09-01': { ollama: B(700, 5) }, // 窗口外
        },
        perDayModel: {},
        perDayProviderModel: {
          '2026-10-23': { ollama: { m1: B(60, 2), m2: B(40, 1) }, wb: { wm: B(40, 1) } },
          '2026-10-22': { ollama: { m1: B(7, 1) } },
          '2026-09-01': { ollama: { m1: B(700, 5) } }, // 窗口外
        },
      },
    },
    {
      id: 's2',
      fold: {
        requests: 1,
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 5, requests: 1 } },
        perDayProvider: { '2026-10-23': { wb: B(5, 1) } },
        perDayModel: {},
        perDayProviderModel: { '2026-10-23': { wb: { wm2: B(5, 1) } } },
      },
    },
  ]
}

test('aggregateTokenStats: 全部供应商合计 + 按供应商分组 + 会话去重计数', () => {
  const { days, providers } = aggregateTokenStats(multiProviderSessions(), {
    today: '2026-10-23',
    windowDays: 30,
  })
  assert.equal(days.length, 30)
  assert.equal(days[0].date, '2026-09-24')
  assert.equal(days[29].date, '2026-10-23')

  const today = days[29]
  assert.equal(today.total, 145)
  assert.equal(today.requests, 5)
  assert.equal(today.sessions, 2, '两个会话当天都有调用（任意供应商）')
  assert.equal(days[28].total, 7)
  assert.equal(days[28].sessions, 1)
  assert.equal(days.find((day) => day.date === '2026-09-01'), undefined, '窗口外忽略')

  // 供应商按 total 降序
  assert.deepEqual(
    providers.map((item) => item.provider),
    ['ollama', 'wb'],
  )
  const ollama = providers[0]
  assert.equal(ollama.total, 107, '窗口外的 700 不能进供应商合计')
  assert.equal(ollama.requests, 4)
  assert.equal(ollama.sessions, 1, '只有 s1 用过 ollama')
  assert.deepEqual(
    ollama.models.map((item) => [item.model, item.total]),
    [
      ['m1', 67],
      ['m2', 40],
    ],
  )

  const wb = providers[1]
  assert.equal(wb.total, 45)
  assert.equal(wb.requests, 2)
  assert.equal(wb.sessions, 2, 's1 与 s2 都用过 wb')
  assert.deepEqual(
    wb.models.map((item) => [item.model, item.total]),
    [
      ['wm', 40],
      ['wm2', 5],
    ],
  )
})

test('aggregateTokenStats: providers[].days 与 tokens.days 同长同序、且合计等于 provider.total', () => {
  const { days, providers } = aggregateTokenStats(multiProviderSessions(), {
    today: '2026-10-23',
    windowDays: 30,
  })
  for (const provider of providers) {
    assert.equal(provider.days.length, days.length)
    assert.deepEqual(
      provider.days.map((day) => day.date),
      days.map((day) => day.date),
    )
    const sum = provider.days.reduce((total, day) => total + day.total, 0)
    assert.equal(sum, provider.total)
    assert.ok(provider.days.every((day) => typeof day.requests === 'number' && day.requests >= 0))
    assert.deepEqual(Object.keys(provider.days[0]).sort(), ['date', 'requests', 'total'])
  }
  const ollamaToday = providers[0].days.find((day) => day.date === '2026-10-23')
  assert.equal(ollamaToday.total, 100)
  assert.equal(ollamaToday.requests, 3)
  assert.equal(providers[1].days.find((day) => day.date === '2026-10-23').total, 45)
})

test('aggregateTokenStats: 全局模型榜带 provider，且与 days 同口径', () => {
  const { days, models } = aggregateTokenStats(multiProviderSessions(), {
    today: '2026-10-23',
    windowDays: 30,
  })
  assert.deepEqual(
    models.map((item) => [item.provider, item.model, item.total]),
    [
      ['ollama', 'm1', 67],
      ['ollama', 'm2', 40],
      ['wb', 'wm', 40],
      ['wb', 'wm2', 5],
    ],
  )
  const sumDays = days.reduce((total, day) => total + day.total, 0)
  const sumModels = models.reduce((total, model) => total + model.total, 0)
  assert.equal(sumDays, 152)
  assert.equal(sumModels, sumDays, '全局模型聚合必须与日桶同口径')
})

test('aggregateTokenStats: provider 内模型榜 top10 + (其余)', () => {
  const modelsByProvider = {}
  for (let index = 1; index <= 12; index += 1) {
    modelsByProvider['model-' + String(index).padStart(2, '0')] = B(13 - index)
  }
  const sessions = [
    {
      id: 's1',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 78, requests: 12 } },
        perDayProvider: { '2026-10-23': { p1: B(78, 12) } },
        perDayProviderModel: { '2026-10-23': { p1: modelsByProvider } },
      },
    },
  ]
  const { providers } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(providers.length, 1)
  assert.equal(providers[0].models.length, 11)
  assert.equal(providers[0].models[0].model, 'model-01')
  assert.equal(providers[0].models[9].model, 'model-10')
  assert.equal(providers[0].models[10].model, '(其余)')
  assert.equal(providers[0].models[10].total, 3, 'model-11(2) + model-12(1)')
  assert.equal(
    providers[0].models.reduce((total, model) => total + model.total, 0),
    providers[0].total,
  )
})

test('aggregateTokenStats: 全局模型榜 top10 + 一条 {provider:"(其余)",model:"(其余)"}', () => {
  const providerModels = {}
  for (let index = 1; index <= 12; index += 1) {
    const model = 'g-' + String(index).padStart(2, '0')
    providerModels['p' + (index % 3)] = providerModels['p' + (index % 3)] || {}
    providerModels['p' + (index % 3)][model] = B(13 - index)
  }
  const sessions = [
    {
      id: 's1',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 78, requests: 12 } },
        perDayProvider: {},
        perDayProviderModel: { '2026-10-23': providerModels },
      },
    },
  ]
  const { models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(models.length, 11)
  assert.equal(models[10].provider, '(其余)')
  assert.equal(models[10].model, '(其余)')
  assert.equal(models[10].total, 3)
  assert.ok(models.slice(0, 10).every((item) => typeof item.provider === 'string' && item.provider !== '(其余)'))
})

test('aggregateTokenStats: provider/model 缺失的记录归到 (未知)', () => {
  const sessions = [
    {
      id: 's1',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 9, requests: 1 } },
        perDayProvider: { '2026-10-23': { '(未知)': B(9, 1) } },
        perDayProviderModel: { '2026-10-23': { '(未知)': { '(未知)': B(9, 1) } } },
      },
    },
  ]
  const { providers, models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(providers[0].provider, '(未知)')
  assert.equal(providers[0].models[0].model, '(未知)')
  assert.equal(models[0].provider, '(未知)')
  assert.equal(models[0].model, '(未知)')
})

test('aggregateTokenStats: 旧版 fold（无 perDayProvider/perDayProviderModel）不产生 providers/models', () => {
  const sessions = [
    {
      id: 'legacy',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 9, requests: 1 } },
        perDayModel: { '2026-10-23': { old: B(999, 9) } },
      },
    },
  ]
  const { days, providers, models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(days[29].total, 9, '合计日桶仍然可用')
  assert.deepEqual(providers, [])
  assert.deepEqual(models, [])
})

test('aggregateTokenStats: 空输入返回全 0 的 30 天、空 providers/models', () => {
  const { days, providers, models } = aggregateTokenStats([], { today: '2026-10-23', windowDays: 30 })
  assert.equal(days.length, 30)
  assert.ok(days.every((day) => day.total === 0 && day.requests === 0 && day.sessions === 0))
  assert.deepEqual(providers, [])
  assert.deepEqual(models, [])
})

test('emptyTokenStats: sessionQuery 不可用时的兜底形状（scope/providers/30 天全 0）', () => {
  const now = new Date(2026, 9, 23, 10).getTime()
  const stats = emptyTokenStats(now)
  assert.equal(stats.today, '2026-10-23')
  assert.equal(stats.weekStart, '2026-10-19')
  assert.equal(stats.windowDays, 30)
  assert.equal(stats.scope, 'all-providers')
  assert.equal('provider' in stats, false, '旧字段 tokens.provider 已删除')
  assert.equal(typeof stats.timeZone, 'string')
  assert.equal(stats.days.length, 30)
  assert.equal(stats.days[29].date, '2026-10-23')
  assert.ok(stats.days.every((day) => day.total === 0 && day.requests === 0 && day.sessions === 0))
  assert.deepEqual(stats.providers, [])
  assert.deepEqual(stats.models, [])
  assert.deepEqual(stats.scan, {
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
  })
})

/* -------------------------------- buildSnapshot ------------------------------- */

test('buildSnapshot: 默认形状满足契约（version/cached/key/limits/official/tokens/errors）', () => {
  const value = buildSnapshot({})
  assert.equal(value.version, 1)
  assert.equal(value.cached, false)
  assert.equal(typeof value.updatedAt, 'string')
  assert.deepEqual(value.key, { source: 'none', masked: null })
  assert.deepEqual(value.limits, emptyLimits())
  assert.equal(value.official.range24h, null)
  assert.equal(value.official.range7d, null)
  assert.equal(value.official.range30d, null)
  assert.equal(typeof value.official.fetchedAt, 'string')
  assert.equal(value.tokens.windowDays, 30)
  assert.equal(value.tokens.days.length, 30)
  assert.equal(value.tokens.scope, 'all-providers')
  assert.deepEqual(value.tokens.providers, [])
  assert.equal(value.tokens.scan.partial, false)
  assert.deepEqual(value.errors, [])
})

test('buildSnapshot: 保留合法数据、过滤非法 errors 项', () => {
  const value = buildSnapshot({
    now: at(2026, 9, 23, 8),
    key: { source: 'credentials', masked: 'sk-****1fdd' },
    cached: true,
    limits: { kind: 'legacy', session: null, weekly: null, credits: null, purchasedUsd: 0 },
    errors: [
      { source: 'balance', code: 'network', message: '超时' },
      { source: 'usage24h', code: 'rate-limit', message: '限流' },
      { source: 1, code: 'x', message: 'bad' },
      null,
      'nope',
    ],
  })
  assert.equal(value.cached, true)
  assert.deepEqual(value.key, { source: 'credentials', masked: 'sk-****1fdd' })
  assert.equal(value.limits.kind, 'legacy')
  assert.equal(value.errors.length, 2)
  assert.deepEqual(value.errors[0], { source: 'balance', code: 'network', message: '超时' })
  assert.equal(value.official.fetchedAt, value.updatedAt)
})
