/**
 * snapshot SWR（stale-while-revalidate）单测：
 *  - 重启后（仅磁盘 lastSnapshot）与过期内存缓存两条路径：立即返回旧值（cached:true +
 *    revalidating:true）、后台重采启动、响应绝不被采集阻塞（用挂起的 credentials.resolve 验证）；
 *  - 60s 新鲜缓存：直接返回，不触发重采；
 *  - 限流冷却期：回旧值且不再发起后台重采；
 *  - 完全没有快照（首次使用）：才走前台采集（无 key 时 no-data）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleSnapshot } from '../lib/index.js'

/**
 * 隔离环境凭证：清掉 OLLAMA_API_KEY，并把 USERPROFILE/HOME 指向空临时目录，
 * 保证 readLocalCliToken 读不到真实 ~/.ollama/auth.json（避免测试意外走真实网络）。
 */
async function withNoAmbientKey(run) {
  const savedKey = process.env.OLLAMA_API_KEY
  const savedProfile = process.env.USERPROFILE
  const savedHome = process.env.HOME
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-ollama-nohome-'))
  delete process.env.OLLAMA_API_KEY
  process.env.USERPROFILE = emptyHome
  process.env.HOME = emptyHome
  try {
    return await run()
  } finally {
    if (savedKey === undefined) delete process.env.OLLAMA_API_KEY
    else process.env.OLLAMA_API_KEY = savedKey
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
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
    assert.equal(result.ok, true, '无 key 时后台重采降级返回旧快照（cached:true）')
    assert.equal(result.value.cached, true)
    assert.ok(
      result.value.errors.some((item) => item.source === 'key' && item.code === 'no-key'),
      '降级结果应附 no-key 说明',
    )
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

test('snapshot: 完全没有快照（首次使用）→ 走前台采集，无 key 时 no-data', async () => {
  await withNoAmbientKey(async () => {
    const { rt, calls } = makeRt({ lastSnapshot: null })
    const out = await handleSnapshot(rt)
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'no-data', 'allowCachedFallback 且无旧值时错误码是 no-data')
    assert.ok(calls.credentials > 0, '首次无数据应真正进入前台采集')
    assert.equal(rt.inflight, null)
  })
})
