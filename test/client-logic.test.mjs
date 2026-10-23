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
    provider: 'ollama',
    today: '2026-10-23',
    weekStart: '2026-10-19',
    windowDays: 30,
    timeZone: 'Asia/Shanghai',
    days,
    models: [],
    scan: { sessions: 2, candidates: 2, scanned: 2, fromCache: 0, covered: 2, pending: 0, elapsedMs: 1, partial: false },
  }
}

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
