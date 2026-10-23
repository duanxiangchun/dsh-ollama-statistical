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

function assistantEvent(time, usage, source) {
  return { type: 'assistant/message', seq: 1, time, data: { usage, message: { source } } }
}

test('aggregateSessionEvents: 日桶 / 模型聚合、totalTokens 回退、provider 过滤', () => {
  const events = [
    // 1) 无 totalTokens：total = input + output = 120；cacheRead 只展示不重复加
    assistantEvent(
      at(2026, 9, 23, 10),
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      OLLAMA_SOURCE,
    ),
    // 2) 有 totalTokens：直接用它（999）
    assistantEvent(
      at(2026, 9, 23, 11),
      { inputTokens: 10, outputTokens: 5, totalTokens: 999 },
      OLLAMA_SOURCE,
    ),
    // 3) 别的 provider：过滤掉
    assistantEvent(
      at(2026, 9, 23, 12),
      { inputTokens: 7, outputTokens: 7 },
      { kind: 'model', provider: 'wb', model: 'deepseek-v4.1-flash' },
    ),
    // 4) 没有 usage：忽略
    { type: 'assistant/message', seq: 4, time: at(2026, 9, 23, 13), data: { message: { source: OLLAMA_SOURCE } } },
    // 5) 非 assistant/message：忽略
    { type: 'tool/result', seq: 5, time: at(2026, 9, 23, 14), data: {} },
  ]

  const fold = aggregateSessionEvents(events)
  assert.equal(fold.requests, 2)

  const day = fold.perDay['2026-10-23']
  assert.equal(day.input, 110)
  assert.equal(day.output, 25)
  assert.equal(day.cacheRead, 50)
  assert.equal(day.requests, 2)
  assert.equal(day.total, 120 + 999, 'cacheRead 不应重复加进 total')

  assert.deepEqual(Object.keys(fold.perDay), ['2026-10-23'])
  // v2 fold：按「日 + 模型」折叠，供 aggregateTokenStats 按窗口过滤模型
  const dayModels = fold.perDayModel['2026-10-23']
  assert.deepEqual(Object.keys(dayModels), ['deepseek-v4.1-flash:1017'])
  assert.equal(dayModels['deepseek-v4.1-flash:1017'].total, 1119)
  assert.equal(dayModels['deepseek-v4.1-flash:1017'].requests, 2)
})

test('aggregateSessionEvents: 非法输入不抛错', () => {
  assert.deepEqual(aggregateSessionEvents(null), { requests: 0, perDay: {}, perDayModel: {} })
  assert.deepEqual(aggregateSessionEvents([]), { requests: 0, perDay: {}, perDayModel: {} })
  assert.deepEqual(aggregateSessionEvents([null, 1, 'x']).requests, 0)
})

test('aggregateSessionEvents: 空 model 归到 (未知)，负数 token 归 0', () => {
  const events = [
    assistantEvent(
      at(2026, 9, 23, 10),
      { inputTokens: -5, outputTokens: 3, totalTokens: -1 },
      { kind: 'model', provider: 'ollama', model: '' },
    ),
  ]
  const fold = aggregateSessionEvents(events)
  const dayModels = fold.perDayModel['2026-10-23']
  assert.deepEqual(Object.keys(dayModels), ['(未知)'])
  assert.equal(dayModels['(未知)'].input, 0)
  assert.equal(dayModels['(未知)'].output, 3)
  assert.equal(dayModels['(未知)'].total, 3)
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

test('aggregateTokenStats: 30 天窗口、窗口外忽略、会话去重计数', () => {
  const sessions = [
    {
      id: 's1',
      fold: {
        perDay: {
          '2026-10-23': { ...EMPTY_BUCKET, input: 10, output: 5, total: 15, requests: 2 },
          '2026-10-22': { ...EMPTY_BUCKET, input: 1, output: 1, total: 2, requests: 1 },
          '2026-09-01': { ...EMPTY_BUCKET, total: 999, requests: 9 }, // 窗口外
        },
        perDayModel: {
          '2026-10-23': { m1: { ...EMPTY_BUCKET, total: 15, requests: 2 } },
          '2026-10-22': { m1: { ...EMPTY_BUCKET, total: 2, requests: 1 } },
          '2026-09-01': { m1: { ...EMPTY_BUCKET, total: 999, requests: 9 } }, // 窗口外
        },
      },
    },
    {
      id: 's2',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, input: 3, output: 2, total: 5, requests: 1 } },
        perDayModel: { '2026-10-23': { m2: { ...EMPTY_BUCKET, total: 5, requests: 1 } } },
      },
    },
  ]

  const { days, models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(days.length, 30)
  assert.equal(days[0].date, '2026-09-24')
  assert.equal(days[29].date, '2026-10-23')

  const today = days[29]
  assert.equal(today.total, 20)
  assert.equal(today.requests, 3)
  assert.equal(today.sessions, 2, '两个会话当天都有 ollama 请求')

  const yesterday = days[28]
  assert.equal(yesterday.total, 2)
  assert.equal(yesterday.sessions, 1)

  assert.equal(days.find((day) => day.date === '2026-09-01'), undefined)

  assert.equal(models.length, 2)
  assert.equal(models[0].model, 'm1')
  assert.equal(models[0].total, 17, '窗口外的 999 不能进模型聚合')
  assert.equal(models[1].model, 'm2')
})

test('aggregateTokenStats: models 与 days 同口径（sum(models.total) === sum(days.total)）', () => {
  const sessions = [
    {
      id: 'windowed',
      fold: {
        perDay: {
          '2026-10-23': { ...EMPTY_BUCKET, total: 40, requests: 2 },
          '2026-09-01': { ...EMPTY_BUCKET, total: 700, requests: 5 }, // 窗口外
        },
        perDayModel: {
          '2026-10-23': { modelA: { ...EMPTY_BUCKET, total: 30, requests: 1 }, modelB: { ...EMPTY_BUCKET, total: 10, requests: 1 } },
          '2026-09-01': { modelA: { ...EMPTY_BUCKET, total: 700, requests: 5 } }, // 窗口外
        },
      },
    },
    {
      id: 'mixed',
      fold: {
        perDay: {
          '2026-10-21': { ...EMPTY_BUCKET, total: 7, requests: 1 },
          '2026-08-30': { ...EMPTY_BUCKET, total: 500, requests: 3 },
        },
        perDayModel: {
          '2026-10-21': { modelA: { ...EMPTY_BUCKET, total: 7, requests: 1 } },
          '2026-08-30': { modelB: { ...EMPTY_BUCKET, total: 500, requests: 3 } },
        },
      },
    },
  ]
  const { days, models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  const sumDays = days.reduce((sum, day) => sum + day.total, 0)
  const sumModels = models.reduce((sum, model) => sum + model.total, 0)
  assert.equal(sumDays, 47)
  assert.equal(sumModels, sumDays, '模型聚合必须按 30 天窗口过滤，与日桶同口径')
})

test('aggregateTokenStats: 模型按 total 降序，超过 10 条合并成 (其余)', () => {
  const modelsByDay = {}
  for (let index = 1; index <= 12; index += 1) {
    const model = 'model-' + String(index).padStart(2, '0')
    modelsByDay[model] = { ...EMPTY_BUCKET, total: 13 - index, requests: 1 }
  }
  const sessions = [{ id: 's1', fold: { perDay: {}, perDayModel: { '2026-10-23': modelsByDay } } }]
  const { models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.equal(models.length, 11)
  assert.equal(models[0].model, 'model-01')
  assert.equal(models[9].model, 'model-10')
  assert.equal(models[10].model, '(其余)')
  // 被合并的两条：11 + 12 → model-11 total 2、model-12 total 1
  assert.equal(models[10].total, 3)
  assert.equal(models[10].requests, 2)
})

test('aggregateTokenStats: 旧版 fold（perModel）不会被误用', () => {
  const sessions = [
    {
      id: 'legacy',
      fold: {
        perDay: { '2026-10-23': { ...EMPTY_BUCKET, total: 9, requests: 1 } },
        perModel: { old: { ...EMPTY_BUCKET, total: 999, requests: 9 } },
      },
    },
  ]
  const { models } = aggregateTokenStats(sessions, { today: '2026-10-23', windowDays: 30 })
  assert.deepEqual(models, [], '没有 perDayModel 的旧 fold 不参与模型聚合（缓存版本已升级丢弃）')
})

test('aggregateTokenStats: 空输入返回全 0 的 30 天与空模型列表', () => {
  const { days, models } = aggregateTokenStats([], { today: '2026-10-23', windowDays: 30 })
  assert.equal(days.length, 30)
  assert.ok(days.every((day) => day.total === 0 && day.requests === 0 && day.sessions === 0))
  assert.deepEqual(models, [])
})

test('emptyTokenStats: sessionQuery 不可用时的兜底形状（30 天全 0、scan.partial=false）', () => {
  const now = new Date(2026, 9, 23, 10).getTime()
  const stats = emptyTokenStats(now)
  assert.equal(stats.today, '2026-10-23')
  assert.equal(stats.weekStart, '2026-10-19')
  assert.equal(stats.windowDays, 30)
  assert.equal(stats.provider, 'ollama')
  assert.equal(typeof stats.timeZone, 'string')
  assert.equal(stats.days.length, 30)
  assert.equal(stats.days[29].date, '2026-10-23')
  assert.ok(stats.days.every((day) => day.total === 0 && day.requests === 0 && day.sessions === 0))
  assert.deepEqual(stats.models, [])
  assert.deepEqual(stats.scan, {
    sessions: 0,
    candidates: 0,
    scanned: 0,
    fromCache: 0,
    covered: 0,
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
  assert.equal(value.tokens.provider, 'ollama')
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
