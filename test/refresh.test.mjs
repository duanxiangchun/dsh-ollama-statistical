/**
 * refresh 15s 最小间隔保护单测：
 *  - shouldThrottleRefresh 纯函数边界；
 *  - handleRefresh 在间隔内直接返回 lastSnapshot（cached:true + rate-limit 说明），
 *    并且完全不进入采集路径（不会调用 ctx.get / 官方网络）；
 *  - 超过 15s 后 handleRefresh 才会走正常采集路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleRefresh, shouldThrottleRefresh } from '../lib/index.js'

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

test('shouldThrottleRefresh: 15s 边界', () => {
  const now = 1_000_000
  assert.equal(shouldThrottleRefresh(now, now - 1000), true)
  assert.equal(shouldThrottleRefresh(now, now - 14999), true)
  assert.equal(shouldThrottleRefresh(now, now - 15000), false, '满 15s 不再限流')
  assert.equal(shouldThrottleRefresh(now, now - 60000), false)
  assert.equal(shouldThrottleRefresh(now, 0), false, '从未采集过不限流')
  assert.equal(shouldThrottleRefresh(now, undefined), false)
  assert.equal(shouldThrottleRefresh(now, now + 5000), false, '时钟回拨不误判')
})

test('handleRefresh: 15s 内直接回 lastSnapshot，不进入采集路径（不打网络）', async () => {
  const value = sampleValue()
  let ctxCalls = 0
  const rt = {
    ctx: {
      get() {
        ctxCalls += 1
        return undefined
      },
    },
    state: { lastSnapshot: value, manualKey: null, lastSnapshotAt: value.updatedAt },
    snapshotCache: null,
    lastCollectAt: Date.now() - 1000,
    rateLimitedUntil: 0,
    inflight: null,
    warm: { running: false, plan: null },
  }
  const out = await handleRefresh(rt)
  assert.equal(out.ok, true)
  assert.equal(out.value.cached, true)
  assert.equal(ctxCalls, 0, '限流命中时不得访问 credentials/sessionQuery 等服务')
  assert.equal(rt.inflight, null, '不得启动采集')
  const rateLimitError = out.value.errors.find(
    (item) => item.source === 'balance' && item.code === 'rate-limit',
  )
  assert.ok(rateLimitError, '必须附 rate-limit 说明')
  assert.match(rateLimitError.message, /15s 最小间隔/)
})

test('handleRefresh: 超过 15s 会进入正常采集路径', async () => {
  await withNoAmbientKey(async () => {
    const value = sampleValue()
    let ctxCalls = 0
    const rt = {
      ctx: {
        get() {
          ctxCalls += 1
          return undefined // 没有 credentials/sessionQuery 服务
        },
      },
      state: { lastSnapshot: value, manualKey: null, lastSnapshotAt: value.updatedAt },
      snapshotCache: null,
      lastCollectAt: Date.now() - 20000,
      rateLimitedUntil: 0,
      inflight: null,
      warm: { running: false, plan: null },
    }
    const out = await handleRefresh(rt)
    assert.ok(ctxCalls > 0, '超过 15s 应真正进入采集（会解析 key 来源）')
    // 没有 key 时走 no-key 降级，而不是限流缓存
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'no-key')
  })
})

test('handleRefresh: 限流且没有任何缓存时才允许穿透采集', async () => {
  await withNoAmbientKey(async () => {
    const rt = {
      ctx: { get: () => undefined },
      state: { lastSnapshot: null, manualKey: null, lastSnapshotAt: null },
      snapshotCache: null,
      lastCollectAt: Date.now() - 1000,
      rateLimitedUntil: 0,
      inflight: null,
      warm: { running: false, plan: null },
    }
    const out = await handleRefresh(rt)
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'no-key')
  })
})
