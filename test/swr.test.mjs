/**
 * snapshot SWR（stale-while-revalidate）单测：
 *  - 重启后（仅磁盘 lastSnapshot）与过期内存缓存两条路径：立即返回旧值（cached:true +
 *    revalidating:true）、后台重采启动、响应绝不被采集阻塞（用挂起的 credentials.resolve 验证）；
 *  - 60s 新鲜缓存：直接返回，不触发重采；
 *  - 限流冷却期：回旧值且不再发起后台重采；
 *  - 完全没有快照（首次使用）：才走前台采集（v0.9 起没有 Key 也返回 ok:true +
 *    本机 token 统计，见契约 §8）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleSnapshot } from '../lib/index.js'

/**
 * 隔离环境凭证：清掉 Ollama / OpenCode 的 key 与路径环境变量，并把
 * USERPROFILE/HOME/XDG_DATA_HOME/LOCALAPPDATA 指向空临时目录，保证
 * readLocalCliToken / readOpenCodeAuthToken / resolveOpenCodeDbPath 读不到真实文件
 * （避免测试意外走真实网络，或读到本机 opencode CLI 的 key / 数据库）。
 */
async function withNoAmbientKey(run) {
  const isolatedNames = [
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
  const saved = new Map()
  for (const name of isolatedNames) saved.set(name, process.env[name])
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-ollama-nohome-'))
  for (const name of isolatedNames) delete process.env[name]
  process.env.USERPROFILE = emptyHome
  process.env.HOME = emptyHome
  process.env.XDG_DATA_HOME = emptyHome
  process.env.LOCALAPPDATA = emptyHome
  process.env.DSH_HOME = join(emptyHome, 'dsh-home')
  try {
    return await run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(emptyHome, { recursive: true, force: true })
  }
}

function sampleValue() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    cached: false,
    key: { source: 'credentials', masked: '****cWjS' },
    limits: { kind: 'legacy', session: null, weekly: null, credits: null, purchasedUsd: 0 },
    official: { fetchedAt: new Date().toISOString(), range24h: null, range7d: null, range30d: null },
    tokens: { days: [], models: [], scan: { partial: false } },
    opencode: {
      configured: false,
      key: { source: 'none', masked: null },
      kind: 'none',
      fetchedAt: null,
      note: null,
      usage: null,
      local: null,
    },
    errors: [],
  }
}

function makeRt({ lastSnapshot = null, snapshotCache = null, rateLimitedUntil = 0, credentialsResolve = null }) {
  const calls = { credentials: 0 }
  const rt = {
    ctx: {
      get(name) {
        if (name === 'credentials') {
          calls.credentials += 1
          return { resolve: credentialsResolve || (async () => null) }
        }
        return undefined
      },
    },
    state: { lastSnapshot, manualKey: null, lastSnapshotAt: lastSnapshot ? lastSnapshot.updatedAt : null },
    snapshotCache,
    lastCollectAt: 0,
    rateLimitedUntil,
    inflight: null,
    warm: { running: false, plan: null },
  }
  return { rt, calls }
}

test('snapshot SWR: 重启后仅磁盘 lastSnapshot → 立即返回旧值并后台重采，绝不前台阻塞', async () => {
  await withNoAmbientKey(async () => {
    const value = sampleValue()
    let release = null
    const gate = new Promise((resolvePromise) => {
      release = resolvePromise
    })
    const { rt, calls } = makeRt({
      lastSnapshot: value,
      credentialsResolve: async () => {
        await gate
        return null
      },
    })
    // 若实现错误地在前台 await 采集，这里会一直挂起直到测试超时。
    const out = await handleSnapshot(rt)
    assert.equal(out.ok, true)
    assert.equal(out.value.cached, true)
    assert.equal(out.value.revalidating, true)
    assert.notEqual(out.value, value, '返回的必须是副本，不得把存储的 lastSnapshot 对象直接给出去')
    assert.equal(value.cached, false, '不得原地改写 lastSnapshot')
    assert.ok(rt.inflight, '后台重采应已启动（inflight 非空）')
    assert.ok(calls.credentials > 0, '后台重采应已开始解析 key')
    const bg = rt.inflight
    release()
    const result = await bg
    // v0.9（契约 §8）：无 Key 的后台重采也返回新快照（不再降级 no-key）
    assert.equal(result.ok, true, '无 key 的后台重采应返回新快照')
    assert.equal(result.value.cached, false)
    assert.equal(result.value.key.source, 'none')
    assert.equal(result.value.tokens.days.length, 30)
    assert.equal(result.value.errors.some((item) => item.source === 'key'), false, '新 host 不再产生 no-key')
    assert.ok(result.value.errors.some((item) => item.source === 'tokens' && item.code === 'internal'))
    await new Promise((resolveTick) => setTimeout(resolveTick, 0))
    assert.equal(rt.inflight, null, '采集结束后 inflight 清空')
  })
})

test('snapshot SWR: 过期内存缓存（>60s）→ 立即返回旧值并后台重采', async () => {
  await withNoAmbientKey(async () => {
    const value = sampleValue()
    let release = null
    const gate = new Promise((resolvePromise) => {
      release = resolvePromise
    })
    const { rt, calls } = makeRt({
      lastSnapshot: null,
      snapshotCache: { value, fetchedAt: Date.now() - 120_000 },
      credentialsResolve: async () => {
        await gate
        return null
      },
    })
    const out = await handleSnapshot(rt)
    assert.equal(out.ok, true)
    assert.equal(out.value.cached, true)
    assert.equal(out.value.revalidating, true)
    assert.ok(calls.credentials > 0, '应触发后台重采（开始解析 key）')
    release()
    await rt.inflight
  })
})

test('snapshot: 60s 内新鲜缓存直接返回，不触发重采', async () => {
  const value = sampleValue()
  const { rt, calls } = makeRt({
    lastSnapshot: null,
    snapshotCache: { value, fetchedAt: Date.now() - 5_000 },
  })
  const out = await handleSnapshot(rt)
  assert.equal(out.ok, true)
  assert.equal(out.value.cached, true)
  assert.equal(out.value.revalidating, undefined)
  assert.equal(rt.inflight, null)
  assert.equal(calls.credentials, 0, '新鲜缓存命中时不得访问 credentials / 发起采集')
})

test('snapshot SWR: 限流冷却期内回旧值且不发起后台重采', async () => {
  const value = sampleValue()
  const { rt, calls } = makeRt({
    lastSnapshot: value,
    rateLimitedUntil: Date.now() + 60_000,
  })
  const out = await handleSnapshot(rt)
  assert.equal(out.ok, true)
  assert.equal(out.value.cached, true)
  assert.equal(out.value.revalidating, undefined, '限流冷却中不得标 revalidating（没有重采在进行）')
  assert.equal(rt.inflight, null)
  assert.equal(calls.credentials, 0, '限流冷却中不得访问 credentials / 发起采集')
})

test('snapshot: 完全没有快照（首次使用）→ 前台采集返回 ok:true（无 Key 也有本地 token 统计）', async () => {
  await withNoAmbientKey(async () => {
    const { rt, calls } = makeRt({ lastSnapshot: null })
    const out = await handleSnapshot(rt)
    // v0.9（契约 §8）：Key 不是必填项 —— 首次打开没有 Key 也不再 no-data
    assert.equal(out.ok, true)
    assert.equal(out.value.cached, false)
    assert.deepEqual(out.value.key, { source: 'none', masked: null })
    assert.equal(out.value.limits.kind, 'none')
    assert.equal(out.value.tokens.days.length, 30)
    assert.equal(out.value.opencode.configured, false)
    assert.equal(out.value.errors.some((item) => item.source === 'key'), false, '新 host 不再产生 no-key')
    assert.ok(calls.credentials > 0, '首次无数据应真正进入前台采集')
    assert.equal(rt.inflight, null)
    assert.equal(rt.state.lastSnapshot.version, 1, '首次采集应把快照持久化到隔离的 DSH_HOME')
  })
})
