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
    // 今天 24 小时桶：第 i 小时 total=i（用于小时图断言）
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour: String(hour).padStart(2, '0'),
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
  for (const name of ['computeRange', 'boundsOf', 'dayList', 'detectLang', 'interpolate', 'fmtNum', 'fmtPct', 'fmtToken', 'countdownText', 'toneOf', 'clamp', 'num', 'maybeNum', 'DICT_ZH', 'DICT_EN']) {
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
