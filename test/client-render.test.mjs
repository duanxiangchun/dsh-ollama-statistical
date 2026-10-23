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
      scan: { sessions: 3, candidates: 3, scanned: 3, fromCache: 0, covered: 3, failed: 0, retired: 0, pending: 0, elapsedMs: 5, partial: false },
    },
    errors: [],
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

  return {
    React,
    async renderTree(component, props) {
      hookStore.clear()
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
    },
  }
}

async function loadAndRender(snapshot) {
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
  const services = {
    slots: {
      inject(name, factory) { registrations.push({ name, factory }) },
      register(slot, component) { return component },
    },
    connection: {
      rpc: {
        call(channel, method) {
          if (method === 'snapshot') return Promise.resolve({ ok: true, value: snapshot })
          if (method === 'auth-state') return Promise.resolve({ ok: true, value: { source: 'dsh' } })
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

test('渲染冒烟：主页面 / 侧栏组件能用真实快照渲染且不抛异常（防白屏）', async () => {
  const snapshot = makeFixtureSnapshot()
  const rendered = await loadAndRender(snapshot)
  assert.ok(rendered.main, 'main 槽位应已注册')
  const mainText = collectText(rendered.main).join(' ')
  assert.match(mainText, /Ollama/, '主页面应渲染标题')
  assert.match(mainText, /估算总量/, '周卡应渲染紧凑的 token 额度估算')
  const footerText = collectText(rendered['sidebar.footer.action']).join(' ')
  assert.match(footerText, /会话 5h/, '侧栏横条应渲染会话用量')
  assert.ok(rendered['sidebar.panellist'], '侧栏图标槽位应已注册')
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

