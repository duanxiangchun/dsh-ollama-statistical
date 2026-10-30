/**
 * v0.9.2（契约 §8.5）provider 显示开关（visibility）Host 单测：
 *  - buildSnapshot 默认双 true / 归一化为布尔；
 *  - 默认 snapshot.visibility 双 true（不发网络）；
 *  - set-visibility 部分更新 / 两个都传 / 非法 payload（state 不变）；
 *  - 持久化 state.json + loadPersisted（旧 state 无字段 → 双 true）；
 *  - snapshotCache / lastSnapshot 同步，且不触发重新采集；
 *  - 不影响 tokens / limits / opencode 的采集与字段。
 * 全部隔离真实 HOME / DSH_HOME / Key 环境变量，不发真实网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSnapshot, dispatch, loadPersisted } from '../lib/index.js'

const ISOLATED_ENV_KEYS = [
  'OLLAMA_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'OPENCODE_AUTH_PATH',
  'OPENCODE_DB_PATH',
  'XDG_DATA_HOME',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'DSH_HOME',
]

/** 隔离真实环境：清掉所有 key / 路径环境变量，HOME / DSH_HOME 指向空临时目录。 */
async function withIsolatedEnv(run) {
  const saved = new Map()
  for (const name of ISOLATED_ENV_KEYS) saved.set(name, process.env[name])
  const root = mkdtempSync(join(tmpdir(), 'dsh-visibility-test-'))
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh')
  const dataHome = join(root, 'data')
  const localAppData = join(root, 'localappdata')
  for (const dir of [home, dshHome, dataHome, localAppData]) mkdirSync(dir, { recursive: true })
  for (const name of ISOLATED_ENV_KEYS) delete process.env[name]
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.env.XDG_DATA_HOME = dataHome
  process.env.LOCALAPPDATA = localAppData
  process.env.DSH_HOME = dshHome
  try {
    return await run({ root, home, dshHome })
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

/** 临时替换 globalThis.fetch，结束后恢复。 */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

/** 最小 rt：只实现 visibility 端点 / snapshot 用到的字段。 */
function makeRt(overrides = {}) {
  return {
    ctx: { get: () => undefined },
    state: {
      version: 1,
      manualKey: null,
      opencodeManualKey: null,
      opencodeDisabled: false,
      visibility: { ollama: true, opencode: true },
      lastSnapshot: null,
      lastSnapshotAt: null,
    },
    snapshotCache: null,
    lastCollectAt: 0,
    rateLimitedUntil: 0,
    inflight: null,
    warm: { running: false, plan: null },
    ...overrides,
  }
}

function stateFileFor(dshHome) {
  return join(dshHome, 'storages', 'ollama-statistical', 'state.json')
}

/* ---------------------------------- buildSnapshot ---------------------------------- */

test('buildSnapshot: visibility 默认双 true，显式 false 才关闭，且始终为布尔', () => {
  assert.deepEqual(buildSnapshot({}).visibility, { ollama: true, opencode: true })
  assert.deepEqual(buildSnapshot({ visibility: { ollama: false } }).visibility, {
    ollama: false,
    opencode: true,
  })
  assert.deepEqual(buildSnapshot({ visibility: { ollama: false, opencode: false } }).visibility, {
    ollama: false,
    opencode: false,
  })
  for (const invalid of [null, undefined, 'x', 1, []]) {
    assert.deepEqual(buildSnapshot({ visibility: invalid }).visibility, { ollama: true, opencode: true })
  }
  const normalized = buildSnapshot({ visibility: { ollama: 0, opencode: 'false' } }).visibility
  assert.equal(typeof normalized.ollama, 'boolean')
  assert.equal(typeof normalized.opencode, 'boolean')
  // 与 opencode 块并列的顶层字段
  assert.ok('opencode' in buildSnapshot({}))
  assert.ok('visibility' in buildSnapshot({}))
})

/* ------------------------------- 默认 snapshot.visibility ------------------------------- */

test('snapshot: 默认 visibility 双 true（无 Key 也返回，且不发网络）', async () => {
  await withIsolatedEnv(async () => {
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('不得发起网络请求')
      },
      async () => {
        const rt = makeRt()
        const out = await dispatch(rt, 'snapshot', {})
        assert.equal(out.ok, true)
        assert.deepEqual(out.value.visibility, { ollama: true, opencode: true })
        assert.equal(fetchCalls, 0)
        assert.equal(out.value.tokens.days.length, 30)
      },
    )
  })
})

/* -------------------------------- set-visibility 合法 -------------------------------- */

test('set-visibility: 只传一个字段时另一个保持', async () => {
  await withIsolatedEnv(async () => {
    const rt = makeRt()
    const first = await dispatch(rt, 'set-visibility', { ollama: false })
    assert.equal(first.ok, true)
    assert.deepEqual(first.value, { visibility: { ollama: false, opencode: true } })
    assert.deepEqual(rt.state.visibility, { ollama: false, opencode: true })

    const second = await dispatch(rt, 'set-visibility', { opencode: false })
    assert.equal(second.ok, true)
    assert.deepEqual(second.value.visibility, { ollama: false, opencode: false })
    assert.deepEqual(rt.state.visibility, { ollama: false, opencode: false })

    // 再打开 ollama，opencode 保持关闭（部分更新叠加）
    const third = await dispatch(rt, 'set-visibility', { ollama: true })
    assert.deepEqual(third.value.visibility, { ollama: true, opencode: false })
  })
})

test('set-visibility: 两个字段都传', async () => {
  await withIsolatedEnv(async () => {
    const rt = makeRt()
    const out = await dispatch(rt, 'set-visibility', { ollama: false, opencode: false })
    assert.equal(out.ok, true)
    assert.deepEqual(out.value.visibility, { ollama: false, opencode: false })
    assert.deepEqual(rt.state.visibility, { ollama: false, opencode: false })
    assert.equal(typeof rt.state.visibility.ollama, 'boolean')
    assert.equal(typeof rt.state.visibility.opencode, 'boolean')
  })
})

/* -------------------------------- set-visibility 非法 -------------------------------- */

test('set-visibility: 非法 payload → bad-request 且 state 不变', async () => {
  await withIsolatedEnv(async () => {
    const rt = makeRt()
    const before = JSON.stringify(rt.state.visibility)
    const invalidPayloads = [
      {},
      { ollama: 'false' },
      { ollama: 0 },
      { opencode: 1 },
      { ollama: null },
      { ollama: 'true', opencode: true },
      null,
      'x',
    ]
    for (const payload of invalidPayloads) {
      const out = await dispatch(rt, 'set-visibility', payload)
      assert.equal(out.ok, false, JSON.stringify(payload))
      assert.equal(out.error.code, 'bad-request', JSON.stringify(payload))
      assert.equal(typeof out.error.details, 'object')
      assert.equal(JSON.stringify(rt.state.visibility), before, '非法 payload 不得改动 state')
    }
    // 合法请求在非法请求之后仍然可用
    const ok = await dispatch(rt, 'set-visibility', { opencode: false })
    assert.equal(ok.ok, true)
  })
})

/* ----------------------------------- 持久化 / 加载 ----------------------------------- */

test('set-visibility: 持久化到 state.json（version 1），loadPersisted 可恢复', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    const rt = makeRt()
    const out = await dispatch(rt, 'set-visibility', { ollama: false })
    assert.equal(out.ok, true)

    const state = JSON.parse(readFileSync(stateFileFor(dshHome), 'utf8'))
    assert.equal(state.version, 1)
    assert.deepEqual(state.visibility, { ollama: false, opencode: true })

    const restored = makeRt()
    restored.state.visibility = { ollama: true, opencode: true }
    loadPersisted(restored)
    assert.deepEqual(restored.state.visibility, { ollama: false, opencode: true })
  })
})

test('loadPersisted: 旧 state 没有 visibility → 双 true；旧 lastSnapshot 也归一化', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    const dir = join(dshHome, 'storages', 'ollama-statistical')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        manualKey: 'x',
        lastSnapshot: { version: 1, updatedAt: '2026-10-30T00:00:00.000Z', tokens: { days: [] } },
      }),
    )
    const rt = makeRt()
    rt.state.visibility = { ollama: false, opencode: false }
    loadPersisted(rt)
    assert.deepEqual(rt.state.visibility, { ollama: true, opencode: true }, '旧 state 无字段 → 都 true')
    assert.deepEqual(rt.state.lastSnapshot.visibility, { ollama: true, opencode: true })
  })
})

test('set-visibility: 同步 snapshotCache / lastSnapshot，且不重新采集', async () => {
  await withIsolatedEnv(async () => {
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('不得发起网络请求')
      },
      async () => {
        const rt = makeRt()
        const first = await dispatch(rt, 'snapshot', {})
        assert.equal(first.ok, true)
        assert.equal(fetchCalls, 0)
        assert.ok(rt.snapshotCache && rt.state.lastSnapshot)

        const beforeTokens = JSON.stringify(rt.state.lastSnapshot.tokens)
        const beforeLimits = JSON.stringify(rt.state.lastSnapshot.limits)
        const beforeOpenCode = JSON.stringify(rt.state.lastSnapshot.opencode)
        const beforeLastCollectAt = rt.lastCollectAt

        const out = await dispatch(rt, 'set-visibility', { opencode: false })
        assert.equal(out.ok, true)
        assert.deepEqual(out.value.visibility, { ollama: true, opencode: false })
        assert.deepEqual(rt.state.lastSnapshot.visibility, { ollama: true, opencode: false })
        assert.deepEqual(rt.snapshotCache.value.visibility, { ollama: true, opencode: false })

        // 数据不变、不重新采集
        assert.equal(fetchCalls, 0)
        assert.equal(rt.lastCollectAt, beforeLastCollectAt)
        assert.equal(rt.inflight, null)
        assert.equal(JSON.stringify(rt.state.lastSnapshot.tokens), beforeTokens)
        assert.equal(JSON.stringify(rt.state.lastSnapshot.limits), beforeLimits)
        assert.equal(JSON.stringify(rt.state.lastSnapshot.opencode), beforeOpenCode)

        // 后续 snapshot 命中 60s 内存缓存，返回新开关且不触发重采
        const second = await dispatch(rt, 'snapshot', {})
        assert.equal(second.ok, true)
        assert.equal(second.value.cached, true)
        assert.deepEqual(second.value.visibility, { ollama: true, opencode: false })
        assert.equal(fetchCalls, 0)
        assert.equal(rt.inflight, null)
      },
    )
  })
})

/* --------------------------------- 不影响采集 --------------------------------- */

test('set-visibility: 不影响 OpenCode / tokens 采集（开关只改显示，不触发 usage 请求）', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    let usageCalls = 0
    await withFetch(
      async (url) => {
        usageCalls += 1
        return jsonResponse({
          usage: { rolling: { status: 'ok', percent: 10, resetsAt: '2026-10-30T06:00:00.000Z' } },
        })
      },
      async () => {
        const rt = makeRt()
        const first = await dispatch(rt, 'snapshot', {})
        assert.equal(first.ok, true)
        assert.equal(usageCalls, 1)
        assert.equal(first.value.opencode.configured, true)

        const out = await dispatch(rt, 'set-visibility', { opencode: false })
        assert.equal(out.ok, true)
        assert.equal(usageCalls, 1, 'set-visibility 不得重新采集 usage')

        // 下一次真实采集仍照常抓取 OpenCode，并带上当前开关
        rt.lastCollectAt = 0
        const refreshed = await dispatch(rt, 'refresh', {})
        assert.equal(refreshed.ok, true)
        assert.equal(usageCalls, 2)
        assert.deepEqual(refreshed.value.visibility, { ollama: true, opencode: false })
        assert.equal(refreshed.value.opencode.configured, true, '开关不影响采集')
        assert.equal(refreshed.value.opencode.usage.rolling.usedPercent, 10)
        assert.equal(refreshed.value.tokens.days.length, 30)
      },
    )
  })
})
