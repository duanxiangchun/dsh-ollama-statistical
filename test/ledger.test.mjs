/**
 * 墓碑账本（ledger.json）单测：
 *  - 会话从 listSessions 消失 → fold 进 retired，聚合仍含其 token（数字不缩水）、scan.retired 计数；
 *  - 会话恢复（重新出现在 listSessions）→ 清墓碑、不双计；
 *  - 窗口外 known/retired 被修剪，retired 的 fold 无窗口内日期也删除；
 *  - ledger.json 读坏 → 空账本降级；写失败（目录被文件占位）→ 返回 false 且不影响调用方；
 *  - 与 failed 共存：读失败但仍在 listSessions 的会话不算 retired；
 *  - buildWarmStats 并入 retired（warm 期间数字不掉）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateTokenStats,
  buildWarmStats,
  loadLedger,
  persistLedger,
  reconcileLedger,
  summarizeTokenScan,
} from '../lib/index.js'

const WINDOW_DAY = '2026-10-23'

const bucket = (total, requests = 1) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total,
  requests,
})

/** 构造与 aggregateSessionEvents 同形状的 fold（日 + 日模型）。 */
function foldWith(day, total, requests = 1, model = 'm1') {
  return {
    requests,
    perDay: { [day]: bucket(total, requests) },
    perDayModel: { [day]: { [model]: bucket(total, requests) } },
  }
}

const WINDOW_KEYS = new Set([WINDOW_DAY])
const CANDIDATE_MIN_MS = 1000

/* ------------------------------- reconcileLedger ------------------------------ */

test('reconcileLedger: 首次 covered 写 known 会标记 changed（账本必须落盘）', () => {
  const known = new Map()
  const args = {
    known,
    retired: new Map(),
    tokenCache: new Map(),
    currentIds: new Set(['a']),
    covered: [{ id: 'a', createdAt: 5000 }],
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  }
  const first = reconcileLedger(args)
  assert.equal(first.changed, true)
  assert.deepEqual([...known.keys()], ['a'])

  // 同样的输入再来一次 → 没有变化，不需要重复写盘
  const second = reconcileLedger({ ...args, known })
  assert.equal(second.changed, false)
})

test('reconcileLedger: 会话消失 → 移入 retired 并保留 fold（token 不缩水）', () => {
  const known = new Map([['gone', { createdAt: 5000 }]])
  const retired = new Map()
  const tokenCache = new Map([['gone', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 100, 3) }]])
  const currentIds = new Set() // 已从 listSessions 消失

  const reconciled = reconcileLedger({
    known,
    retired,
    tokenCache,
    currentIds,
    covered: [],
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  })
  assert.equal(reconciled.changed, true)
  assert.equal(known.has('gone'), false)
  assert.equal(tokenCache.has('gone'), false)
  assert.ok(retired.has('gone'))
  assert.equal(retired.get('gone').createdAt, 5000)
  assert.equal(reconciled.retiredCount, 1)
  assert.equal(reconciled.retiredFolds.length, 1)

  // 删除前后聚合结果一致（数字不缩水）
  const before = aggregateTokenStats([{ id: 'gone', fold: foldWith(WINDOW_DAY, 100, 3) }], {
    today: WINDOW_DAY,
    windowDays: 30,
  })
  const after = aggregateTokenStats(reconciled.retiredFolds, { today: WINDOW_DAY, windowDays: 30 })
  const sum = (stats) => stats.days.reduce((total, day) => total + day.total, 0)
  assert.equal(sum(after), sum(before))
  assert.equal(sum(after), 100)
})

test('reconcileLedger: 会话恢复（重新出现在 listSessions）→ 清墓碑、不双计', () => {
  const known = new Map()
  const retired = new Map([['back', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 100, 3) }]])
  const tokenCache = new Map()
  const currentIds = new Set(['back'])

  const reconciled = reconcileLedger({
    known,
    retired,
    tokenCache,
    currentIds,
    covered: [{ id: 'back', createdAt: 5000 }],
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  })
  assert.equal(retired.has('back'), false, '复活必须清墓碑')
  assert.equal(known.has('back'), true)
  assert.equal(reconciled.retiredFolds.length, 0)

  // 聚合只算恢复后的新 fold 一次，不含旧墓碑 fold
  const fresh = foldWith(WINDOW_DAY, 50, 2)
  const aggregated = aggregateTokenStats([{ id: 'back', fold: fresh }], {
    today: WINDOW_DAY,
    windowDays: 30,
  })
  const total = aggregated.days.reduce((sum, day) => sum + day.total, 0)
  assert.equal(total, 50)
})

test('reconcileLedger: 会话回到 listSessions 但本次还没扫到（pending）也不能双计', () => {
  const retired = new Map([['pending-back', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 100, 3) }]])
  const reconciled = reconcileLedger({
    known: new Map(),
    retired,
    tokenCache: new Map(),
    currentIds: new Set(['pending-back']),
    covered: [],
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  })
  assert.equal(retired.has('pending-back'), false, '只要还在 listSessions 就不再算墓碑')
  assert.equal(reconciled.retiredFolds.length, 0)
})

test('reconcileLedger: 修剪窗口外 known/retired 与无窗口内日期的 retired', () => {
  const known = new Map([
    ['old-known', { createdAt: 500 }],
    ['fresh-known', { createdAt: 5000 }],
  ])
  const retired = new Map([
    ['old-retired', { createdAt: 500, fold: foldWith(WINDOW_DAY, 10) }],
    ['outside-window', { createdAt: 5000, fold: foldWith('2026-01-01', 20) }],
    ['windowed', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 30) }],
  ])
  const reconciled = reconcileLedger({
    known,
    retired,
    tokenCache: new Map(),
    currentIds: new Set(['fresh-known']),
    covered: [],
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  })
  assert.deepEqual([...known.keys()], ['fresh-known'])
  assert.deepEqual([...retired.keys()], ['windowed'])
  assert.equal(reconciled.retiredCount, 1)
})

test('reconcileLedger: 读失败但仍在 listSessions 的会话不算 retired', () => {
  const known = new Map([['failed-but-alive', { createdAt: 5000 }]])
  const retired = new Map()
  const tokenCache = new Map([['failed-but-alive', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 10) }]])
  const reconciled = reconcileLedger({
    known,
    retired,
    tokenCache,
    currentIds: new Set(['failed-but-alive']),
    covered: [], // 本次读取失败 → 不在 covered
    candidateMinMs: CANDIDATE_MIN_MS,
    windowKeys: WINDOW_KEYS,
  })
  assert.equal(retired.has('failed-but-alive'), false)
  assert.equal(known.has('failed-but-alive'), true, '仍在的会话保留 known，等下次读取')
  assert.equal(tokenCache.has('failed-but-alive'), true, '缓存不能被当成删除清掉')
  assert.equal(reconciled.changed, false)
})

test('summarizeTokenScan: retired 是独立字段，不参与 covered/failed/pending 恒等式', () => {
  const scan = summarizeTokenScan({ sessions: 2, candidates: 2, covered: 2, failed: 0, retired: 5 })
  assert.equal(scan.retired, 5)
  assert.equal(scan.covered + scan.failed + scan.pending, scan.candidates)
  assert.equal(scan.partial, false)
})

/* --------------------------- ledger.json 读 / 写 ---------------------------- */

async function withTempDshHome(run) {
  const saved = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-ollama-ledger-'))
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

function emptyLedgerRt() {
  return { ledger: { known: new Map(), retired: new Map() }, ledgerDirty: false }
}

test('loadLedger: 文件损坏 / 版本不符 → 空账本降级，不抛错', async () => {
  await withTempDshHome(async (home) => {
    const dir = join(home, 'storages', 'ollama-statistical')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.json'), '{not valid json')
    const rt = emptyLedgerRt()
    const loaded = loadLedger(rt)
    assert.equal(loaded.loaded, false)
    assert.equal(rt.ledger.known.size, 0)
    assert.equal(rt.ledger.retired.size, 0)

    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ version: 999, known: {} }))
    assert.equal(loadLedger(emptyLedgerRt()).loaded, false)
  })
})

test('persistLedger / loadLedger: 落盘后可回读（known + retired fold）', async () => {
  await withTempDshHome(async () => {
    const rt = emptyLedgerRt()
    rt.ledger.known.set('alive', { createdAt: 5000 })
    rt.ledger.retired.set('gone', { createdAt: 4000, fold: foldWith(WINDOW_DAY, 100) })
    rt.ledgerDirty = true
    assert.equal(persistLedger(rt), true)
    assert.equal(rt.ledgerDirty, false, '写成功后 dirty 清除')
    assert.equal(persistLedger(rt), false, '无变更时不重复写')

    const restored = emptyLedgerRt()
    const loaded = loadLedger(restored)
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.known, 1)
    assert.equal(loaded.retired, 1)
    assert.equal(restored.ledger.known.get('alive').createdAt, 5000)
    assert.equal(restored.ledger.retired.get('gone').fold.perDay[WINDOW_DAY].total, 100)
  })
})

test('persistLedger: 写失败（storages 路径被文件占位）→ 返回 false 不抛错，主流程可继续', async () => {
  await withTempDshHome(async (home) => {
    // 在 DSH_HOME 下放一个名为 storages 的普通文件，mkdirSync 会失败 → writeJsonAtomic 返回 false
    writeFileSync(join(home, 'storages'), 'blocker')
    const rt = emptyLedgerRt()
    rt.ledger.known.set('alive', { createdAt: 5000 })
    rt.ledgerDirty = true
    let thrown = null
    let written = null
    try {
      written = persistLedger(rt)
    } catch (error) {
      thrown = error
    }
    assert.equal(thrown, null, '写失败不能抛出影响主流程')
    assert.equal(written, false)
    assert.equal(rt.ledgerDirty, true, '失败时保留 dirty，下次再试')
    assert.equal(loadLedger(emptyLedgerRt()).loaded, false, '读失败同样降级为空账本')
  })
})

/* ------------------------------ warm 并入 retired ----------------------------- */

test('buildWarmStats: warm 期间也并入 retired，且不与 covered 双计', () => {
  const rt = {
    tokenCache: new Map([['alive', { createdAt: 5000, fold: foldWith(WINDOW_DAY, 100, 1) }]]),
  }
  const plan = {
    todayKey: WINDOW_DAY,
    sessionsTotal: 3,
    candidateCount: 1,
    coveredIds: new Set(['alive']),
    failedIds: new Set(),
    retiredFolds: [
      { id: 'gone', fold: foldWith(WINDOW_DAY, 50, 2) },
      { id: 'alive', fold: foldWith(WINDOW_DAY, 999, 9) }, // 防御：与 covered 重叠的墓碑要被过滤
    ],
    fromCache: 0,
    scanned: 1,
    failures: 0,
    startedAt: Date.now(),
  }
  const stats = buildWarmStats(rt, plan)
  assert.equal(stats.scan.retired, 1, '只统计真正并入的墓碑数')
  const total = stats.days.reduce((sum, day) => sum + day.total, 0)
  assert.equal(total, 150, 'covered 100 + retired 50，重叠的 999 不计')
})
