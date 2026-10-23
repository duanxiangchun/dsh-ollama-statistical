/**
 * 前台扫描（缓存优先 + 短预算切片 + 失败记忆）与 scan 统计单测。
 * 全部注入依赖（时钟 / 缓存 / readSession / 聚合器），不碰真实会话日志。
 *
 * scan 新语义（v3）：
 *   covered + failed + pending === candidates
 *   pending = max(0, candidates - covered - failed)
 *   partial = pending > 0（failed 不再钉死 partial）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWarmStats,
  isSessionFailed,
  noteScanFailure,
  runForegroundScan,
  summarizeTokenScan,
  warmSlice,
} from '../lib/index.js'

const foldFor = (requests) => ({ requests, perDay: {}, perDayModel: {} })
const record = (id, createdAt = 1000, live = false, formatStatus) => ({
  header: { id, createdAt },
  live,
  ...(formatStatus === undefined ? {} : { formatStatus }),
})

function cacheOf(entries) {
  return (sessionId) => entries[sessionId] || null
}

/* ------------------------------ summarizeTokenScan ----------------------------- */

test('summarizeTokenScan: covered + failed + pending === candidates，partial=pending>0', () => {
  const scan = summarizeTokenScan({
    sessions: 775,
    candidates: 688,
    scanned: 20,
    fromCache: 643,
    covered: 663,
    failed: 25,
    elapsedMs: 8001,
  })
  assert.deepEqual(scan, {
    sessions: 775,
    candidates: 688,
    scanned: 20,
    fromCache: 643,
    covered: 663,
    failed: 25,
    retired: 0,
    pending: 0,
    elapsedMs: 8001,
    partial: false,
  })
  assert.equal(scan.covered + scan.failed + scan.pending, scan.candidates)
})

test('summarizeTokenScan: pending 存在才 partial；failed 不再置 partial', () => {
  const doneWithFailures = summarizeTokenScan({ candidates: 2, covered: 1, failed: 1 })
  assert.equal(doneWithFailures.pending, 0)
  assert.equal(doneWithFailures.partial, false, 'failed 不钉死 partial')

  const incomplete = summarizeTokenScan({ candidates: 10, covered: 5, failed: 2 })
  assert.equal(incomplete.pending, 3)
  assert.equal(incomplete.partial, true)
})

test('summarizeTokenScan: 容错旧参数名 failures，并裁剪越界值', () => {
  const legacy = summarizeTokenScan({ candidates: 2, covered: 1, failures: 1 })
  assert.equal(legacy.failed, 1)
  assert.equal(legacy.pending, 0)

  const clamped = summarizeTokenScan({ candidates: 2, covered: 2, failed: 5 })
  assert.equal(clamped.covered, 2)
  assert.equal(clamped.failed, 0)
  assert.equal(clamped.pending, 0)

  const empty = summarizeTokenScan({})
  assert.deepEqual(empty, {
    sessions: 0,
    candidates: 0,
    scanned: 0,
    fromCache: 0,
    covered: 0,
    failed: 0,
    retired: 0,
    pending: 0,
    elapsedMs: 0,
    partial: false,
  })
})

/* ------------------------------- 失败记忆（TTL） ------------------------------- */

test('noteScanFailure / isSessionFailed: 6h 内命中，过期后删除并允许重试', () => {
  const rt = { scanFailures: new Map(), cacheDirty: false }
  const now = 1_000_000_000
  noteScanFailure(rt, record('bad'), new Error('replay validation failed'), now)
  assert.equal(rt.scanFailures.size, 1)
  assert.equal(rt.cacheDirty, true)

  assert.equal(isSessionFailed(rt, 'bad', now + 1000), true)
  // 5.9h 仍算失败；6h 整过期 → 删除并返回 false（下一次会重试一次）
  assert.equal(isSessionFailed(rt, 'bad', now + 6 * 60 * 60 * 1000 - 1000), true)
  assert.equal(isSessionFailed(rt, 'bad', now + 6 * 60 * 60 * 1000), false)
  assert.equal(rt.scanFailures.has('bad'), false)
  assert.equal(isSessionFailed(rt, 'unknown', now), false)
})

test('noteScanFailure: 旧格式会话的 message 带迁移提示', () => {
  const rt = { scanFailures: new Map(), cacheDirty: false }
  const entry = noteScanFailure(rt, record('legacy', 1000, false, 'migration-required'), 'fail-closed')
  assert.match(entry.message, /fail-closed/)
  assert.match(entry.message, /旧格式.*迁移/)
  const plain = noteScanFailure(rt, record('broken'), 'boom')
  assert.doesNotMatch(plain.message, /旧格式/)
})

/* ------------------------------ runForegroundScan ----------------------------- */

test('runForegroundScan: 非 live 且缓存命中时不 readSession（缓存优先聚合）', async () => {
  let readCalls = 0
  const result = await runForegroundScan({
    candidates: [record('a'), record('b'), record('c')],
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
  assert.equal(result.failed, 0)
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

test('runForegroundScan: 已知失败（TTL 内）不 readSession，直接计 failed 且不进 pending', async () => {
  let readCalls = 0
  const result = await runForegroundScan({
    candidates: [record('bad'), record('ok')],
    isLive: () => false,
    getCachedFold: () => null,
    isKnownFailed: (sessionId) => sessionId === 'bad',
    readSession: async () => {
      readCalls += 1
      return { events: [] }
    },
    aggregate: () => foldFor(1),
  })
  assert.equal(readCalls, 1, '已知失败会话不得再读取')
  assert.equal(result.covered, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.failedIds, ['bad'])
  assert.equal(result.pendingCount, 0)
  assert.equal(result.partial, false)
  assert.equal(result.covered + result.failed + result.pendingCount, result.candidates)
})

test('runForegroundScan: 读取失败计入 failed（不占 pending）、记录 onFailure、成功后 clearFailure', async () => {
  const failures = []
  const cleared = []
  const result = await runForegroundScan({
    candidates: [record('ok'), record('bad')],
    isLive: () => false,
    getCachedFold: () => null,
    readSession: async (sessionId) => {
      if (sessionId === 'bad') throw new Error('boom')
      return { events: [] }
    },
    aggregate: () => foldFor(1),
    onFailure: (item, error) => failures.push({ id: item.header.id, message: error.message }),
    clearFailure: (sessionId) => cleared.push(sessionId),
  })
  assert.equal(result.scanned, 2)
  assert.equal(result.scannedSuccess, 1)
  assert.equal(result.failures, 1)
  assert.equal(result.covered, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.failedIds, ['bad'])
  assert.equal(result.pendingCount, 0)
  assert.equal(result.partial, false)
  assert.deepEqual(failures, [{ id: 'bad', message: 'boom' }])
  assert.deepEqual(cleared, ['ok'])
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
  assert.equal(result.failed, 0)
  assert.equal(result.pendingCount, 8)
  assert.equal(result.candidates, 10)
  assert.equal(result.covered + result.failed + result.pendingCount, result.candidates)
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

/* --------------------------------- warm 单测 ---------------------------------- */

function makeWarmRt() {
  return { warm: { cancelled: false }, tokenCache: new Map(), cacheDirty: false }
}

function makeWarmPlan(overrides = {}) {
  return {
    sessionQuery: { readSession: async () => ({ events: [] }) },
    isLive: () => false,
    todayKey: '2026-10-23',
    sessionsTotal: 775,
    candidateCount: 10,
    coveredIds: new Set(),
    failedIds: new Set(),
    pending: [],
    fromCache: 0,
    scanned: 0,
    failures: 0,
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60000,
    ...overrides,
  }
}

test('buildWarmStats: failed 不进入 pending（covered+failed+pending=candidates）', () => {
  const rt = makeWarmRt()
  const completed = makeWarmPlan({
    coveredIds: new Set(Array.from({ length: 8 }, (_, index) => 'c' + index)),
    failedIds: new Set(['bad1', 'bad2']),
  })
  const stats = buildWarmStats(rt, completed)
  assert.equal(stats.scan.candidates, 10)
  assert.equal(stats.scan.covered, 8)
  assert.equal(stats.scan.failed, 2)
  assert.equal(stats.scan.pending, 0)
  assert.equal(stats.scan.partial, false, 'failed 存在但 pending=0 → 不 partial')

  const inProgress = makeWarmPlan({
    coveredIds: new Set(['a', 'b', 'c']),
    failedIds: new Set(['bad1']),
  })
  const inProgressStats = buildWarmStats(rt, inProgress)
  assert.equal(inProgressStats.scan.pending, 6)
  assert.equal(inProgressStats.scan.partial, true)
})

test('warmSlice: 已知失败/读取失败都计入 failed 且从队列移除，不阻塞 warm 完成', async () => {
  const rt = makeWarmRt()
  const failures = []
  const plan = makeWarmPlan({
    pending: [record('known-bad'), record('read-bad'), record('ok')],
    isKnownFailed: (sessionId) => sessionId === 'known-bad',
    onFailure: (item, error) => failures.push({ id: item.header.id, message: error.message }),
    sessionQuery: {
      readSession: async (sessionId) => {
        if (sessionId === 'read-bad') throw new Error('replay invalid')
        return { events: [] }
      },
    },
  })
  await warmSlice(rt, plan)
  assert.equal(plan.pending.length, 0, 'pending 必须清空，否则 warm 永远跑不完')
  assert.deepEqual([...plan.failedIds].sort(), ['known-bad', 'read-bad'])
  assert.deepEqual([...plan.coveredIds], ['ok'])
  assert.equal(plan.failures, 1, '只有真正 readSession 失败的才计 failures')
  assert.deepEqual(failures, [{ id: 'read-bad', message: 'replay invalid' }])

  // 进度：covered 1 + failed 2 + pending 7 = candidates 10，仍 partial；补满 covered 后 partial=false
  const stats = buildWarmStats(rt, plan)
  assert.equal(stats.scan.pending, 7)
  assert.equal(stats.scan.partial, true)

  plan.coveredIds = new Set(Array.from({ length: 8 }, (_, index) => 'x' + index))
  const doneStats = buildWarmStats(rt, plan)
  assert.equal(doneStats.scan.pending, 0)
  assert.equal(doneStats.scan.partial, false)
  assert.equal(doneStats.scan.failed, 2)
})
