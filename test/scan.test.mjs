/**
 * 前台扫描（缓存优先 + 短预算切片）与 scan 统计（covered/pending/partial）单测。
 * 全部注入依赖（时钟 / 缓存 / readSession / 聚合器），不碰真实会话日志。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { runForegroundScan, summarizeTokenScan } from '../lib/index.js'

const foldFor = (requests) => ({ requests, perDay: {}, perModel: {} })
const record = (id, createdAt = 1000, live = false) => ({ header: { id, createdAt }, live })

function cacheOf(entries) {
  return (sessionId) => entries[sessionId] || null
}

/* ------------------------------ summarizeTokenScan ----------------------------- */

test('summarizeTokenScan: covered + pending == candidates，partial 语义', () => {
  const scan = summarizeTokenScan({
    sessions: 773,
    candidates: 522,
    scanned: 58,
    fromCache: 100,
    covered: 158,
    failures: 0,
    elapsedMs: 8001,
  })
  assert.deepEqual(scan, {
    sessions: 773,
    candidates: 522,
    scanned: 58,
    fromCache: 100,
    covered: 158,
    pending: 364,
    elapsedMs: 8001,
    partial: true,
  })

  const done = summarizeTokenScan({ candidates: 522, covered: 522 })
  assert.equal(done.pending, 0)
  assert.equal(done.partial, false)
})

test('summarizeTokenScan: 读取失败即使 pending=0 也置 partial', () => {
  const scan = summarizeTokenScan({ candidates: 2, covered: 2, failures: 1 })
  assert.equal(scan.pending, 0)
  assert.equal(scan.partial, true)
})

test('summarizeTokenScan: covered 超过 candidates 时裁剪，缺失字段归 0', () => {
  const clamped = summarizeTokenScan({ candidates: 2, covered: 5 })
  assert.equal(clamped.covered, 2)
  assert.equal(clamped.pending, 0)

  const empty = summarizeTokenScan({})
  assert.deepEqual(empty, {
    sessions: 0,
    candidates: 0,
    scanned: 0,
    fromCache: 0,
    covered: 0,
    pending: 0,
    elapsedMs: 0,
    partial: false,
  })
})

/* ------------------------------ runForegroundScan ----------------------------- */

test('runForegroundScan: 非 live 且缓存命中时不 readSession（缓存优先聚合）', async () => {
  let readCalls = 0
  const candidates = [record('a'), record('b'), record('c')]
  const result = await runForegroundScan({
    candidates,
    isLive: () => false,
    getCachedFold: cacheOf({
      a: { createdAt: 1000, fold: foldFor(1) },
      b: { createdAt: 1000, fold: foldFor(2) },
      c: { createdAt: 1000, fold: foldFor(3) },
    }),
    readSession: async () => {
      readCalls += 1
      return { events: [] }
    },
  })
  assert.equal(readCalls, 0)
  assert.equal(result.fromCache, 3)
  assert.equal(result.scanned, 0)
  assert.equal(result.covered, 3)
  assert.equal(result.pendingCount, 0)
  assert.equal(result.candidates, 3)
  assert.equal(result.folds.length, 3)
  assert.equal(result.partial, false)
})

test('runForegroundScan: live 会话即使有缓存也重读', async () => {
  let readCalls = 0
  const result = await runForegroundScan({
    candidates: [record('live', 1000, true)],
    isLive: (item) => item.live === true,
    getCachedFold: () => ({ createdAt: 1000, fold: foldFor(9) }),
    readSession: async () => {
      readCalls += 1
      return { events: [] }
    },
    aggregate: () => foldFor(4),
  })
  assert.equal(readCalls, 1)
  assert.equal(result.fromCache, 0)
  assert.equal(result.scanned, 1)
  assert.equal(result.covered, 1)
  assert.equal(result.folds[0].fold.requests, 4)
})

test('runForegroundScan: createdAt 不一致的缓存视为失效，重新读', async () => {
  let readCalls = 0
  const result = await runForegroundScan({
    candidates: [record('x', 1000)],
    isLive: () => false,
    getCachedFold: () => ({ createdAt: 999, fold: foldFor(1) }),
    readSession: async () => {
      readCalls += 1
      return { events: [] }
    },
    aggregate: () => foldFor(1),
  })
  assert.equal(readCalls, 1)
  assert.equal(result.fromCache, 0)
  assert.equal(result.scanned, 1)
  assert.equal(result.covered, 1)
})

test('runForegroundScan: 前台预算到点立刻停，剩余进 pending（partial=true）', async () => {
  let clock = 0
  let readCalls = 0
  const candidates = Array.from({ length: 10 }, (_, index) => record('s' + index))
  const result = await runForegroundScan({
    candidates,
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async () => {
      readCalls += 1
      clock += 60 // 每次读取耗时 60ms
      return { events: [] }
    },
    aggregate: () => foldFor(1),
    now: () => clock,
    budgetMs: 100,
    maxSessions: 400,
  })
  // 读取 1 时 clock 0<100；读取 2 时 clock 60<100；之后 clock=120≥100 → 停
  assert.equal(readCalls, 2)
  assert.equal(result.scanned, 2)
  assert.equal(result.covered, 2)
  assert.equal(result.pendingCount, 8)
  assert.equal(result.candidates, 10)
  assert.equal(result.covered + result.pendingCount, result.candidates)
  assert.equal(result.partial, true)
  assert.equal(result.pending.length, 8)
})

test('runForegroundScan: MAX_SCAN_SESSIONS 上限同样生效', async () => {
  let clock = 0
  const candidates = Array.from({ length: 10 }, (_, index) => record('s' + index))
  const result = await runForegroundScan({
    candidates,
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async () => {
      clock += 1
      return { events: [] }
    },
    aggregate: () => foldFor(1),
    now: () => clock,
    budgetMs: 10000,
    maxSessions: 3,
  })
  assert.equal(result.scanned, 3)
  assert.equal(result.covered, 3)
  assert.equal(result.pendingCount, 7)
  assert.equal(result.partial, true)
})

test('runForegroundScan: 预算为 0 时一次都不读，全部 pending', async () => {
  let readCalls = 0
  const result = await runForegroundScan({
    candidates: [record('a'), record('b')],
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async () => {
      readCalls += 1
      return { events: [] }
    },
    budgetMs: 0,
  })
  assert.equal(readCalls, 0)
  assert.equal(result.covered, 0)
  assert.equal(result.pendingCount, 2)
  assert.equal(result.partial, true)
})

test('runForegroundScan: 读取失败计入 failures / pending，不影响其他会话', async () => {
  const result = await runForegroundScan({
    candidates: [record('ok'), record('bad')],
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async (sessionId) => {
      if (sessionId === 'bad') throw new Error('boom')
      return { events: [] }
    },
    aggregate: () => foldFor(1),
  })
  assert.equal(result.scanned, 2)
  assert.equal(result.scannedSuccess, 1)
  assert.equal(result.failures, 1)
  assert.equal(result.covered, 1)
  assert.equal(result.pendingCount, 1)
  assert.equal(result.pending[0].header.id, 'bad')
  assert.equal(result.partial, true)
})

test('runForegroundScan: storeFold 只在读取成功后调用；重复 sessionId 去重', async () => {
  const stored = []
  const result = await runForegroundScan({
    candidates: [record('a', 1000), record('a', 1000), record('b', 1000)],
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async () => ({ events: [] }),
    aggregate: () => foldFor(1),
    storeFold: (item, fold) => stored.push({ id: item.header.id, requests: fold.requests }),
  })
  assert.equal(result.candidates, 2)
  assert.deepEqual(
    stored.map((item) => item.id),
    ['a', 'b'],
  )
  assert.equal(result.covered, 2)
  assert.equal(result.pendingCount, 0)
})

test('runForegroundScan: 没有 readSession 时安全降级为全部 pending', async () => {
  const result = await runForegroundScan({
    candidates: [record('a')],
    isLive: () => false,
    getCachedFold: () => null,
    readSession: null,
  })
  assert.equal(result.scanned, 0)
  assert.equal(result.pendingCount, 1)
  assert.equal(result.partial, true)
})
