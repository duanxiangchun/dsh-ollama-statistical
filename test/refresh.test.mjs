/**
 * refresh 15s 最小间隔保护单测：
 *  - shouldThrottleRefresh 纯函数边界；
 *  - handleRefresh 在间隔内直接返回 lastSnapshot（cached:true + rate-limit 说明），
 *    并且完全不进入采集路径（不会调用 ctx.get / 官方网络）；
 *  - 超过 15s 后 handleRefresh 才会走正常采集路径（v0.9 起没有 Key 也返回 ok:true +
 *    本机 token 统计，见契约 §8）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleRefresh, shouldThrottleRefresh } from '../lib/index.js'

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
    // v0.9（契约 §8）：Key 可选 —— 两个 key 都没有也返回 ok:true + 本机 token 统计
    assert.equal(out.ok, true)
    assert.equal(out.value.cached, false)
    assert.deepEqual(out.value.key, { source: 'none', masked: null })
    assert.equal(out.value.limits.kind, 'none')
    assert.equal(out.value.official.range24h, null)
    assert.equal(out.value.opencode.configured, false)
    assert.equal(out.value.tokens.days.length, 30)
    assert.equal(out.value.tokens.providers.length, 0)
    assert.equal(out.value.errors.some((item) => item.source === 'key'), false, '新 host 不再产生 no-key')
    // 没有 sessionQuery 服务时 tokens 独立降级为 internal，不阻塞整包
    assert.ok(out.value.errors.some((item) => item.source === 'tokens' && item.code === 'internal'))
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
    // v0.9：穿透采集后没有 Key 也返回 ok:true（不再 no-key/no-data）
    assert.equal(out.ok, true)
    assert.equal(out.value.key.source, 'none')
    assert.equal(out.value.tokens.days.length, 30)
    assert.equal(out.value.errors.some((item) => item.source === 'key'), false)
  })
})
