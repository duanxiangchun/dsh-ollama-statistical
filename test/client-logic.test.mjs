/**
 * lib/client.js 的纯逻辑回归测试（不依赖真实浏览器 / react-dom）。
 *
 * 做法：在 node:vm 沙箱里跑浏览器 bundle —— 用假的 window.__ModuleLoader__ 捕获
 * factory，用最小 React stub 提供 require('react')，再调用 apply(fakeCtx) 捕获
 * 三处槽位注册参数；其余用例直接测 exports.__test 暴露的纯函数。
 *
 * 覆盖：槽位注册参数、今天/本周/自定义 range 切片与求和、i18n 语言判定与插值、
 * 数字/百分比/紧凑数/时间格式化、倒计时、阈值色、中英字典键对称。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
const CLIENT_ID = 'dsh-ollama-statistical'
const RPC_CHANNEL = '/ollama-statistical'
/* 三个槽位注册（顺序：panellist / main / footer），与契约第 4.1 节一致。 */
const EXPECTED_SLOTS = ['sidebar.panellist', 'main', 'sidebar.footer.action']

function makeReactStub() {
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children })
  const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  return {
    createElement,
    useState,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
}

/** 加载客户端 bundle：返回 { exports, moduleId, requiredModules }。 */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const captured = { definition: null }
  const requiredModules = []
  const sandbox = {
    console,
    Intl,
    Date,
    globalThis: null,
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured.definition = definition
        },
      },
    },
    document: undefined,
    require(id) {
      requiredModules.push(id)
      if (id === 'react') return makeReactStub()
      throw new Error('client bundle 只允许 require("react")，实际: ' + id)
    },
  }
  sandbox.globalThis = sandbox
  runInContext(source, createContext(sandbox), { filename: 'lib/client.js' })

  assert.ok(captured.definition, 'window.__ModuleLoader__.load 必须被调用')
  assert.equal(captured.definition.id, CLIENT_ID, 'bundle id 必须等于包名')
  assert.equal(typeof captured.definition.factory, 'function', 'factory 必须是函数')
  const exports = captured.definition.factory(sandbox.require)
  return { exports, requiredModules }
}

function makeFakeCtx() {
  const state = { injections: [], registrations: [], intervals: [], effects: [] }
  const slots = {
    inject(scope, callback) {
      state.injections.push(scope)
      const dispose = typeof callback === 'function' ? callback() : undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      state.registrations.push({ options, component })
      return () => {}
    },
  }
  const connection = {
    rpc: {
      call() {
        return Promise.resolve({ ok: false, error: { code: 'no-data', message: 'stub' } })
      },
    },
  }
  const locale = {
    getLocale: () => ({ active: 'zh-CN', locales: [], revision: 1 }),
    register: () => () => {},
    bind: () => (key) => key,
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'connection') return connection
      if (name === 'locale') return locale
      return undefined
    },
    interval(callback, ms) {
      state.intervals.push(ms)
      return () => {}
    },
    effect(callback) {
      state.effects.push('effect')
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, state }
}

/** 生成最近 30 天（升序）的 token 日桶，total/requests 均等于其序号，方便求和断言。 */
function makeTokens() {
  const p2 = (n) => (n < 10 ? '0' + n : String(n))
  const days = []
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(2026, 9, 23) // 2026-10-23 本地
    d.setDate(d.getDate() - i)
    const date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    const index = 29 - i
    days.push({
      date,
      input: index,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: index,
      requests: 1,
      sessions: 1,
    })
  }
  return {
    scope: 'all-providers',
    today: '2026-10-23',
    weekStart: '2026-10-19',
    windowDays: 30,
    timeZone: 'Asia/Shanghai',
    // 今天 24 小时桶：第 i 小时 input/total=i（完整桶，用于趋势图断言）
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour: String(hour).padStart(2, '0'),
      input: hour,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: hour,
      requests: 1,
      sessions: 1,
    })),
    days,
    // 供应商分组：ollama 每天 total=index（完整桶，与 tokens.days 一致）；wb 全 0。
    providers: [
      {
        provider: 'ollama',
        input: 435,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 435,
        requests: 30,
        sessions: 1,
        models: [
          {
            model: 'modelA',
            input: 435,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            total: 435,
            requests: 30,
            days: days.map((day, index) => ({ date: day.date, total: index, requests: 1 })),
          },
        ],
        days: days.map((day, index) => ({
          date: day.date,
          input: index,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: index,
          requests: 1,
          sessions: 1,
        })),
        hours: Array.from({ length: 24 }, (_, hour) => ({
          hour: String(hour).padStart(2, '0'),
          input: hour,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: hour,
          requests: 1,
          sessions: 1,
        })),
      },
      {
        provider: 'wb',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
        requests: 0,
        sessions: 0,
        models: [
          {
            model: 'modelB',
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            total: 0,
            requests: 0,
            days: days.map((day) => ({ date: day.date, total: 0, requests: 0 })),
          },
        ],
        days: days.map((day) => ({
          date: day.date,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          total: 0,
          requests: 0,
          sessions: 0,
        })),
      },
    ],
    // 模型榜：ollama 的 modelA 每天 total=index；wb 的 modelB 全 0。
    models: [
      {
        provider: 'ollama',
        model: 'modelA',
        input: 435,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 435,
        requests: 30,
        days: days.map((day, index) => ({ date: day.date, total: index, requests: 1 })),
      },
      {
        provider: 'wb',
        model: 'modelB',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
        requests: 0,
        days: days.map((day) => ({ date: day.date, total: 0, requests: 0 })),
      },
    ],
    scan: { sessions: 2, candidates: 2, scanned: 2, fromCache: 0, covered: 2, failed: 0, retired: 0, pending: 0, elapsedMs: 1, partial: false },
  }
}

test('client：providerRangeRows 按所选时间范围求和（chips/分布块与 hero 同口径）', () => {
  assert.equal(typeof T.providerRangeRows, 'function', '__test 缺少 providerRangeRows')
  const tokens = makeTokens()
  // 本周（10-19..10-23 → 日桶序号 25..29）
  const weekSumOllama = 25 + 26 + 27 + 28 + 29
  const rows = T.providerRangeRows(tokens, tokens.weekStart, tokens.today)
  assert.equal(rows.length, 2)
  // 顺序按窗口总量降序：ollama(435) 在前，wb(0) 在后
  assert.equal(rows[0].provider, 'ollama')
  assert.equal(rows[1].provider, 'wb')
  assert.equal(rows[0].total, weekSumOllama, 'ollama 本周 = 日桶求和')
  assert.equal(rows[0].requests, 5)
  assert.equal(rows[1].total, 0, 'wb 本周无用量')
  const shareSum = rows.reduce((sum, row) => sum + (row.share || 0), 0)
  assert.ok(Math.abs(shareSum - 100) < 0.5, 'share 之和应 ≈100，实际 ' + shareSum)

  // 与全部视图 hero 总量严格一致
  const allWeek = T.computeRange(tokens, 'week')
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), allWeek.agg.total)
  assert.equal(rows.reduce((sum, row) => sum + row.requests, 0), allWeek.agg.requests)

  // 今天：只取最后一天
  const todayRows = T.providerRangeRows(tokens, tokens.today, tokens.today)
  assert.equal(todayRows.find((row) => row.provider === 'ollama').total, 29)
  assert.equal(todayRows.find((row) => row.provider === 'wb').total, 0)

  // providers[].days 缺失 → 该行 degraded（total/share 为 null），其余行不受影响
  const degradedTokens = {
    ...tokens,
    providers: tokens.providers.concat([{ provider: 'ghost', total: 1, requests: 1 }]),
  }
  const degradedRows = T.providerRangeRows(degradedTokens, tokens.weekStart, tokens.today)
  const ghost = degradedRows.find((row) => row.provider === 'ghost')
  assert.ok(ghost, '缺失 days 的 provider 仍应出现（降级行）')
  assert.equal(ghost.total, null)
  assert.equal(ghost.share, null)
  assert.equal(ghost.degraded, true)
  assert.equal(degradedRows.find((row) => row.provider === 'ollama').total, weekSumOllama, '缺失 days 不影响其他行')
})

test('client：单供应商指标与模型榜都按所选时间范围求和', () => {
  const tokens = makeTokens()
  const weekSum = 25 + 26 + 27 + 28 + 29

  // 单供应商指标网格：走 providers[].days 完整桶的范围求和
  assert.equal(typeof T.selectTokenSource, 'function', '__test 缺少 selectTokenSource')
  assert.equal(typeof T.computeSourceRange, 'function', '__test 缺少 computeSourceRange')
  const ollamaSource = T.selectTokenSource(tokens, 'ollama')
  const week = T.computeSourceRange(ollamaSource, 'week')
  assert.equal(week.agg.total, weekSum)
  assert.equal(week.agg.input, weekSum, 'input 也是范围求和，不是窗口合计 435')
  assert.equal(week.agg.requests, 5)
  assert.equal(week.agg.sessions, 5)
  assert.equal(week.agg.activeDays, 5)
  const today = T.computeSourceRange(ollamaSource, 'today')
  assert.equal(today.agg.total, 29)
  assert.equal(today.agg.input, 29)

  // 未知 provider 回退 all
  const fallback = T.selectTokenSource(tokens, 'not-exist')
  assert.equal(fallback.isAll, true)

  // 模型榜范围口径
  assert.equal(typeof T.modelRangeRows, 'function', '__test 缺少 modelRangeRows')
  const modelRows = T.modelRangeRows(tokens, 'all', tokens.weekStart, tokens.today)
  assert.equal(modelRows.length, 2)
  assert.equal(modelRows[0].model, 'modelA', '按窗口 total 降序：modelA 在前')
  assert.equal(modelRows[0].total, weekSum)
  assert.equal(modelRows[1].total, 0)
  const modelShareSum = modelRows.reduce((sum, row) => sum + (row.share || 0), 0)
  assert.ok(Math.abs(modelShareSum - 100) < 0.5, '模型占比之和应 ≈100，实际 ' + modelShareSum)

  // 单供应商模型榜
  const providerModels = T.modelRangeRows(tokens, 'ollama', tokens.weekStart, tokens.today)
  assert.equal(providerModels.length, 1)
  assert.equal(providerModels[0].model, 'modelA')
  assert.equal(providerModels[0].total, weekSum)
  assert.equal(providerModels[0].degraded, false)

  // 模型缺 days → degraded，使用窗口值兜底
  const degradedTokens = {
    ...tokens,
    models: [{ provider: 'ollama', model: 'oldModel', total: 999, requests: 9 }],
  }
  const degradedRows = T.modelRangeRows(degradedTokens, 'all', tokens.weekStart, tokens.today)
  assert.equal(degradedRows[0].total, 999, '缺 days 时用窗口 total 兜底')
  assert.equal(degradedRows[0].degraded, true)
  assert.equal(degradedRows[0].share, null)
})

test('client：缓存命中率 = 缓存读 /（输入 + 缓存读），输入为 0 返回 null', () => {
  assert.equal(typeof T.cacheHitPercent, 'function', '__test 缺少 cacheHitPercent')
  // DSH 的 cacheReadTokens 单独计数，不含在 inputTokens 里 → 分母是二者之和
  assert.equal(T.cacheHitPercent({ input: 100, cacheRead: 100 }), 50)
  assert.equal(T.cacheHitPercent({ input: 0, cacheRead: 100 }), 100, '全部命中')
  assert.equal(T.cacheHitPercent({ input: 100, cacheRead: 0 }), 0, '完全没有缓存')
  assert.equal(T.cacheHitPercent({ input: 17, cacheRead: 983 }), 98.3)
  assert.equal(T.cacheHitPercent({ input: 0, cacheRead: 0 }), null, '无 prompt token 时无意义')
  assert.equal(T.cacheHitPercent(null), null)
  // 与真实量级联动（今天：input 约 2780 万、cacheRead 约 9.03 亿 → 约 97%）
  const real = T.cacheHitPercent({ input: 27807046, cacheRead: 902868712 })
  assert.ok(real > 96 && real <= 100, '真实量级命中率应 ~97%，实际 ' + real)
})

test('client：chartSeries 粒度自适应（今天→24 小时，本周/跨天→按天，缺小时桶回退天）', () => {
  assert.equal(typeof T.chartSeries, 'function', '__test 缺少 chartSeries')
  const tokens = makeTokens()

  // 今天：小时模式，24 点，标签 00..23，合计 = 0+1+...+23
  const hourly = T.chartSeries(tokens, 'all', 'today', tokens.today, tokens.today)
  assert.equal(hourly.mode, 'hour')
  assert.equal(hourly.points.length, 24)
  assert.equal(hourly.points[0].label, '00')
  assert.equal(hourly.points[23].label, '23')
  assert.equal(hourly.points[5].total, 5)
  const hourSum = hourly.points.reduce((a, p) => a + p.total, 0)
  assert.equal(hourSum, (23 * 24) / 2)

  // 单供应商今天：用 providers[].hours
  const providerHourly = T.chartSeries(tokens, 'ollama', 'today', tokens.today, tokens.today)
  assert.equal(providerHourly.mode, 'hour')
  assert.equal(providerHourly.points.length, 24)
  assert.equal(providerHourly.points[5].total, 5)

  // 本周：天模式，5 点（10-19..10-23）
  const daily = T.chartSeries(tokens, 'all', 'week', tokens.weekStart, tokens.today)
  assert.equal(daily.mode, 'day')
  assert.equal(daily.points.length, 5)
  assert.equal(daily.points.reduce((a, p) => a + p.total, 0), 25 + 26 + 27 + 28 + 29)

  // 自定义范围恰好是今天 → 小时模式
  const customToday = T.chartSeries(tokens, 'all', 'custom', tokens.today, tokens.today)
  assert.equal(customToday.mode, 'hour')

  // 自定义跨天 → 天模式
  const customSpan = T.chartSeries(tokens, 'all', 'custom', '2026-10-01', '2026-10-05')
  assert.equal(customSpan.mode, 'day')
  assert.equal(customSpan.points.length, 5)

  // 小时桶缺失 → 回退天模式（今天只有 1 根柱），不崩
  const noHours = { ...tokens, hours: undefined, providers: tokens.providers.map((p) => ({ ...p, hours: undefined })) }
  const fallback = T.chartSeries(noHours, 'all', 'today', tokens.today, tokens.today)
  assert.equal(fallback.mode, 'day')
  assert.equal(fallback.points.length, 1)

  // 长度不足 24 → 也回退天模式
  const shortHours = { ...tokens, hours: tokens.hours.slice(0, 23) }
  assert.equal(T.chartSeries(shortHours, 'all', 'today', tokens.today, tokens.today).mode, 'day')
})

test('client：模型榜/供应商分布按「当前范围」数值从高到低排序（不是窗口总量）', () => {
  const tokens = makeTokens()
  const days = tokens.days

  // 模型：bigWindowLowRange 窗口总量大但本周为 0；smallWindowHighRange 反之 → 本周应按后者在前
  const reorderModels = {
    ...tokens,
    models: [
      {
        provider: 'ollama',
        model: 'bigWindowLowRange',
        total: 1000,
        requests: 10,
        days: days.map((day) => ({ date: day.date, total: 0, requests: 0 })),
      },
      {
        provider: 'ollama',
        model: 'smallWindowHighRange',
        total: 100,
        requests: 5,
        days: days.map((day) => ({ date: day.date, total: day.date === tokens.today ? 50 : 0, requests: 1 })),
      },
    ],
  }
  const modelRows = T.modelRangeRows(reorderModels, 'all', tokens.weekStart, tokens.today)
  assert.equal(modelRows[0].model, 'smallWindowHighRange', '按范围 token 降序，范围值大的排前面')
  assert.equal(modelRows[1].model, 'bigWindowLowRange')

  // 供应商：A 窗口大但本周 0；B 窗口小但本周有量 → B 在前
  const reorderProviders = {
    ...tokens,
    providers: [
      {
        provider: 'bigWindowProvider',
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        total: 1000, requests: 10, sessions: 1, models: [],
        days: days.map((day) => ({ date: day.date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0, sessions: 0 })),
      },
      {
        provider: 'smallWindowProvider',
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        total: 100, requests: 5, sessions: 1, models: [],
        days: days.map((day) => ({ date: day.date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: day.date === tokens.today ? 50 : 0, requests: 1, sessions: 1 })),
      },
    ],
    days: days.map((day) => ({ ...day, total: day.date === tokens.today ? 50 : 0, input: day.date === tokens.today ? 50 : 0 })),
  }
  const providerRows = T.providerRangeRows(reorderProviders, tokens.weekStart, tokens.today)
  assert.equal(providerRows[0].provider, 'smallWindowProvider', '按范围 token 降序')
  assert.equal(providerRows[1].provider, 'bigWindowProvider')
})

test('client：未上报的可选指标（缓存写/推理/缓存命中）为 0 时不展示卡片', () => {
  assert.equal(typeof T.showOptionalMetric, 'function', '__test 缺少 showOptionalMetric')
  // 真实日志里只有 input/output/total/cacheRead → 缓存写/推理为 0 时不显示
  assert.equal(T.showOptionalMetric({ input: 1000, output: 100, cacheRead: 100, cacheWrite: 0, reasoning: 0 }, 'cacheWrite'), false)
  assert.equal(T.showOptionalMetric({ input: 1000, output: 100, cacheRead: 100, cacheWrite: 0, reasoning: 0 }, 'reasoning'), false)
  // 有缓存读时命中率卡片保留
  assert.equal(T.showOptionalMetric({ cacheRead: 100, cacheWrite: 0 }, 'cacheHit'), true)
  assert.equal(T.showOptionalMetric({ cacheRead: 0, cacheWrite: 0 }, 'cacheHit'), false, '没有缓存读时命中率无意义')
  // 字段有值时正常展示
  assert.equal(T.showOptionalMetric({ cacheWrite: 5 }, 'cacheWrite'), true)
  assert.equal(T.showOptionalMetric({ reasoning: 7 }, 'reasoning'), true)
  // 常规指标永远展示
  assert.equal(T.showOptionalMetric({}, 'input'), true)
  assert.equal(T.showOptionalMetric(null, 'requests'), true)
})

test('client：chartTrend 多序列趋势数据（小时/天、完整桶、命中率、回退）', () => {
  assert.equal(typeof T.chartTrend, 'function', '__test 缺少 chartTrend')
  const tokens = makeTokens()
  const hourSum = (23 * 24) / 2

  // 今天：24 个点，带完整桶字段；input 逐点 = 小时序号
  const today = T.chartTrend(tokens, 'all', 'today', tokens.today, tokens.today)
  assert.equal(today.mode, 'hour')
  assert.equal(today.points.length, 24)
  assert.equal(today.points[0].label, '00')
  assert.equal(today.points[23].label, '23')
  assert.equal(today.points[5].input, 5)
  assert.equal(today.points[5].total, 5)
  assert.equal(today.points.reduce((a, p) => a + p.input, 0), hourSum)
  assert.equal(today.points.reduce((a, p) => a + p.requests, 0), 24)
  // 第 0 小时 input=0/cacheRead=0 → 命中率无意义（null）；其余为 0%
  assert.equal(today.points[0].hitRate, null)
  assert.equal(today.points[5].hitRate, 0)

  // 单供应商：用 providers[].hours
  const providerToday = T.chartTrend(tokens, 'ollama', 'today', tokens.today, tokens.today)
  assert.equal(providerToday.mode, 'hour')
  assert.equal(providerToday.points[7].input, 7)

  // 本周：天模式，完整桶按范围求和（fixture 的 days.input = 日桶序号）
  const week = T.chartTrend(tokens, 'all', 'week', tokens.weekStart, tokens.today)
  assert.equal(week.mode, 'day')
  assert.equal(week.points.length, 5)
  assert.equal(week.points.reduce((a, p) => a + p.input, 0), 25 + 26 + 27 + 28 + 29)
  assert.equal(week.points[0].label, '2026-10-19')

  // 自定义起止都是今天 → 小时
  assert.equal(T.chartTrend(tokens, 'all', 'custom', tokens.today, tokens.today).mode, 'hour')
  // 跨天 → 天
  assert.equal(T.chartTrend(tokens, 'all', 'custom', '2026-10-01', '2026-10-05').mode, 'day')

  // 小时桶缺失 → 回退天（今天 1 个点），不崩
  const noHours = { ...tokens, hours: undefined, providers: tokens.providers.map((p) => ({ ...p, hours: undefined })) }
  const fallback = T.chartTrend(noHours, 'all', 'today', tokens.today, tokens.today)
  assert.equal(fallback.mode, 'day')
  assert.equal(fallback.points.length, 1)

  // 兼容层：chartSeries 仍返回 total/requests 形状
  const legacy = T.chartSeries(tokens, 'all', 'today', tokens.today, tokens.today)
  assert.equal(legacy.mode, 'hour')
  assert.equal(legacy.points[5].total, 5)
  assert.equal(legacy.points[5].input, undefined)
})

test('client：底部横条沿用语义色（充足绿 / 70% 黄 / 90% 红）', () => {
  assert.equal(typeof T.toneFill, 'function', '__test 缺少 toneFill')
  assert.ok(T.toneFill(10).includes('state-success-primary'), T.toneFill(10))
  assert.ok(T.toneFill(75).includes('state-warn-primary'), T.toneFill(75))
  assert.ok(T.toneFill(95).includes('state-error-primary'), T.toneFill(95))
  assert.ok(T.toneFill(null).includes('label-tertiary'), T.toneFill(null))
  // 阈值与 toneOf 一致
  assert.equal(T.toneOf(69.9), 'ok')
  assert.equal(T.toneOf(70), 'warn')
  assert.equal(T.toneOf(89.9), 'warn')
  assert.equal(T.toneOf(90), 'error')
})

test('client：周额度 token 估算（已用 token ÷ 已用百分比）', () => {
  assert.equal(typeof T.estimateQuotaTokens, 'function', '__test 缺少 estimateQuotaTokens')
  // 已用 25%、本机 ollama 本周 2.5 亿 → 周额度 ≈ 10 亿，剩余 ≈ 7.5 亿
  const est = T.estimateQuotaTokens(25, 250000000)
  assert.equal(est.used, 250000000)
  assert.equal(est.total, 1000000000)
  assert.equal(est.remaining, 750000000)
  // 已用超过 100% 时剩余不为负
  const over = T.estimateQuotaTokens(120, 1200000)
  assert.equal(over.total, 1000000)
  assert.equal(over.remaining, 0)
  // 无法推算的场景
  assert.equal(T.estimateQuotaTokens(0, 1000), null)
  assert.equal(T.estimateQuotaTokens(null, 1000), null)
  assert.equal(T.estimateQuotaTokens(50, 0), null)
  assert.equal(T.estimateQuotaTokens(50, null), null)
  // 与真实量级联动：本周 91.39%、本机 ollama 约 15.9 亿 → 总量 ≈ 17.4 亿
  const real = T.estimateQuotaTokens(91.39, 1587647134)
  assert.ok(real.total > 1600000000 && real.total < 1800000000, '实际 ' + real.total)
  assert.ok(real.remaining > 0 && real.remaining < real.total)
})

test('client：失败提示的忽略状态可读可写（无 localStorage 时安全降级）', () => {
  assert.equal(typeof T.readIgnoredFailedCount, 'function', '__test 缺少 readIgnoredFailedCount')
  assert.equal(typeof T.writeIgnoredFailedCount, 'function', '__test 缺少 writeIgnoredFailedCount')
  // 测试沙箱里的 window 没有 localStorage：读返回 0，写不抛错
  assert.equal(T.readIgnoredFailedCount(), 0)
  assert.doesNotThrow(() => T.writeIgnoredFailedCount(25))
})

const loaded = loadClient()
const T = loaded.exports.__test

test('client bundle：模块形状与依赖约束', () => {
  assert.equal(typeof loaded.exports.apply, 'function')
  assert.ok(Array.isArray(loaded.exports.inject))
  for (const service of ['slots', 'connection', 'timer', 'locale']) {
    assert.ok(loaded.exports.inject.includes(service), 'inject 应包含 ' + service)
  }
  assert.deepEqual(loaded.requiredModules, ['react'], '只能 require("react")')
  assert.ok(T && typeof T === 'object', '必须暴露 exports.__test')
  for (const name of ['computeRange', 'boundsOf', 'dayList', 'detectLang', 'interpolate', 'fmtNum', 'fmtPct', 'fmtToken', 'countdownText', 'toneOf', 'clamp', 'num', 'maybeNum', 'DICT_ZH', 'DICT_EN', 'providerKeyFlags', 'providerVisibility', 'opencodeState', 'opencodeWindowRows', 'opencodeBarsRow', 'opencodeLocalSummary', 'opencodeQuotaEstimates']) {
    assert.ok(T[name] !== undefined, '__test 缺少 ' + name)
  }
})

test('client：apply 注册三处槽位且参数符合契约', () => {
  const { ctx, state } = makeFakeCtx()
  loaded.exports.apply(ctx)

  assert.deepEqual(state.injections, EXPECTED_SLOTS, '三处 slots.inject 顺序与槽位名')
  const bySlot = new Map(state.registrations.map((item) => [item.options && item.options.name, item.options]))
  assert.equal(state.registrations.length, 3, '应注册 3 个组件')

  const panel = bySlot.get('sidebar.panellist')
  assert.ok(panel, '缺少 sidebar.panellist 注册')
  assert.equal(panel.id, 'ollama-statistical')
  assert.equal(panel.order, 30)
  assert.equal(typeof panel.label, 'function', 'panellist label 必须是 thunk')

  const main = bySlot.get('main')
  assert.ok(main, '缺少 main 注册')
  assert.equal(main.key, 'ollama-statistical', 'main key 必须与 panellist id 一致')

  const bars = bySlot.get('sidebar.footer.action')
  assert.ok(bars, '缺少 sidebar.footer.action 注册')
  assert.equal(bars.id, 'ollama-statistical-bars')
  assert.equal(typeof bars.label, 'function', 'bars label 必须是 thunk')

  for (const item of state.registrations) {
    assert.equal(typeof item.component, 'function', '每个槽位组件必须是函数')
  }
})

test('client：今天 / 本周（周一开始）/ 自定义 range 切片与求和', () => {
  const tokens = makeTokens()

  const today = T.computeRange(tokens, 'today')
  assert.equal(today.days.length, 1)
  assert.equal(today.days[0].date, '2026-10-23')
  assert.equal(today.agg.total, 29)
  assert.equal(today.agg.requests, 1)

  const week = T.computeRange(tokens, 'week')
  assert.equal(week.lo, '2026-10-19')
  assert.equal(week.hi, '2026-10-23')
  assert.equal(week.days.length, 5)
  assert.equal(week.agg.total, 25 + 26 + 27 + 28 + 29)
  assert.equal(week.agg.activeDays, 5)
  assert.equal(week.agg.sessions, 5)

  const custom = T.computeRange(tokens, 'custom', '2026-10-01', '2026-10-05')
  assert.equal(custom.days.length, 5)
  // 2026-09-24 是第 0 天 → 2026-10-01 是第 7 天
  assert.equal(custom.agg.total, 7 + 8 + 9 + 10 + 11)

  const swapped = T.computeRange(tokens, 'custom', '2026-10-05', '2026-10-01')
  assert.equal(swapped.agg.total, custom.agg.total, '起止颠倒应自动交换')

  const clamped = T.computeRange(tokens, 'custom', '2020-01-01', '2030-01-01')
  assert.equal(clamped.lo, tokens.days[0].date)
  assert.equal(clamped.hi, tokens.today)
  assert.equal(clamped.days.length, 30)
  assert.equal(clamped.agg.total, (29 * 30) / 2)
})

test('client：range 在空 / 缺字段 tokens 下安全退化', () => {
  // 注意：__test 函数在 vm realm 里创建数组，跨 realm 的 deepStrictEqual 会因原型不同失败，
  // 因此这里比较长度/数值而不是直接 deepEqual 数组。
  assert.equal(T.dayList(null).length, 0)
  assert.equal(T.dayList({ days: 'nope' }).length, 0)
  const empty = T.computeRange(null, 'today')
  assert.equal(empty.days.length, 0)
  assert.equal(empty.agg.total, 0)
  const noWeek = T.computeRange({ today: '2026-10-23', days: [] }, 'week')
  assert.equal(noWeek.agg.total, 0)
})

test('client：i18n 语言判定、插值、字典键对称', () => {
  assert.equal(T.detectLang({ getLocale: () => ({ active: 'zh-CN' }) }), 'zh')
  assert.equal(T.detectLang({ getLocale: () => ({ active: 'zh' }) }), 'zh')
  assert.equal(T.detectLang({ getLocale: () => ({ active: 'en-US' }) }), 'en')
  assert.equal(T.detectLang(undefined), 'zh', 'locale 缺失时默认中文')

  assert.equal(T.interpolate('a {n} b {missing}', { n: 2 }), 'a 2 b {missing}')
  assert.equal(T.interpolate('no params', undefined), 'no params')

  const zhKeys = Object.keys(T.DICT_ZH).sort()
  const enKeys = Object.keys(T.DICT_EN).sort()
  assert.deepEqual(zhKeys, enKeys, '中英字典键必须对称')
  assert.ok(zhKeys.length >= 100, '字典应覆盖全部文案，实际 ' + zhKeys.length)
  const emptyValues = zhKeys.filter((key) => typeof T.DICT_ZH[key] !== 'string' || T.DICT_ZH[key].trim() === '' || typeof T.DICT_EN[key] !== 'string' || T.DICT_EN[key].trim() === '')
  assert.deepEqual(emptyValues, [], '不允许空文案')

  // 5 小时窗口说明文案（会话限额卡副标题）必须中英齐备且带 {start} 占位符。
  for (const key of ['limits.sessionNote', 'limits.sessionNotePlain']) {
    assert.equal(typeof T.DICT_ZH[key], 'string', 'zh 缺少 ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', 'en 缺少 ' + key)
  }
  assert.ok(T.DICT_ZH['limits.sessionNote'].includes('{start}'), 'zh sessionNote 需要 {start} 占位符')
  assert.ok(T.DICT_EN['limits.sessionNote'].includes('{start}'), 'en sessionNote 需要 {start} 占位符')
  assert.ok(T.interpolate(T.DICT_ZH['limits.sessionNote'], { start: '10-23 17:00' }).includes('10-23 17:00'))
})

test('client：数字 / 百分比 / 紧凑数 / 时间格式化', () => {
  assert.equal(T.fmtNum(1234567, 'int', 'en'), '1,234,567')
  assert.equal(T.fmtPct(25.64, 'en'), '25.6%')
  assert.equal(T.fmtPct(null, 'en'), '—', '缺值不能显示 0%')
  assert.equal(T.fmtToken(324300000, 'en'), '324.3M')
  assert.equal(T.fmtToken(999, 'en'), '999')
  assert.equal(T.fmtUtcShort('2026-10-22T08:00:00.123456789Z'), '10-22 08:00')
  assert.equal(T.clamp(-5, 0, 100), 0)
  assert.equal(T.clamp(120, 0, 100), 100)
  assert.equal(T.num(null), 0, '求和路径 null 视为 0')
  assert.equal(T.maybeNum(null), null, '展示路径 null 必须保持 null')
  assert.equal(T.maybeNum('12.5'), 12.5)
})

test('client：阈值色与倒计时', () => {
  assert.equal(T.toneOf(null), 'idle')
  assert.equal(T.toneOf(10), 'ok')
  assert.equal(T.toneOf(70), 'warn')
  assert.equal(T.toneOf(89), 'warn')
  assert.equal(T.toneOf(90), 'error')
  assert.equal(T.toneOf(100), 'error')

  const t = (key) => key
  const future = new Date(Date.now() + (2 * 60 + 12) * 60 * 1000).toISOString()
  const text = T.countdownText(t, future)
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
  assert.equal(T.countdownText(t, 'not-a-date'), null)
  assert.equal(T.countdownText(t, null), null)
})

/* ══════════════════════════════════════════════════════════════
 * OpenCode Go（v0.8 增量）
 * ══════════════════════════════════════════════════════════════ */

test('client：OpenCode 三窗口行（rolling/weekly/monthly、clamp、缺窗口为 null）', () => {
  assert.equal(typeof T.opencodeWindowRows, 'function', '__test 缺少 opencodeWindowRows')
  const rows = T.opencodeWindowRows({
    configured: true,
    kind: 'go',
    key: { source: 'local-cli', masked: 'sk-****U61I' },
    usage: {
      rolling: { status: 'ok', usedPercent: 52, remainingPercent: 48, resetsAt: '2026-09-23T00:34:52.704Z' },
      weekly: { status: 'ok', usedPercent: 120, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: null,
    },
  })
  assert.equal(rows.length, 3, '固定三行：rolling / weekly / monthly')
  assert.equal(rows[0].key, 'rolling')
  assert.equal(rows[1].key, 'weekly')
  assert.equal(rows[2].key, 'monthly')
  assert.equal(rows[0].titleKey, 'opencode.rolling')
  assert.equal(rows[0].subKey, 'opencode.rollingSub')
  assert.equal(rows[0].usedPercent, 52)
  assert.equal(rows[0].remainingPercent, 48)
  assert.equal(rows[0].tone, 'ok')
  assert.equal(rows[0].status, 'ok')
  assert.equal(rows[0].resetsAt, '2026-09-23T00:34:52.704Z')
  assert.equal(rows[1].usedPercent, 100, 'usedPercent clamp 到 100')
  assert.equal(rows[1].remainingPercent, 0, 'remainingPercent 缺失时按 100 - used 反推')
  assert.equal(rows[1].tone, 'error')
  assert.equal(rows[2].present, false, '窗口为 null → 无数据行')
  assert.equal(rows[2].usedPercent, null, '缺窗口不能当成 0%')
  assert.equal(rows[2].remainingPercent, null)
  assert.equal(rows[2].tone, 'idle')
  assert.equal(rows[2].resetsAt, null)

  // 负数 clamp 到 0；remainingPercent 同样 clamp；字符串数字可解析
  const clamped = T.opencodeWindowRows({ kind: 'go', usage: { rolling: { usedPercent: -5, remainingPercent: 260 } } })
  assert.equal(clamped[0].usedPercent, 0)
  assert.equal(clamped[0].remainingPercent, 100)
  const parsed = T.opencodeWindowRows({ kind: 'go', usage: { rolling: { usedPercent: '52.5' } } })
  assert.equal(parsed[0].usedPercent, 52.5)

  // 旧 host 缺字段 / 空对象：固定三行全 null，不抛错
  for (const empty of [null, undefined, {}, { kind: 'none' }, { kind: 'go', usage: null }]) {
    const emptyRows = T.opencodeWindowRows(empty)
    assert.equal(emptyRows.length, 3)
    assert.equal(emptyRows[0].usedPercent, null)
    assert.equal(emptyRows[0].remainingPercent, null)
    assert.equal(emptyRows[0].tone, 'idle')
    assert.equal(emptyRows[2].usedPercent, null)
  }
})

test('client：OpenCode 侧栏汇总行取三窗口最大 usedPercent（无 Go 数据不出现）', () => {
  assert.equal(typeof T.opencodeBarsRow, 'function', '__test 缺少 opencodeBarsRow')
  const go = {
    configured: true,
    kind: 'go',
    key: { source: 'local-cli', masked: 'sk-****U61I' },
    usage: {
      rolling: { status: 'ok', usedPercent: 52, remainingPercent: 48, resetsAt: '2026-09-23T00:34:52.704Z' },
      weekly: { status: 'ok', usedPercent: 20, remainingPercent: 80, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: { status: 'ok', usedPercent: 61, remainingPercent: 39, resetsAt: '2026-09-25T14:30:41.000Z' },
    },
  }
  const row = T.opencodeBarsRow(go)
  assert.ok(row, 'kind=go 时应返回侧栏汇总行')
  assert.equal(row.key, 'opencode')
  assert.equal(row.windowKey, 'monthly', '取 usedPercent 最大的窗口')
  assert.equal(row.percent, 61)
  assert.equal(row.resetsAt, '2026-09-25T14:30:41.000Z')
  assert.equal(row.windows.length, 3)
  assert.equal(row.windows[0].key, 'rolling')
  assert.equal(row.windows[0].usedPercent, 52)
  assert.equal(row.windows[2].usedPercent, 61)

  // 只有一个窗口有值时也返回该窗口（其余窗口 usedPercent 为 null）
  const onlyRolling = { ...go, usage: { rolling: { usedPercent: 12 }, weekly: null, monthly: null } }
  const only = T.opencodeBarsRow(onlyRolling)
  assert.equal(only.percent, 12)
  assert.equal(only.windowKey, 'rolling')
  assert.equal(only.windows.length, 3)
  assert.equal(only.windows[1].usedPercent, null)
  assert.equal(only.windows[2].usedPercent, null)

  // 无 OpenCode Go 数据 → null（侧栏不出现该行）
  for (const empty of [
    null,
    undefined,
    {},
    { kind: 'none', configured: true },
    { kind: 'go', usage: null },
    { kind: 'go', usage: { rolling: null, weekly: null, monthly: null } },
    { kind: 'go', usage: { rolling: {} } },
  ]) {
    assert.equal(T.opencodeBarsRow(empty), null, '无 Go 数据不应产生侧栏行')
  }
})

test('client：OpenCode 本机 CLI 汇总（今天/本周/本月 + top3 模型 + 时区）', () => {
  assert.equal(typeof T.opencodeLocalSummary, 'function', '__test 缺少 opencodeLocalSummary')
  const local = {
    available: true,
    generatedAt: '2026-10-30T01:23:45.000Z',
    timeZone: 'Asia/Shanghai',
    today: '2026-10-30',
    windowDays: 30,
    totals: {
      today: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1200, requests: 2, sessions: 1, costUsd: 0.02 },
      week: { total: 6000, requests: 10, costUsd: 0.1 },
      month: { total: 36000, requests: 60, costUsd: 0.6 },
    },
    models: [
      { provider: 'opencode-go', model: 'small', total: 10 },
      { provider: 'opencode', model: 'big', total: 300 },
      { provider: 'opencode', model: 'mid', total: 100 },
      { provider: 'opencode', model: 'tiny', total: 1 },
    ],
  }
  const summary = T.opencodeLocalSummary(local)
  assert.ok(summary, '有 totals 时应返回本机用量汇总')
  assert.equal(summary.today.total, 1200)
  assert.equal(summary.today.requests, 2)
  assert.equal(summary.today.costUsd, 0.02)
  assert.equal(summary.week.total, 6000)
  assert.equal(summary.month.costUsd, 0.6)
  assert.equal(summary.timeZone, 'Asia/Shanghai')
  assert.equal(summary.windowDays, 30)
  assert.equal(summary.models.length, 3, 'title 里最多列 3 个模型')
  assert.equal(summary.models[0].model, 'big', '按 total 降序')
  assert.equal(summary.models[1].model, 'mid')
  assert.equal(summary.models[2].model, 'small')
  assert.equal(summary.models[2].provider, 'opencode-go')

  // 缺字段安全降级（不渲染、不抛错）
  assert.equal(T.opencodeLocalSummary(null), null)
  assert.equal(T.opencodeLocalSummary(undefined), null)
  assert.equal(T.opencodeLocalSummary({ available: false }), null)
  assert.equal(T.opencodeLocalSummary({}), null, '没有 totals 时不渲染')

  const partial = T.opencodeLocalSummary({ totals: { today: { total: 0, requests: 0, costUsd: 0 } } })
  assert.equal(partial.today.total, 0, '0 是合法值，不能当缺省')
  assert.equal(partial.week, null)
  assert.equal(partial.month, null)
  assert.equal(partial.models.length, 0)
  assert.equal(partial.windowDays, 30, 'windowDays 缺省 30')
  assert.equal(partial.timeZone, null)
  // 旧 host 没有 hours/days → 空数组（卡片会回退为单个日桶），不崩
  assert.equal(summary.hours.length, 0, '没有 hours → []')
  assert.equal(summary.days.length, 0, '没有 days → []')
  assert.equal(summary.todayDate, '2026-10-30', '日期边界透传')

  // v0.9.3：hours / days / 分项指标（输入/缓存读/输出）
  const withSeries = T.opencodeLocalSummary({
    ...local,
    today: '2026-10-30',
    weekStart: '2026-10-26',
    monthStart: '2026-10-01',
    hours: [
      { hour: '01', input: 10, output: 2, cacheRead: 1, total: 13, requests: 1, costUsd: 0.01 },
      { hour: '02', input: 20, output: 4, cacheRead: 2, total: 26, requests: 2, costUsd: 0.02 },
      { bad: true },
    ],
    days: [
      { date: '2026-10-30', total: 30, requests: 3 },
      { date: '2026-10-29', total: 20, requests: 2 },
      { total: 99 },
    ],
  })
  assert.equal(withSeries.todayDate, '2026-10-30')
  assert.equal(withSeries.weekStart, '2026-10-26')
  assert.equal(withSeries.monthStart, '2026-10-01')
  assert.equal(withSeries.hours.length, 3, '结构合法的小时桶保留（hour 缺省为空串）')
  assert.equal(withSeries.hours[0].hour, '01')
  assert.equal(withSeries.hours[0].total, 13)
  assert.equal(withSeries.hours[1].requests, 2)
  assert.equal(withSeries.hours[2].hour, '')
  assert.equal(withSeries.hours[2].total, 0, '缺字段按 0')
  assert.equal(withSeries.days.length, 2, '没有 date 的日桶丢弃')
  assert.equal(withSeries.days[0].date, '2026-10-30')
  assert.equal(withSeries.days[0].total, 30)
  assert.equal(withSeries.today.input, 1000, '分项指标透传：输入')
  assert.equal(withSeries.today.output, 200, '分项指标透传：输出')
  assert.equal(withSeries.today.cacheRead, 0, '分项指标透传：缓存读')
  assert.equal(withSeries.week.requests, 10)
})

test('client：opencodeQuotaEstimates 估算 rolling（最近 5 小时桶）/ weekly / monthly（v0.9.4）', () => {
  assert.equal(typeof T.opencodeQuotaEstimates, 'function', '__test 缺少 opencodeQuotaEstimates')

  // 24 个小时桶：total = 小时序号 × 100，方便断言 rolling 求和
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    total: hour * 100,
    requests: 1,
  }))
  const makeLocal = (overrides) => Object.assign({
    available: true,
    generatedAt: '2026-10-30T01:23:45.000Z', // Asia/Shanghai → 本地 09 点
    timeZone: 'Asia/Shanghai',
    today: '2026-10-30',
    weekStart: '2026-10-26',
    monthStart: '2026-10-01',
    windowDays: 30,
    hours,
    days: [{ date: '2026-10-30', total: 1200, requests: 2 }],
    totals: { today: { total: 1200 }, week: { total: 6000 }, month: { total: 36000 } },
    models: [],
  }, overrides)

  // 本地 09 点 → 汇总 05..09 = 500+600+700+800+900 = 3500
  const est = T.opencodeQuotaEstimates(makeLocal())
  assert.equal(est.rolling, 3500, 'rolling 汇总最近 5 个小时桶')
  assert.equal(est.weekly, 6000, 'weekly 用 totals.week.total')
  assert.equal(est.monthly, 36000, 'monthly 用 totals.month.total')

  // 同一时刻按 UTC 只有 01 点 → current < 4 → rolling 跳过（跨日窗口不完整）
  const utc = T.opencodeQuotaEstimates(makeLocal({ timeZone: 'UTC' }))
  assert.equal(utc.rolling, null, '当前本地小时 < 4 时不估算 rolling')
  assert.equal(utc.weekly, 6000)
  assert.equal(utc.monthly, 36000)

  // 本地 02 点（generatedAt 18:00Z 前一天 + Asia/Shanghai）→ 同样跳过
  const early = T.opencodeQuotaEstimates(makeLocal({ generatedAt: '2026-10-29T18:00:00.000Z' }))
  assert.equal(early.rolling, null)

  // 零用量：rolling 窗口桶全 0 → 0（不是 null）；weekly 0 也保留
  const zeros = T.opencodeQuotaEstimates(makeLocal({
    hours: hours.map((bucket) => ({ ...bucket, total: 0 })),
    totals: { today: { total: 0 }, week: { total: 0 }, month: { total: 0 } },
  }))
  assert.equal(zeros.rolling, 0, '窗口桶存在但为 0 → 0')
  assert.equal(zeros.weekly, 0)
  assert.equal(zeros.monthly, 0)

  // 缺 hours（旧 host）→ rolling null，weekly/monthly 仍可用
  const noHours = T.opencodeQuotaEstimates(makeLocal({ hours: undefined }))
  assert.equal(noHours.rolling, null, '没有 hours 不估算 rolling')
  assert.equal(noHours.weekly, 6000)

  // 最近 5 个小时桶一个都没有（只有其它小时的桶）→ null
  const otherOnly = T.opencodeQuotaEstimates(makeLocal({ hours: [{ hour: '00', total: 999 }] }))
  assert.equal(otherOnly.rolling, null)

  // 部分桶存在 → 用存在的桶求和（缺失按 0 处理）
  const partialHours = hours.map((bucket) => (bucket.hour === '05' || bucket.hour === '09' ? bucket : { ...bucket, total: undefined }))
  void partialHours
  const partial = T.opencodeQuotaEstimates(makeLocal({ hours: hours.filter((bucket) => bucket.hour === '05' || bucket.hour === '09') }))
  assert.equal(partial.rolling, 500 + 900, '缺失的小时桶按 0 计，存在的求和')

  // 无 local / 缺 totals / 非法 generatedAt
  for (const empty of [null, undefined, { available: false }, {}]) {
    const none = T.opencodeQuotaEstimates(empty)
    assert.equal(none.rolling, null)
    assert.equal(none.weekly, null)
    assert.equal(none.monthly, null)
  }
  const badTime = T.opencodeQuotaEstimates(makeLocal({ generatedAt: 'not-a-date' }))
  assert.equal(badTime.rolling, null, '非法 generatedAt → rolling null')
  assert.equal(badTime.weekly, 6000, 'weekly 不受影响')
})

test('client：OpenCode 字典键齐备（中英对称 / CLI Key 提示 / 标题提到 OpenCode）', () => {
  const keys = [
    'opencode.title', 'opencode.rolling', 'opencode.weekly', 'opencode.monthly',
    'opencode.rollingSub', 'opencode.weeklySub', 'opencode.monthlySub',
    'opencode.barTitle', 'opencode.barSub', 'opencode.placeholder', 'opencode.label',
    'opencode.changeTitle', 'opencode.changeSub', 'opencode.editKey', 'opencode.clearManual',
    'opencode.removeKey', 'opencode.removing', 'opencode.removeKeyHint', 'opencode.disabledHint',
    'opencode.restoreKey', 'opencode.restoring', 'opencode.restoreHint',
    'opencode.empty', 'opencode.emptyHint', 'opencode.failed', 'opencode.failedHint',
    'opencode.note', 'opencode.statusOk', 'opencode.statusWarn',
    'opencode.localTitle', 'opencode.localHint', 'opencode.localToday', 'opencode.localWeek',
    'opencode.localMonth', 'opencode.localMeta', 'opencode.localTitleAttr',
    'opencode.keySource', 'opencode.winShort.rolling', 'opencode.winShort.weekly', 'opencode.winShort.monthly',
    'bars.opencode', 'bars.opencodeDetail',
  ]
  for (const key of keys) {
    assert.equal(typeof T.DICT_ZH[key], 'string', 'zh 缺少 ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', 'en 缺少 ' + key)
    assert.ok(T.DICT_ZH[key].trim() !== '' && T.DICT_EN[key].trim() !== '', '文案不能为空：' + key)
  }
  // 无 key 引导必须提到 opencode CLI 登录文件（契约 §7.5）
  const authPath = '~/.local/share/opencode/auth.json'
  assert.ok(T.DICT_ZH['opencode.barSub'].includes(authPath), 'zh 无 key 提示应复用 opencode CLI 登录的 Key')
  assert.ok(T.DICT_EN['opencode.barSub'].includes(authPath), 'en 无 key 提示应复用 opencode CLI 登录的 Key')

  // v0.9：页面标题改为 Token 统计（不再含 OpenCode）；副标题说明 Key 可选、配置后显示限额。
  assert.equal(T.DICT_ZH['app.title'], 'Token 统计')
  assert.equal(T.DICT_EN['app.title'], 'Token stats')
  assert.doesNotMatch(T.DICT_ZH['app.title'], /OpenCode/, 'app.title 不再含 OpenCode')
  assert.doesNotMatch(T.DICT_EN['app.title'], /OpenCode/, 'app.title 不再含 OpenCode')
  assert.ok(T.DICT_ZH['app.subtitle'].includes('Ollama / OpenCode'), 'zh 副标题说明两个 provider')
  assert.ok(T.DICT_EN['app.subtitle'].includes('Ollama / OpenCode'), 'en 副标题说明两个 provider')
  assert.ok(T.DICT_ZH['app.subtitle'].includes('配置 Key'), 'zh 副标题说明配置 Key 后显示')
  assert.ok(T.DICT_EN['app.subtitle'].toLowerCase().includes('key'), 'en 副标题说明配置 Key 后显示')
  assert.equal(T.DICT_ZH['panel.label'], 'Token 统计', '侧栏菜单名应为 Token 统计')
  assert.equal(T.DICT_EN['panel.label'], 'Token stats')
  assert.equal(T.DICT_ZH['bars.label'], 'Token 统计', '侧栏底部组的 aria 名也统一为 Token 统计')
  assert.equal(T.DICT_EN['bars.label'], 'Token stats')

  // v0.9 新增：页头「配置 Key」按钮 + 内联面板文案
  for (const key of ['key.config', 'key.panelTitle', 'key.panelSub', 'key.ollamaBarTitle', 'key.ollamaBarSub', 'key.opencodeBarTitle', 'key.opencodeBarSub', 'key.close', 'key.panelHint']) {
    assert.equal(typeof T.DICT_ZH[key], 'string', 'zh 缺少 ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', 'en 缺少 ' + key)
    assert.ok(T.DICT_ZH[key].trim() !== '' && T.DICT_EN[key].trim() !== '', '文案不能为空：' + key)
  }
  assert.equal(T.DICT_ZH['key.config'], '配置 Key')
  assert.ok(T.DICT_ZH['key.panelSub'].includes('必填'), '面板副标题说明 Key 可选')

  // 三窗口卡：中文标题保持短（半宽卡片一行放得下），Rolling / Weekly / Monthly 放进副标题
  assert.equal(T.DICT_ZH['opencode.rolling'], '5 小时窗口')
  assert.equal(T.DICT_ZH['opencode.weekly'], '本周限额')
  assert.equal(T.DICT_ZH['opencode.monthly'], '本月限额')
  assert.equal(T.DICT_ZH['opencode.rollingSub'], '滚动 5 小时窗口（Rolling）')
  assert.equal(T.DICT_ZH['opencode.weeklySub'], '每周（Weekly）')
  assert.equal(T.DICT_ZH['opencode.monthlySub'], '订阅周期（Monthly）')
  assert.ok(T.DICT_EN['opencode.rolling'].includes('Rolling'), '英文标题保留 Rolling')
  assert.ok(T.DICT_ZH['opencode.localTitleAttr'].includes('{models}'), '本机用量 title 需要 top 模型占位符')
  assert.ok(T.DICT_ZH['opencode.localTitleAttr'].includes('{tz}'), '本机用量 title 需要时区占位符')

  // v0.9.1：插件级「移除 Key」/「恢复外部 Key」文案
  assert.equal(T.DICT_ZH['opencode.removeKey'], '移除 Key')
  assert.equal(T.DICT_EN['opencode.removeKey'], 'Remove key')
  assert.equal(T.DICT_ZH['opencode.restoreKey'], '恢复外部 Key')
  assert.equal(T.DICT_EN['opencode.restoreKey'], 'Restore external key')
  assert.ok(T.DICT_ZH['opencode.disabledHint'].includes('插件已移除该 Key'), 'zh 停用说明')
  assert.ok(T.DICT_ZH['opencode.disabledHint'].includes('环境变量'), 'zh 停用说明强调外部配置未删除')
  assert.ok(T.DICT_ZH['opencode.restoreHint'].includes('粘贴新 Key'), 'zh 恢复说明提示粘贴新 Key 也可恢复')
  assert.ok(T.DICT_EN['opencode.disabledHint'].includes('environment variable'), 'en 停用说明')
  assert.ok(T.DICT_EN['opencode.removeKeyHint'].toLowerCase().includes('not deleted'), 'en 移除说明强调不删除外部配置')

  // v0.9.2：provider 显示开关文案
  for (const key of ['visibility.label', 'visibility.ollama', 'visibility.opencode', 'visibility.hint', 'visibility.toggleOn', 'visibility.toggleOff']) {
    assert.equal(typeof T.DICT_ZH[key], 'string', 'zh 缺少 ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', 'en 缺少 ' + key)
    assert.ok(T.DICT_ZH[key].trim() !== '' && T.DICT_EN[key].trim() !== '', '文案不能为空：' + key)
  }
  assert.equal(T.DICT_ZH['visibility.ollama'], 'Ollama')
  assert.equal(T.DICT_ZH['visibility.opencode'], 'OpenCode')
  assert.equal(T.DICT_EN['visibility.ollama'], 'Ollama')
  assert.equal(T.DICT_EN['visibility.opencode'], 'OpenCode')
  assert.ok(T.DICT_ZH['visibility.hint'].includes('不会删除任何 Key'), 'zh 提示不删除 Key')
  assert.ok(T.DICT_EN['visibility.hint'].toLowerCase().includes('no key is deleted'), 'en 提示不删除 Key')
  assert.equal(T.interpolate(T.DICT_ZH['visibility.toggleOn'], { provider: 'Ollama' }), '已显示：点击隐藏 Ollama')

  // v0.9.3：本机 CLI 用量三卡文案
  for (const key of ['opencode.localTokenUnit', 'opencode.localCost', 'opencode.localRange', 'opencode.localNote']) {
    assert.equal(typeof T.DICT_ZH[key], 'string', 'zh 缺少 ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', 'en 缺少 ' + key)
    assert.ok(T.DICT_ZH[key].trim() !== '' && T.DICT_EN[key].trim() !== '', '文案不能为空：' + key)
  }
  assert.equal(T.DICT_ZH['opencode.localTokenUnit'], 'Token')
  assert.equal(T.DICT_ZH['opencode.localCost'], '费用')
  assert.equal(T.DICT_EN['opencode.localCost'], 'Cost')
  assert.equal(T.interpolate(T.DICT_ZH['opencode.localRange'], { from: '2026-10-01', to: '2026-10-30' }), '2026-10-01 — 2026-10-30')
  assert.ok(T.DICT_ZH['opencode.localNote'].includes('来自本机 opencode.db'), 'zh 底部口径说明')
  assert.ok(T.DICT_EN['opencode.localNote'].toLowerCase().includes('local opencode.db'), 'en 底部口径说明')

  // v0.9.4：额度卡估算说明
  assert.equal(typeof T.DICT_ZH['opencode.estimateHint'], 'string', 'zh 缺少 opencode.estimateHint')
  assert.equal(typeof T.DICT_EN['opencode.estimateHint'], 'string', 'en 缺少 opencode.estimateHint')
  assert.ok(T.DICT_ZH['opencode.estimateHint'].includes('本机 opencode.db'), 'zh 说明估算来源')
  assert.ok(T.DICT_ZH['opencode.estimateHint'].includes('不是官方额度'), 'zh 说明估算口径不是官方')
  assert.ok(T.DICT_ZH['opencode.estimateHint'].includes('最近 5 个本机小时桶'), 'zh 说明滚动 5h 近似')
  assert.ok(T.DICT_EN['opencode.estimateHint'].includes('local opencode.db'), 'en 说明估算来源')
  assert.ok(T.DICT_EN['opencode.estimateHint'].toLowerCase().includes('not the official quota'), 'en 说明估算口径不是官方')
})

test('client：providerKeyFlags 判定 Ollama / OpenCode Key 是否已配置（v0.9）', () => {
  assert.equal(typeof T.providerKeyFlags, 'function', '__test 缺少 providerKeyFlags')

  // 两个都有 → A 区两栏、C 区渲染、页头不出现「配置 Key」
  const both = T.providerKeyFlags({
    key: { source: 'credentials', masked: '****cWjS' },
    opencode: { key: { source: 'local-cli', masked: 'sk-****U61I' } },
  })
  assert.equal(both.hasOllamaKey, true)
  assert.equal(both.hasOpenCodeKey, true)
  assert.equal(both.anyKey, true)
  assert.equal(both.missingOllama, false)
  assert.equal(both.missingOpenCode, false)
  assert.equal(both.showConfig, false, '两个都已配置时不显示配置入口')

  // 仅 Ollama
  const onlyOllama = T.providerKeyFlags({ key: { source: 'env', masked: '****1fdd' } })
  assert.equal(onlyOllama.hasOllamaKey, true)
  assert.equal(onlyOllama.hasOpenCodeKey, false, '缺 opencode 字段按未配置处理')
  assert.equal(onlyOllama.missingOpenCode, true)
  assert.equal(onlyOllama.showConfig, true)

  // 仅 OpenCode
  const onlyOpencode = T.providerKeyFlags({
    key: { source: 'none', masked: null },
    opencode: { key: { source: 'manual', masked: 'sk-****U61I' } },
  })
  assert.equal(onlyOpencode.hasOllamaKey, false)
  assert.equal(onlyOpencode.hasOpenCodeKey, true)
  assert.equal(onlyOpencode.missingOllama, true)
  assert.equal(onlyOpencode.showConfig, true)

  // 都没有 / 空 snapshot / 旧 host 缺字段：不崩，全部未配置
  for (const empty of [null, undefined, {}, { key: null }, { key: { source: 'none' } }, { key: { source: 'none', masked: null }, opencode: null }]) {
    const flags = T.providerKeyFlags(empty)
    assert.equal(flags.hasOllamaKey, false, 'source=none / 缺 key → 未配置')
    assert.equal(flags.hasOpenCodeKey, false)
    assert.equal(flags.anyKey, false)
    assert.equal(flags.showConfig, true)
  }

  // opencode.key.source = 'none'（有 key 对象但未配置）→ false
  const noneOc = T.providerKeyFlags({ opencode: { key: { source: 'none', masked: null }, configured: false } })
  assert.equal(noneOc.hasOpenCodeKey, false)
})

test('client：providerVisibility 显示开关归一化（v0.9.2，缺字段默认显示）', () => {
  assert.equal(typeof T.providerVisibility, 'function', '__test 缺少 providerVisibility')

  // 旧 host 缺字段 / 非对象 / null → 两个都显示
  for (const empty of [null, undefined, {}, { visibility: null }, { visibility: 'nope' }, { visibility: 42 }]) {
    const flags = T.providerVisibility(empty)
    assert.equal(flags.ollama, true, '缺 visibility 字段 → Ollama 默认显示')
    assert.equal(flags.opencode, true, '缺 visibility 字段 → OpenCode 默认显示')
  }

  const onlyOllama = T.providerVisibility({ visibility: { ollama: true, opencode: false } })
  assert.equal(onlyOllama.ollama, true)
  assert.equal(onlyOllama.opencode, false)
  const onlyOpencode = T.providerVisibility({ visibility: { ollama: false, opencode: true } })
  assert.equal(onlyOpencode.ollama, false)
  assert.equal(onlyOpencode.opencode, true)
  const bothOff = T.providerVisibility({ visibility: { ollama: false, opencode: false } })
  assert.equal(bothOff.ollama, false)
  assert.equal(bothOff.opencode, false)

  // 只有显式 false 才算关闭；缺字段 / 非布尔脏值 → 保持显示
  const partial = T.providerVisibility({ visibility: { opencode: false } })
  assert.equal(partial.ollama, true, '缺 ollama 字段 → 显示')
  assert.equal(partial.opencode, false)
  const dirty = T.providerVisibility({ visibility: { ollama: 'no', opencode: 0 } })
  assert.equal(dirty.ollama, true, '非布尔值不当作关闭')
  assert.equal(dirty.opencode, true)
})

test('client：OpenCode 插件级移除（disabled）识别与默认值（v0.9.1）', () => {
  // opencodeState.disabled：缺字段 / 旧 host / null 一律 false
  assert.equal(T.opencodeState(null).disabled, false)
  assert.equal(T.opencodeState({}).disabled, false, '缺 disabled 字段默认 false')
  assert.equal(T.opencodeState({ disabled: 'yes' }).disabled, false, '非布尔值不当作 true')
  const state = T.opencodeState({
    configured: false,
    disabled: true,
    key: { source: 'none', masked: null },
    kind: 'none',
    usage: null,
    local: null,
  })
  assert.equal(state.disabled, true)
  assert.equal(state.configured, false)
  assert.equal(state.key.source, 'none')

  // providerKeyFlags：disabled 不改变 hasOpenCodeKey（仍只看 key.source），额外透出 opencodeDisabled
  const flags = T.providerKeyFlags({
    key: { source: 'credentials', masked: '****cWjS' },
    opencode: { configured: false, disabled: true, key: { source: 'none', masked: null }, kind: 'none' },
  })
  assert.equal(flags.hasOpenCodeKey, false)
  assert.equal(flags.opencodeDisabled, true, 'KeyPanel 需要 disabled 标志来显示「恢复外部 Key」')
  assert.equal(flags.missingOpenCode, true)
  assert.equal(flags.showConfig, true)
  assert.equal(flags.hasOllamaKey, true)

  const normal = T.providerKeyFlags({ key: { source: 'credentials' }, opencode: { key: { source: 'local-cli' } } })
  assert.equal(normal.opencodeDisabled, false, '已配置时默认未停用')
  assert.equal(normal.hasOpenCodeKey, true)
})
