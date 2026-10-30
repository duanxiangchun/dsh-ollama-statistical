import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

/**
 * 渲染级冒烟：用真实 client.js + 迷你 React（hooks/effects 语义够用）把主页面与侧栏组件渲染一遍。
 * 目的是抓「单元测试覆盖不到、但真实 React 会直接白屏」的运行时错误
 * （典型：在声明前引用 const/let，TDZ ReferenceError；条件 hooks；访问 undefined 属性等）。
 */

const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeOpencodeFixture() {
  const days = []
  for (let index = 0; index < 30; index += 1) {
    days.push({
      date: '2026-10-' + String(index + 1).padStart(2, '0'),
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 1200,
      requests: 2,
      sessions: 1,
      costUsd: 0.02,
    })
  }
  const bucket = (dayCount) => ({
    input: 1000 * dayCount,
    output: 200 * dayCount,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 1200 * dayCount,
    requests: 2 * dayCount,
    sessions: 1,
    costUsd: Math.round(0.02 * dayCount * 1000000) / 1000000,
  })
  // v0.9.3：local.hours —— 今天本地 24 个小时桶（每根 total=50，合计 1200）
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    input: 40,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 50,
    requests: 2,
    costUsd: 0.0008,
  }))
  return {
    configured: true,
    key: { source: 'local-cli', masked: 'sk-****U61I' },
    kind: 'go',
    disabled: false,
    fetchedAt: '2026-10-30T01:23:45.000Z',
    note: null,
    usage: {
      rolling: { status: 'ok', usedPercent: 52, remainingPercent: 48, resetsAt: '2026-10-30T06:00:00.000Z' },
      weekly: { status: 'ok', usedPercent: 20, remainingPercent: 80, resetsAt: '2026-11-02T00:00:00.000Z' },
      monthly: { status: 'ok', usedPercent: 61, remainingPercent: 39, resetsAt: '2026-11-01T00:00:00.000Z' },
    },
    local: {
      available: true,
      generatedAt: '2026-10-30T01:23:45.000Z',
      timeZone: 'Asia/Shanghai',
      today: '2026-10-30',
      weekStart: '2026-10-26',
      monthStart: '2026-10-01',
      windowDays: 30,
      days,
      hours,
      totals: { today: bucket(1), week: bucket(5), month: bucket(30) },
      models: [
        { provider: 'opencode-go', model: 'deepseek-v4-flash', total: 36000, requests: 60, costUsd: 0.6 },
        { provider: 'opencode', model: 'claude-sonnet-4', total: 12000, requests: 20, costUsd: 0.2 },
        { provider: 'opencode', model: 'gpt-5', total: 6000, requests: 10, costUsd: 0.1 },
      ],
      scan: { messages: 120, matched: 90, elapsedMs: 3, truncated: false },
    },
  }
}

function makeFixtureSnapshot() {
  const days = []
  for (let index = 0; index < 30; index += 1) {
    const date = '2026-10-' + String(index + 1).padStart(2, '0')
    days.push({
      date,
      input: 1000 + index,
      output: 100,
      cacheRead: 5000,
      cacheWrite: 0,
      reasoning: 0,
      total: 6100 + index,
      requests: 3,
      sessions: 1,
    })
  }
  const today = days[days.length - 1].date
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    input: 100,
    output: 10,
    cacheRead: 500,
    cacheWrite: 0,
    reasoning: 0,
    total: 610,
    requests: 1,
    sessions: 1,
  }))
  const models = [
    {
      provider: 'ollama',
      model: 'deepseek-v4.1-flash',
      input: 20000,
      output: 2000,
      cacheRead: 100000,
      cacheWrite: 0,
      reasoning: 0,
      total: 122000,
      requests: 30,
      days: days.map((day) => ({ date: day.date, total: day.total, requests: day.requests })),
    },
  ]
  const providerDays = days.map((day) => ({ ...day }))
  return {
    version: 1,
    updatedAt: '2026-10-30T12:00:00.000Z',
    cached: false,
    key: { source: 'dsh', masked: '****cWjS', sources: {} },
    limits: {
      kind: 'legacy',
      session: { usedPercent: 42.5, remainingPercent: 57.5, resetsAt: '2026-10-30T17:00:00.000Z' },
      weekly: { usedPercent: 88.2, remainingPercent: 11.8, resetsAt: '2026-11-02T00:00:00.000Z' },
    },
    official: { fetchedAt: '2026-10-30T12:00:00.000Z', range24h: null, range7d: null, range30d: null },
    tokens: {
      scope: 'all-providers',
      today,
      weekStart: '2026-10-26',
      windowDays: 30,
      timeZone: 'Asia/Shanghai',
      hours,
      days,
      providers: [
        {
          provider: 'ollama',
          input: 20000,
          output: 2000,
          cacheRead: 100000,
          cacheWrite: 0,
          reasoning: 0,
          total: 122000,
          requests: 30,
          sessions: 3,
          models,
          days: providerDays,
          hours,
        },
      ],
      models,
      scan: { sessions: 3, candidates: 3, scanned: 3, fromCache: 0, covered: 3, failed: 2, retired: 0, pending: 0, elapsedMs: 5, partial: false },
    },
    errors: [],
    opencode: makeOpencodeFixture(),
  }
}

function createMiniReact() {
  const hookStore = new Map()
  let currentPath = 'root'
  let hookIndex = 0
  let pendingEffects = []
  let dirty = false
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    Fragment: 'fragment',
    useState(initial) {
      const key = currentPath + '|' + hookIndex + '|state'
      hookIndex += 1
      if (!hookStore.has(key)) hookStore.set(key, typeof initial === 'function' ? initial() : initial)
      const set = (value) => {
        const prev = hookStore.get(key)
        const next = typeof value === 'function' ? value(prev) : value
        if (next !== prev) {
          hookStore.set(key, next)
          dirty = true
        }
      }
      return [hookStore.get(key), set]
    },
    useEffect(fn) {
      pendingEffects.push(fn)
    },
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      const key = currentPath + '|' + hookIndex + '|ref'
      hookIndex += 1
      if (!hookStore.has(key)) hookStore.set(key, { current: initial })
      return hookStore.get(key)
    },
  }

  function render(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => render(child, path + '#' + index))
    if (typeof node.type === 'function') {
      const savedPath = currentPath
      const savedIndex = hookIndex
      currentPath = path
      hookIndex = 0
      let out
      try {
        out = node.type(node.props)
      } finally {
        currentPath = savedPath
        hookIndex = savedIndex
      }
      return render(out, path + '>' + (node.type.name || 'C'))
    }
    if (node.type === 'fragment') {
      return node.children.map((child, index) => render(child, path + '#' + index))
    }
    const kids = []
    if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => {
        if (Array.isArray(child)) child.forEach((c, i) => kids.push(render(c, path + '#' + index + '.' + i)))
        else kids.push(render(child, path + '#' + index))
      })
    }
    return { type: node.type, props: node.props, children: kids }
  }

  async function renderLoop(component, props) {
    dirty = false
    currentPath = 'root'
    hookIndex = 0
    const node = React.createElement(component, props)
    let tree = null
    for (let pass = 0; pass < 10; pass += 1) {
      pendingEffects = []
      hookIndex = 0
      currentPath = 'root'
      tree = render(node, 'root')
      const effects = pendingEffects.slice()
      pendingEffects = []
      for (const effect of effects) effect()
      // RPC 是 Promise（microtask），让它有机会触发 setState，再决定是否需要重渲染
      await tick()
      if (!dirty) break
      dirty = false
    }
    return tree
  }

  return {
    React,
    async renderTree(component, props) {
      hookStore.clear()
      return renderLoop(component, props)
    },
    /** 交互后重渲染：保留 hookStore，模拟 setState（如点击「配置 Key」展开面板）。 */
    async rerenderTree(component, props) {
      return renderLoop(component, props)
    },
  }
}

async function loadAndRender(snapshot, options = {}) {
  const mini = createMiniReact()
  const captured = {}
  const documentMock = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {}, style: {}, parentNode: null }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const sandbox = {
    console,
    Intl,
    Date,
    JSON,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    document: documentMock,
    globalThis: null,
    window: {
      __ModuleLoader__: { load(def) { captured.def = def } },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    },
    require(id) {
      if (id === 'react') return mini.React
      throw new Error('unexpected require ' + id)
    },
  }
  sandbox.globalThis = sandbox
  runInContext(BUNDLE, createContext(sandbox), { filename: 'client.js' })
  const exports = captured.def.factory(sandbox.require)

  const registrations = []
  const rpcCalls = []
  let snapshotCalls = 0
  const services = {
    slots: {
      inject(name, factory) { registrations.push({ name, factory }) },
      register(slot, component) { return component },
    },
    connection: {
      rpc: {
        call(channel, method, payload) {
          rpcCalls.push({ method, payload })
          if (method === 'snapshot') {
            snapshotCalls += 1
            // freezeSnapshot：首次 snapshot 之后不再返回新值（用于断言乐观更新/回滚不被轮询覆盖）。
            if (options.freezeSnapshot && snapshotCalls > 1) return new Promise(() => {})
            if (options.snapshotError) return Promise.resolve({ ok: false, error: options.snapshotError })
            return Promise.resolve({ ok: true, value: snapshot })
          }
          if (method === 'auth-state') return Promise.resolve({ ok: true, value: { source: 'dsh' } })
          if (method === 'clear-key') {
            if (options.clearKeyResult) return Promise.resolve(options.clearKeyResult)
            return Promise.resolve({ ok: true, value: { cleared: true } })
          }
          if (method === 'set-visibility') {
            if (options.visibilityError) return Promise.resolve({ ok: false, error: options.visibilityError })
            // 模拟 host：持久化 visibility，后续 snapshot 返回同样的值。
            const current = snapshot !== null && snapshot !== undefined && typeof snapshot === 'object' ? snapshot : {}
            const base = current.visibility !== null && current.visibility !== undefined && typeof current.visibility === 'object'
              ? current.visibility
              : {}
            const merged = Object.assign({ ollama: true, opencode: true }, base, payload !== null && typeof payload === 'object' ? payload : {})
            current.visibility = {
              ollama: merged.ollama !== false,
              opencode: merged.opencode !== false,
            }
            return Promise.resolve({ ok: true, value: { visibility: current.visibility } })
          }
          return Promise.resolve({ ok: true, value: {} })
        },
      },
    },
    timer: {},
    locale: { current: 'zh', subscribe: () => () => {} },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) { return fn() },
    interval: () => () => {},
    on: () => () => {},
  }
  exports.apply(ctx)

  const rendered = {}
  for (const registration of registrations) {
    const component = typeof registration.factory === 'function' ? registration.factory() : registration.component
    assert.equal(typeof component, 'function', 'slot ' + registration.name + ' 应注册为组件')
    rendered[registration.name] = await mini.renderTree(component, {})
  }
  // 测试辅助：记录过的 RPC 调用（断言 clear-key 的 provider/mode 等 payload）。
  rendered.__calls = rpcCalls
  // 测试辅助：按槽位在保留状态的前提下重渲染（用于交互后的断言）。
  rendered.__rerender = async (slotName) => {
    const registration = registrations.find((item) => item.name === slotName)
    const component = typeof registration.factory === 'function' ? registration.factory() : registration.component
    return mini.rerenderTree(component, {})
  }
  return rendered
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.children) collectText(node.children, out)
  return out
}

/** 在渲染树里按 className（可含多个类）查找节点，用于断言结构而不只是文本。 */
function findByClass(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, className, out)
    return out
  }
  const raw = node.props && typeof node.props.className === 'string' ? node.props.className : ''
  if (raw.split(/\s+/).includes(className)) out.push(node)
  if (node.children) findByClass(node.children, className, out)
  return out
}

test('渲染冒烟：主页面 / 侧栏组件能用真实快照渲染且不抛异常（防白屏）', async () => {
  const snapshot = makeFixtureSnapshot()
  const rendered = await loadAndRender(snapshot)
  assert.ok(rendered.main, 'main 槽位应已注册')
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama/, '主页面应渲染标题')
  assert.match(mainText, /估算总量/, '周卡应渲染紧凑的 token 额度估算')
  assert.match(mainText, /读取失败/, '应渲染失败会话提示')
  assert.match(mainText, /×/, '失败提示应带忽略按钮')
  const footerText = collectText(rendered['sidebar.footer.action']).join(' ')
  assert.match(footerText, /会话 5h/, '侧栏横条应渲染会话用量')
  assert.ok(rendered['sidebar.panellist'], '侧栏图标槽位应已注册')
  // v0.9：两个 Key 都已配置 → 页头不显示「配置 Key」，也没有内联配置面板。
  assert.ok(!buttonLabels(rendered.main).includes('配置 Key'), '两个 Key 都已配置时不显示配置入口')
  assert.equal(findByClass(rendered.main, 'osta-keypanel').length, 0, '配置面板默认不渲染')
})

test('渲染冒烟：无 key / 空 tokens 的降级快照也能渲染', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.key = { source: 'none', masked: null, sources: {} }
  snapshot.limits = { kind: 'none' }
  snapshot.tokens = null
  snapshot.official = null
  snapshot.errors = [{ source: 'balance', code: 'no-key', message: 'no key' }]
  const rendered = await loadAndRender(snapshot)
  const text = collectText(rendered.main).join(' ')
  assert.match(text, /Ollama/, '主页面仍应渲染')
})

/** 在渲染树里找所有密码输入框（Key 表单），用于断言 input id 唯一。 */
/** 在渲染树里找所有 <button>，用于断言「配置 Key」入口是否出现。 */
function findButtons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  if (node.children) findButtons(node.children, out)
  return out
}

function buttonLabels(node) {
  return findButtons(node).map((button) => collectText(button).join(' ').trim())
}

function findPasswordInputs(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findPasswordInputs(child, out)
    return out
  }
  if (node.props && node.props.type === 'password') out.push(node)
  if (node.children) findPasswordInputs(node.children, out)
  return out
}

test('渲染冒烟：A 区左右两组 + OpenCode 三窗口卡 + 本机 CLI 条 + 侧栏汇总行', async () => {
  const snapshot = makeFixtureSnapshot()
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama 限额/, '左侧应渲染 Ollama 限额区')
  assert.match(mainText, /OpenCode Go 限额/, '右侧应渲染 OpenCode Go 限额区')
  assert.match(mainText, /5 小时窗口/, '应渲染 rolling 卡标题')
  assert.match(mainText, /本周限额/, '应渲染 weekly 卡标题')
  assert.match(mainText, /本月限额/, '应渲染 monthly 卡标题')
  assert.match(mainText, /滚动 5 小时窗口（Rolling）/, 'rolling 卡副标题保留 Rolling')
  assert.match(mainText, /每周（Weekly）/, 'weekly 卡副标题保留 Weekly')
  assert.match(mainText, /订阅周期（Monthly）/, 'monthly 卡副标题保留 Monthly')
  assert.match(mainText, /本机 opencode CLI 用量/, '应渲染本机 CLI 用量条')

  // A 区：一个左右分组容器 → 两个 osta-col（左 Ollama / 右 OpenCode）
  const pairs = findByClass(rendered.main, 'osta-limits-pair')
  assert.equal(pairs.length, 1, 'A 区只应有一个左右分组容器')
  const columns = (pairs[0].children || []).filter((child) => child && child.props && typeof child.props.className === 'string' && child.props.className.split(/\s+/).includes('osta-col'))
  assert.equal(columns.length, 2, 'A 区应左右两列')
  assert.match(collectText(columns[0]).join(' '), /Ollama 限额/, '左列是 Ollama 限额')
  assert.match(collectText(columns[1]).join(' '), /OpenCode Go 限额/, '右列是 OpenCode 限额')

  // OpenCode 三张卡复用 LimitCard
  const grids = findByClass(rendered.main, 'osta-oc-grid')
  assert.equal(grids.length, 1, '三张窗口卡应共用一个网格')
  assert.equal(grids[0].children.length, 3, '应有 rolling/weekly/monthly 三张卡')

  // v0.9.3：本机 CLI 用量改成全宽三卡（A 区之后 / B 区之前），旧单行 strip 不再渲染
  const localSection = findByClass(rendered.main, 'osta-oc-local-section')
  assert.equal(localSection.length, 1, '应渲染本机 opencode CLI 用量区（全宽）')
  assert.equal(findByClass(rendered.main, 'osta-oc-local').length, 0, '旧单行 strip 已移除')
  assert.equal(findByClass(rendered.main, 'osta-oc-local-cell').length, 0, '旧单行 cell 已移除')
  assert.equal(findByClass(localSection[0], 'osta-card').length, 3, '今天/本周/本月三张卡')
  assert.equal(findByClass(localSection[0], 'osta-spark').length, 3, '每张卡一个 sparkline')

  // 侧栏：Ollama 两行保留 + OpenCode Go 汇总行（取最大 61%）
  const bars = rendered['sidebar.footer.action']
  const rows = findByClass(bars, 'osta-barsrow')
  assert.equal(rows.length, 3, '侧栏应有 Ollama 两行 + OpenCode 一行')
  const opencodeRow = rows.find((row) => row.props && row.props.key === 'opencode')
  assert.ok(opencodeRow, '侧栏应有 OpenCode Go 汇总行')
  const rowText = collectText(opencodeRow).join(' ')
  assert.match(rowText, /OpenCode Go/)
  assert.match(rowText, /61%/, '取 rolling/weekly/monthly 中最大 usedPercent')
  const barsRoot = findByClass(bars, 'osta-bars')[0]
  assert.ok(barsRoot.props.title.includes('5h 52%'), 'title 应列出 rolling 百分比')
  assert.ok(barsRoot.props.title.includes('周 20%'), 'title 应列出 weekly 百分比')
  assert.ok(barsRoot.props.title.includes('月 61%'), 'title 应列出 monthly 百分比')

  // v0.9.2：页头两个显示开关默认都开（fixture 没有 visibility 字段 = 旧 host 行为）
  const toggleButtons = findByClass(rendered.main, 'osta-toggle')
  assert.equal(toggleButtons.length, 2, '页头应有 Ollama / OpenCode 两个显示开关')
  const toggleTexts = toggleButtons.map((node) => collectText(node).join(' ').trim())
  assert.ok(toggleTexts.includes('Ollama'), '应有 Ollama 开关')
  assert.ok(toggleTexts.includes('OpenCode'), '应有 OpenCode 开关')
  for (const toggle of toggleButtons) assert.equal(toggle.props['aria-pressed'], 'true', '默认两个都开')

  // v0.9.1：已配置时（任何 source，这里是 local-cli）标题右侧有「移除 Key」；
  // 点击走 clear-key {provider:'opencode', mode:'disable'}（插件级停用）。
  const removeButtons = findButtons(rendered.main).filter((button) => collectText(button).join(' ').trim() === '移除 Key')
  assert.equal(removeButtons.length, 1, '已配置 OpenCode 时应显示「移除 Key」按钮')
  removeButtons[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const clearCall = rendered.__calls.filter((call) => call.method === 'clear-key').pop()
  assert.ok(clearCall, '点击「移除 Key」应调用 clear-key')
  assert.equal(clearCall.payload.provider, 'opencode')
  assert.equal(clearCall.payload.mode, 'disable', '移除 Key 必须带 mode:disable')
})

test('渲染冒烟：本机 OpenCode 用量三卡（小时/日 sparkline、大数字、日期范围、mini 指标）', async () => {
  const snapshot = makeFixtureSnapshot()
  const rendered = await loadAndRender(snapshot)
  const section = findByClass(rendered.main, 'osta-oc-local-section')[0]
  assert.ok(section, '应渲染本机 opencode CLI 用量区')
  const text = collectText(section).join(' ')
  assert.match(text, /本机 opencode CLI 用量/)
  assert.match(text, /近 30 天 · 时区 Asia\/Shanghai/, 'SectionHead meta 显示窗口/时区')
  assert.match(text, /来自本机 opencode\.db/, '卡片底部口径说明')
  assert.match(text, /与 DSH 会话日志/, '说明与 DSH token 统计口径不同')
  assert.match(text, /2026-10-30/, '今天日期范围')
  assert.match(text, /2026-10-26 — 2026-10-30/, '本周日期范围')
  assert.match(text, /2026-10-01 — 2026-10-30/, '本月日期范围')
  for (const label of ['今天', '本周', '本月', '输入', '缓存读', '输出', '费用']) {
    assert.ok(text.includes(label), '应包含 ' + label)
  }

  const cards = findByClass(section, 'osta-card')
  assert.equal(cards.length, 3, '今天/本周/本月三张卡')
  const nums = findByClass(section, 'osta-official-num').map((node) => collectText(node).join(' '))
  assert.equal(nums.length, 3)
  assert.equal(nums[0], '1,200', '今天大数字 = totals.today.total')
  assert.equal(nums[1], '6,000', '本周大数字 = totals.week.total')
  assert.equal(nums[2], '36,000', '本月大数字 = totals.month.total')
  const units = findByClass(section, 'osta-total-unit').map((node) => collectText(node).join(' '))
  assert.equal(units.length, 3)
  for (const unit of units) assert.equal(unit, 'Token', '单位 Token')

  const sparks = findByClass(section, 'osta-spark')
  assert.equal(sparks.length, 3, '三张卡各有一个 sparkline')
  assert.equal(sparks[0].children.length, 24, '今天用 local.hours 的 24 个小时桶')
  assert.equal(sparks[1].children.length, 5, '本周用周窗口的 5 个日桶')
  assert.equal(sparks[2].children.length, 30, '本月用月窗口的 30 个日桶')
  // mini 指标：每张卡 输入/缓存读/输出/费用
  const mini = findByClass(section, 'osta-mini')
  assert.equal(mini.length, 12, '三张卡 × 4 个 mini 指标')
  const miniLabels = mini.map((node) => collectText(node).join(' '))
  for (const label of ['输入', '缓存读', '输出', '费用']) {
    assert.equal(miniLabels.filter((text2) => text2.startsWith(label)).length, 3, label + ' 应出现 3 次')
  }
  assert.match(collectText(section).join(' '), /\$/, '费用用 USD 展示')
})

test('渲染冒烟：旧 host 无 local.hours 时今天回退为单个日桶', async () => {
  const snapshot = makeFixtureSnapshot()
  delete snapshot.opencode.local.hours
  const rendered = await loadAndRender(snapshot)
  const section = findByClass(rendered.main, 'osta-oc-local-section')[0]
  assert.ok(section, '没有 hours 也应渲染本机用量区')
  const sparks = findByClass(section, 'osta-spark')
  assert.equal(sparks.length, 3)
  assert.equal(sparks[0].children.length, 1, '没有 hours → 今天只有 1 根日桶')
  assert.equal(sparks[1].children.length, 5, '本周仍用日桶')
  assert.equal(sparks[2].children.length, 30, '本月仍用日桶')
  assert.match(collectText(section).join(' '), /1,200/, '大数字仍取 totals.today')
})

test('渲染冒烟：本机 OpenCode 用量不可用（local=null）时不渲染三卡区', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.opencode.local = null
  const rendered = await loadAndRender(snapshot)
  assert.equal(findByClass(rendered.main, 'osta-oc-local-section').length, 0, 'local=null → 整块不渲染')
  assert.doesNotMatch(collectText(rendered.main).join(' '), /本机 opencode CLI 用量/)
  assert.equal(findByClass(rendered.main, 'osta-spark').length, 0, 'local 三卡的 sparkline 不再渲染')
  // fixture 的官方 range 都是 null → 官方卡显示「获取失败」（没有 sparkline），但官方区仍应渲染。
  assert.match(collectText(rendered.main).join(' '), /Ollama 官方请求量/, '官方用量区不受 local 影响')
})

test('渲染冒烟：OpenCode 三张额度卡显示 token 估算（本机用量 ÷ 官方百分比）', async () => {
  const snapshot = makeFixtureSnapshot()
  const rendered = await loadAndRender(snapshot)
  const pairs = findByClass(rendered.main, 'osta-limits-pair')
  assert.equal(pairs.length, 1)
  const columns = (pairs[0].children || []).filter((child) => child && child.props && typeof child.props.className === 'string' && child.props.className.split(/\s+/).includes('osta-col'))
  assert.equal(columns.length, 2)
  const ollamaCol = columns[0]
  const opencodeCol = columns[1]

  // 三张 OpenCode 额度卡都有「估算总量…」胶囊，tooltip 用 opencode.estimateHint
  const estimates = findByClass(opencodeCol, 'osta-estimate-inline')
  assert.equal(estimates.length, 3, '三张 OpenCode 额度卡各有一个估算胶囊')
  for (const node of estimates) {
    const title = String(node.props.title || '')
    assert.ok(title.includes('本机 opencode.db'), 'tooltip 用 opencode.estimateHint')
    assert.ok(title.includes('不是官方额度'), 'tooltip 说明估算不是官方额度')
    assert.ok(!title.includes('Ollama'), 'OpenCode tooltip 不串用 Ollama 文案')
  }
  const cards = findByClass(opencodeCol, 'osta-card')
  assert.equal(cards.length, 3)
  // fixture：generatedAt 01:23Z + Asia/Shanghai → 本地 09 点；hours 每桶 50 → rolling used=250
  // rolling 52% → 总量 481 / 已用 250 / 剩余 231
  assert.match(collectText(cards[0]).join(' '), /估算总量 481 · 已用 250 · 剩余 231/, 'rolling 估算 = 本机 5 小时 250 ÷ 52%')
  assert.match(collectText(cards[1]).join(' '), /估算总量/, 'weekly 卡显示估算')
  assert.match(collectText(cards[2]).join(' '), /估算总量/, 'monthly 卡显示估算')

  // Ollama 周卡的估算提示仍是 limits.estimateHint（行为不变）
  const ollamaEstimates = findByClass(ollamaCol, 'osta-estimate-inline')
  assert.equal(ollamaEstimates.length, 1, 'Ollama 周卡估算保持')
  const ollamaTitle = String(ollamaEstimates[0].props.title || '')
  assert.ok(ollamaTitle.includes('Ollama'), 'Ollama 周卡 tooltip 不变')
  assert.ok(!ollamaTitle.includes('不是官方额度'), 'Ollama tooltip 不串到 OpenCode 文案')
})

test('渲染冒烟：local=null 时 OpenCode 额度卡不显示估算（官方百分比卡仍在）', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.opencode.local = null
  const rendered = await loadAndRender(snapshot)
  const grid = findByClass(rendered.main, 'osta-oc-grid')[0]
  assert.ok(grid, 'OpenCode 额度卡仍应渲染')
  assert.equal(findByClass(grid, 'osta-estimate-inline').length, 0, '没有本机数据 → 不显示估算')
  assert.doesNotMatch(collectText(grid).join(' '), /估算总量/)
  assert.match(collectText(grid).join(' '), /52\s*%/, '官方百分比卡不受影响')
})

test('渲染冒烟：旧 host 无 local.hours 时 rolling 卡不显示估算（周/月仍显示）', async () => {
  const snapshot = makeFixtureSnapshot()
  delete snapshot.opencode.local.hours
  const rendered = await loadAndRender(snapshot)
  const cards = findByClass(findByClass(rendered.main, 'osta-oc-grid')[0], 'osta-card')
  assert.equal(cards.length, 3)
  assert.doesNotMatch(collectText(cards[0]).join(' '), /估算总量/, 'rolling 没有小时桶 → 不估算')
  assert.match(collectText(cards[1]).join(' '), /估算总量/, 'weekly 用 totals 仍可估算')
  assert.match(collectText(cards[2]).join(' '), /估算总量/, 'monthly 用 totals 仍可估算')
})

test('渲染冒烟：旧 host 缺 snap.visibility 时两个显示开关默认打开，A/C 区照常渲染', async () => {
  const snapshot = makeFixtureSnapshot()
  delete snapshot.visibility
  const rendered = await loadAndRender(snapshot)
  const toggles = findByClass(rendered.main, 'osta-toggle')
  assert.equal(toggles.length, 2)
  for (const toggle of toggles) assert.equal(toggle.props['aria-pressed'], 'true', '缺字段 → 默认显示')
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama 限额/)
  assert.match(mainText, /OpenCode Go 限额/)
  assert.match(mainText, /Ollama 官方请求量/)
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 1, '两个都显示 → 左右两栏')
})

test('渲染冒烟：显示开关只开 Ollama → 隐藏 OpenCode 区/侧栏行，token 统计不受影响', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.visibility = { ollama: true, opencode: false }
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama 限额/)
  assert.match(mainText, /Ollama 官方请求量/)
  assert.doesNotMatch(mainText, /OpenCode Go 限额/, '显示开关关闭 → 不渲染 OpenCode 区')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/)
  assert.doesNotMatch(mainText, /订阅周期（Monthly）/)
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只剩 Ollama 时 A 区单列占满一行')
  assert.match(mainText, /本机 token 统计（全部供应商）/, 'B 区 token 统计不受显示开关影响')
  assert.match(mainText, /模型分布（当前范围）/)

  const toggles = findByClass(rendered.main, 'osta-toggle')
  assert.equal(toggles.length, 2)
  assert.equal(toggles.find((node) => collectText(node).join(' ').trim() === 'Ollama').props['aria-pressed'], 'true')
  assert.equal(toggles.find((node) => collectText(node).join(' ').trim() === 'OpenCode').props['aria-pressed'], 'false')

  const rows = findByClass(rendered['sidebar.footer.action'], 'osta-barsrow')
  assert.equal(rows.length, 2, '侧栏只显示 Ollama 两行')
  assert.doesNotMatch(collectText(rendered['sidebar.footer.action']).join(' '), /OpenCode/)
})

test('渲染冒烟：显示开关只开 OpenCode → 隐藏 Ollama 限额/官方区，token 统计不受影响', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.visibility = { ollama: false, opencode: true }
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /OpenCode Go 限额/)
  assert.match(mainText, /订阅周期（Monthly）/)
  assert.match(mainText, /本机 opencode CLI 用量/)
  assert.doesNotMatch(mainText, /Ollama 限额/, '显示开关关闭 → 不渲染 Ollama 限额区')
  assert.doesNotMatch(mainText, /Ollama 官方请求量/, '显示开关关闭 → 不渲染官方用量区')
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只剩 OpenCode 时 A 区单列占满一行')
  assert.match(mainText, /本机 token 统计（全部供应商）/, 'B 区照常渲染')

  const rows = findByClass(rendered['sidebar.footer.action'], 'osta-barsrow')
  assert.equal(rows.length, 1, '侧栏只有 OpenCode 一行')
  assert.match(collectText(rows[0]).join(' '), /OpenCode Go/)
})

test('渲染冒烟：两个显示开关都关 → 无 A/C 区、bars 返回 null、只剩 token 统计/模型分布', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.visibility = { ollama: false, opencode: false }
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, 'A 区不渲染')
  assert.doesNotMatch(mainText, /Ollama 限额/)
  assert.doesNotMatch(mainText, /OpenCode Go 限额/)
  assert.doesNotMatch(mainText, /Ollama 官方请求量/)
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/)
  assert.match(mainText, /本机 token 统计（全部供应商）/, 'B 区照常渲染')
  assert.match(mainText, /模型分布（当前范围）/)
  assert.equal(rendered['sidebar.footer.action'], null, '没有任何显示行 → bars 返回 null')
  for (const toggle of findByClass(rendered.main, 'osta-toggle')) {
    assert.equal(toggle.props['aria-pressed'], 'false')
  }
})

test('渲染冒烟：点击 Ollama 显示开关 → set-visibility {ollama:false} 并乐观隐藏该区', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.visibility = { ollama: true, opencode: true }
  const rendered = await loadAndRender(snapshot)
  const ollamaToggle = findByClass(rendered.main, 'osta-toggle').find((node) => collectText(node).join(' ').trim() === 'Ollama')
  assert.ok(ollamaToggle, '应渲染 Ollama 显示开关')
  assert.equal(ollamaToggle.props['aria-pressed'], 'true')
  ollamaToggle.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const call = rendered.__calls.filter((entry) => entry.method === 'set-visibility').pop()
  assert.ok(call, '点击开关应调用 set-visibility')
  assert.equal(call.payload.ollama, false, 'payload 只带被点击的 provider 的新状态')
  assert.equal(Object.prototype.hasOwnProperty.call(call.payload, 'opencode'), false, '未点击的 provider 不出现')

  const after = await rendered.__rerender('main')
  const afterText = collectText(after).join(' ')
  assert.doesNotMatch(afterText, /Ollama 限额/, '乐观更新后 Ollama 区立即隐藏')
  assert.doesNotMatch(afterText, /Ollama 官方请求量/, '官方区同步隐藏')
  assert.match(afterText, /OpenCode Go 限额/, 'OpenCode 仍显示')
  assert.match(afterText, /本机 token 统计/, 'B 区不受影响')
  const afterOllama = findByClass(after, 'osta-toggle').find((node) => collectText(node).join(' ').trim() === 'Ollama')
  assert.equal(afterOllama.props['aria-pressed'], 'false', '开关状态同步为关')
})

test('渲染冒烟：显示开关保存失败时回滚并显示错误条', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.visibility = { ollama: true, opencode: true }
  const rendered = await loadAndRender(snapshot, {
    freezeSnapshot: true,
    visibilityError: { code: 'bad-request', message: 'visibility payload rejected' },
  })
  const ollamaToggle = findByClass(rendered.main, 'osta-toggle').find((node) => collectText(node).join(' ').trim() === 'Ollama')
  ollamaToggle.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const call = rendered.__calls.filter((entry) => entry.method === 'set-visibility').pop()
  assert.ok(call, '点击开关仍应调用 set-visibility')

  const after = await rendered.__rerender('main')
  const afterText = collectText(after).join(' ')
  assert.match(afterText, /Ollama 限额/, '失败后回滚：Ollama 区恢复显示')
  assert.match(afterText, /visibility payload rejected/, '顶部错误条显示失败原因')
  const afterOllama = findByClass(after, 'osta-toggle').find((node) => collectText(node).join(' ').trim() === 'Ollama')
  assert.equal(afterOllama.props['aria-pressed'], 'true', '回滚后开关恢复为开')
})

test('渲染冒烟：仅 Ollama key 时只渲染 Ollama 区（旧 host 缺 snap.opencode 同理），不崩不报错', async () => {
  const snapshot = makeFixtureSnapshot()
  delete snapshot.opencode
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama 限额/, '应渲染 Ollama 限额区')
  assert.doesNotMatch(mainText, /OpenCode Go 限额/, '旧 host 缺 opencode 字段 → 不渲染 OpenCode 区')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/, '不渲染本机 OpenCode CLI 用量条')
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只有一个 provider 时 A 区单列占满一行')
  assert.equal(findByClass(rendered.main, 'osta-errorbar').length, 0, '旧 host 不应伪造 OpenCode 错误')
  assert.doesNotMatch(mainText, /OpenCode 额度获取失败/)
  assert.doesNotMatch(mainText, /订阅周期（Monthly）/, '没有 opencode 数据时不渲染三张卡')
  assert.match(mainText, /本机 token 统计/, 'token 统计仍应渲染')
  assert.ok(buttonLabels(rendered.main).includes('配置 Key'), '缺少 OpenCode Key 时应显示配置入口')
  const footerText = collectText(rendered['sidebar.footer.action']).join(' ')
  assert.doesNotMatch(footerText, /OpenCode/, '无 Go 数据时侧栏不出现 OpenCode 行')
})

test('渲染冒烟：OpenCode configured 但 kind=none + errors 时显示空态卡与错误条', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.opencode = {
    configured: true,
    key: { source: 'local-cli', masked: 'sk-****U61I' },
    kind: 'none',
    fetchedAt: null,
    note: null,
    usage: null,
    local: null,
  }
  snapshot.errors = [{ source: 'opencode', code: 'unauthorized', message: 'api_key_expired' }]
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /OpenCode 额度获取失败/, '应显示接口失败空态卡')
  assert.match(mainText, /api_key_expired/, '错误条应带上游 message')
  assert.ok(findByClass(rendered.main, 'osta-errorbar').length >= 1, '应有错误条')
  assert.doesNotMatch(mainText, /订阅周期（Monthly）/, '无 usage 不渲染三张卡')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/, 'local=null 不渲染本机用量条')
})

test('渲染冒烟：仅 OpenCode key（Ollama 未配置）时不渲染 Ollama 限额 / 官方用量区', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.key = { source: 'none', masked: null, sources: {} }
  snapshot.limits = { kind: 'none', session: null, weekly: null, credits: null, purchasedUsd: null }
  snapshot.official = { fetchedAt: '2026-10-30T12:00:00.000Z', range24h: null, range7d: null, range30d: null }
  snapshot.errors = []
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /OpenCode Go 限额/, '应渲染 OpenCode 区')
  assert.match(mainText, /订阅周期（Monthly）/, 'OpenCode 三窗口卡照常渲染')
  assert.match(mainText, /本机 opencode CLI 用量/, 'local 数据存在时仍渲染本机用量条')
  assert.match(mainText, /本机 token 统计（全部供应商）/, '无 Ollama Key 时 B 区 token 统计仍必须渲染')
  assert.doesNotMatch(mainText, /Ollama 限额/, '无 Ollama Key → 不渲染 Ollama 限额区')
  assert.doesNotMatch(mainText, /Ollama 官方请求量/, '无 Ollama Key → C 区整块不渲染')
  assert.doesNotMatch(mainText, /获取失败/, '未配置不应显示成获取失败')
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只有一个 provider 时 A 区单列占满一行')
  assert.ok(buttonLabels(rendered.main).includes('配置 Key'), '缺少 Ollama Key 时应显示配置入口')

  // 侧栏只有 OpenCode 一行
  const rows = findByClass(rendered['sidebar.footer.action'], 'osta-barsrow')
  assert.equal(rows.length, 1, '侧栏只应有 OpenCode 一行')
  assert.match(collectText(rows[0]).join(' '), /OpenCode Go/)
})

test('渲染冒烟：仅 Ollama key 时不渲染 OpenCode 区（local 有数据也不展示）', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.opencode = {
    configured: false,
    key: { source: 'none', masked: null },
    kind: 'none',
    fetchedAt: null,
    note: null,
    usage: null,
    // 即使本机 opencode.db 有数据，只要没配置 Key 就不展示该区。
    local: makeOpencodeFixture().local,
  }
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama 限额/, '应渲染 Ollama 限额区')
  assert.match(mainText, /Ollama 官方请求量/, '有 Ollama Key → C 区照常渲染')
  assert.doesNotMatch(mainText, /OpenCode Go 限额/, '无 OpenCode Key → 不渲染 OpenCode 区')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/, '无 OpenCode Key → 不渲染本机 CLI 用量条')
  assert.doesNotMatch(mainText, /订阅周期（Monthly）/i)
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只有一个 provider 时 A 区单列占满一行')
  assert.ok(buttonLabels(rendered.main).includes('配置 Key'), '缺少 OpenCode Key 时应显示配置入口')
  const rows = findByClass(rendered['sidebar.footer.action'], 'osta-barsrow')
  assert.equal(rows.length, 2, '侧栏只有 Ollama 两行')
  const footerText = collectText(rendered['sidebar.footer.action']).join(' ')
  assert.doesNotMatch(footerText, /OpenCode/, '未配置 OpenCode 时侧栏不出现该行')
})

test('渲染冒烟：两个 Key 都未配置时无 A/C 区、token 统计可见、侧栏 bars 返回 null', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.key = { source: 'none', masked: null, sources: {} }
  snapshot.opencode = {
    configured: false,
    key: { source: 'none', masked: null },
    kind: 'none',
    fetchedAt: null,
    note: null,
    usage: null,
    local: makeOpencodeFixture().local,
  }
  snapshot.limits = { kind: 'none', session: null, weekly: null, credits: null, purchasedUsd: null }
  snapshot.official = { fetchedAt: '2026-10-30T12:00:00.000Z', range24h: null, range7d: null, range30d: null }
  snapshot.errors = []
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '两个 Key 都没有 → A 区不渲染')
  assert.doesNotMatch(mainText, /Ollama 限额/, '无 Ollama 限额区')
  assert.doesNotMatch(mainText, /OpenCode Go 限额/, '无 OpenCode 区')
  assert.doesNotMatch(mainText, /Ollama 官方请求量/, '无 Ollama Key → C 区不渲染')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/, '无 OpenCode Key → 不渲染本机 CLI 用量条')
  assert.match(mainText, /本机 token 统计（全部供应商）/, 'B 区 token 统计照常渲染')
  assert.match(mainText, /6,129/, 'token 数字可见（今天 = 6,100 + 29）')
  assert.ok(buttonLabels(rendered.main).includes('配置 Key'), '至少一个 provider 未配置 → 显示配置入口')
  assert.equal(rendered['sidebar.footer.action'], null, '没有任何可用行时 bars 返回 null')
  assert.equal(findByClass(rendered.main, 'osta-keypanel').length, 0, '配置面板默认收起')
  const noKeyToggles = findByClass(rendered.main, 'osta-toggle')
  assert.equal(noKeyToggles.length, 2, 'snap 存在 → 显示开关仍渲染（不删除 Key）')
  for (const toggle of noKeyToggles) assert.equal(toggle.props['aria-pressed'], 'true', '默认显示')

  // 点击「配置 Key」→ 展开内联面板：两个 provider 都未配置 → 两个 KeyBar，输入 id 唯一
  const configButton = findButtons(rendered.main).find((button) => collectText(button).join(' ').trim() === '配置 Key')
  assert.ok(configButton, '应渲染「配置 Key」按钮')
  configButton.props.onClick()
  const reopened = await rendered.__rerender('main')
  const reopenedText = collectText(reopened).join(' ')
  assert.match(reopenedText, /配置 API Key/, '点击后应展开配置面板')
  assert.match(reopenedText, /配置 Ollama API Key/, '面板应包含 Ollama KeyBar')
  assert.match(reopenedText, /未配置 OpenCode Key|配置 OpenCode API Key/, '面板应包含 OpenCode KeyBar')
  assert.equal(findByClass(reopened, 'osta-keypanel').length, 1, '面板只渲染一次')
  const panelIds = findPasswordInputs(findByClass(reopened, 'osta-keypanel')[0]).map((node) => node.props.id).sort()
  assert.equal(panelIds.length, 2, '两个未配置 provider 各一个 KeyBar')
  assert.equal(panelIds[0], 'osta-key-panel-ollama')
  assert.equal(panelIds[1], 'osta-key-panel-opencode')
})

test('渲染冒烟：OpenCode 被插件级移除（disabled=true）时隐藏该区，KeyPanel 提供「恢复外部 Key」', async () => {
  const snapshot = makeFixtureSnapshot()
  const ocFixture = makeOpencodeFixture()
  snapshot.opencode = {
    configured: false,
    key: { source: 'none', masked: null },
    disabled: true,
    kind: 'none',
    fetchedAt: null,
    note: null,
    usage: null,
    // 即使本机 opencode.db 还有数据，disabled 时也不展示。
    local: ocFixture.local,
  }
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.doesNotMatch(mainText, /OpenCode Go 限额/, 'disabled → 不渲染 OpenCode 区')
  assert.doesNotMatch(mainText, /本机 opencode CLI 用量/, 'disabled → 不渲染本机 CLI 用量条')
  assert.doesNotMatch(mainText, /订阅周期（Monthly）/)
  assert.equal(findByClass(rendered.main, 'osta-limits-pair').length, 0, '只剩 Ollama 时 A 区单列占满一行')
  assert.match(mainText, /Ollama 限额/, 'Ollama 区照常渲染')
  assert.match(mainText, /Ollama 官方请求量/, 'Ollama Key 仍在 → C 区照常渲染')
  assert.ok(buttonLabels(rendered.main).includes('配置 Key'), 'OpenCode 缺失 → 显示配置入口')
  assert.equal(findByClass(rendered.main, 'osta-keypanel').length, 0, '面板默认收起')
  const rows = findByClass(rendered['sidebar.footer.action'], 'osta-barsrow')
  assert.equal(rows.length, 2, '侧栏只剩 Ollama 两行')

  // 打开「配置 Key」：只给 OpenCode 一个 KeyBar + disabled 说明 + 恢复按钮（Ollama 已配置不重复）
  const configButton = findButtons(rendered.main).find((button) => collectText(button).join(' ').trim() === '配置 Key')
  assert.ok(configButton, '应渲染「配置 Key」按钮')
  configButton.props.onClick()
  const reopened = await rendered.__rerender('main')
  const reopenedText = collectText(reopened).join(' ')
  assert.match(reopenedText, /插件已移除该 Key/, '应说明插件已移除该 Key')
  assert.match(reopenedText, /外部配置不会被删除/, '应说明不会删除环境变量 / CLI 登录')
  assert.ok(buttonLabels(reopened).includes('恢复外部 Key'), '应提供「恢复外部 Key」按钮')
  assert.ok(buttonLabels(reopened).includes('检测并保存'), 'KeyBar 仍保留（粘贴新 Key 可自动恢复）')
  const panelForms = findPasswordInputs(findByClass(reopened, 'osta-keypanel')[0])
  assert.equal(panelForms.length, 1, '只给未配置的 OpenCode 渲染 KeyBar')
  assert.equal(panelForms[0].props.id, 'osta-key-panel-opencode')

  // 粘贴新 Key → 提交 → set-key {provider:'opencode'}（保存后 host 会清除 disabled 标志，自动恢复）
  const input = panelForms[0]
  input.props.onChange({ target: { value: 'sk-new-opencode-key' } })
  const filled = await rendered.__rerender('main')
  const keyForm = findByClass(filled, 'osta-keyform')[0]
  assert.ok(keyForm, '面板里应有 Key 表单')
  keyForm.props.onSubmit({ preventDefault: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const setCall = rendered.__calls.filter((call) => call.method === 'set-key').pop()
  assert.ok(setCall, '提交 Key 表单应调用 set-key')
  assert.equal(setCall.payload.provider, 'opencode')
  assert.equal(setCall.payload.token, 'sk-new-opencode-key', '粘贴的新 Key 应原样提交')

  // 点击「恢复外部 Key」→ clear-key {provider:'opencode', mode:'enable'}
  const restoreButton = findButtons(reopened).find((button) => collectText(button).join(' ').trim() === '恢复外部 Key')
  restoreButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const clearCall = rendered.__calls.filter((call) => call.method === 'clear-key').pop()
  assert.ok(clearCall, '点击恢复应调用 clear-key')
  assert.equal(clearCall.payload.provider, 'opencode')
  assert.equal(clearCall.payload.mode, 'enable', '恢复外部 Key 必须带 mode:enable')
})

test('渲染冒烟：OpenCode kind=none 空态说明走 i18n，不直出 host 中文 note', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.opencode = {
    configured: true,
    key: { source: 'local-cli', masked: 'sk-****U61I' },
    kind: 'none',
    fetchedAt: null,
    note: 'SERVER_NOTE_SHOULD_NOT_RENDER',
    usage: null,
    local: null,
  }
  snapshot.errors = []
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /当前 Key 没有 OpenCode Go 订阅/, '应显示本地化空态标题')
  assert.match(mainText, /该 Key 未返回 Go 订阅窗口/, '应显示本地化空态说明')
  assert.doesNotMatch(mainText, /SERVER_NOTE_SHOULD_NOT_RENDER/, 'host 的中文 note 不应直出到界面')
})

test('渲染冒烟：OpenCode 有旧 usage 且 errors 含 opencode 时保留三窗口卡', async () => {
  const snapshot = makeFixtureSnapshot()
  snapshot.errors = [{ source: 'opencode', code: 'network', message: 'fetch failed' }]
  const rendered = await loadAndRender(snapshot)
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /订阅周期（Monthly）/, '有旧 usage 时优先渲染卡片')
  assert.match(mainText, /fetch failed/, '错误条仍应显示')
  const grids = findByClass(rendered.main, 'osta-oc-grid')
  assert.equal(grids.length, 1)
  assert.equal(grids[0].children.length, 3, '三张卡都应保留')
})

test('渲染冒烟：旧 host no-key 降级页保留两种 Key 表单，且不显示页头配置入口', async () => {
  const rendered = await loadAndRender(null, {
    snapshotError: { source: 'key', code: 'no-key', message: 'no key' },
  })
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /未检测到 Ollama API Key/, '应渲染 Ollama KeyGuide')
  assert.match(mainText, /未配置 OpenCode Key/, '应渲染 OpenCode KeyBar（只有 OpenCode Key 的用户也能进入页面）')
  assert.ok(!buttonLabels(rendered.main).includes('配置 Key'), 'no-key 降级页不显示页头配置入口（没有 snapshot）')
  assert.equal(findByClass(rendered.main, 'osta-toggle').length, 0, 'no-key 降级页不显示显示开关（没有 snapshot）')
  const forms = findByClass(rendered.main, 'osta-keyform')
  assert.equal(forms.length, 2, 'no-key 视图应有两个 Key 表单')
  const ids = findPasswordInputs(rendered.main).map((node) => node.props.id).sort()
  assert.equal(ids.length, 2)
  assert.equal(ids[0], 'osta-key-input')
  assert.equal(ids[1], 'osta-opencode-key-input')
  assert.notEqual(ids[0], ids[1], '两个 Key 表单的 input id 不能冲突')
})


