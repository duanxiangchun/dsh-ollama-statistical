/**
 * 纯解析 / 日历 / 脱敏单测。
 * 只 import lib/index.js 的纯函数，不触碰 DSH 服务、不读真实凭证、不发网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  localDayKey,
  localHourKey,
  maskKey,
  parseBalance,
  parseRetryAfterMs,
  weekStartDate,
} from '../lib/index.js'

/* ------------------------------ parseBalance ------------------------------ */

test('parseBalance: legacy 套餐（5h + 周限额）', () => {
  const body = JSON.stringify({
    included: {
      session: { remaining_percent: 74.36, resets_at: '2026-10-23T09:00:00Z' },
      weekly: { remaining_percent: 16.49, resets_at: '2026-10-26T00:00:00Z' },
    },
    purchased: { balance_usd: 0 },
  })
  const limits = parseBalance(body)
  assert.equal(limits.kind, 'legacy')
  assert.deepEqual(limits.session, {
    usedPercent: 25.64,
    remainingPercent: 74.36,
    resetsAt: '2026-10-23T09:00:00Z',
  })
  assert.deepEqual(limits.weekly, {
    usedPercent: 83.51,
    remainingPercent: 16.49,
    resetsAt: '2026-10-26T00:00:00Z',
  })
  assert.equal(limits.credits, null)
  assert.equal(limits.purchasedUsd, 0)
})

test('parseBalance: remaining_percent 为数字字符串时也能解析', () => {
  const limits = parseBalance({
    included: {
      session: { remaining_percent: '72.39', resets_at: '2026-10-23T09:00:00Z' },
      weekly: { remaining_percent: '16.14', resets_at: '2026-10-26T00:00:00Z' },
    },
  })
  assert.equal(limits.kind, 'legacy')
  assert.equal(limits.session.remainingPercent, 72.39)
  assert.equal(limits.session.usedPercent, 27.61)
  assert.equal(limits.weekly.usedPercent, 83.86)
  assert.equal(limits.purchasedUsd, null)
})

test('parseBalance: 百分比 clamp 到 0..100', () => {
  const limits = parseBalance({
    included: {
      session: { remaining_percent: 130, resets_at: null },
      weekly: { remaining_percent: -5 },
    },
  })
  assert.equal(limits.session.remainingPercent, 100)
  assert.equal(limits.session.usedPercent, 0)
  assert.equal(limits.session.resetsAt, null)
  assert.equal(limits.weekly.remainingPercent, 0)
  assert.equal(limits.weekly.usedPercent, 100)
})

test('parseBalance: 余额制套餐（credits）', () => {
  const limits = parseBalance({
    included: {
      balance_usd: 12.5,
      allowance_usd: 50,
      period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' },
    },
  })
  assert.equal(limits.kind, 'credits')
  assert.equal(limits.session, null)
  assert.equal(limits.weekly, null)
  assert.deepEqual(limits.credits, {
    remainingUsd: 12.5,
    allowanceUsd: 50,
    periodFrom: '2026-10-01T00:00:00Z',
    periodUntil: '2026-11-01T00:00:00Z',
  })
  assert.equal(limits.purchasedUsd, null)
})

test('parseBalance: included 无套餐字段时 kind=none，但保留 purchased 余额', () => {
  const limits = parseBalance({ included: {}, purchased: { balance_usd: 3.25 } })
  assert.equal(limits.kind, 'none')
  assert.equal(limits.session, null)
  assert.equal(limits.weekly, null)
  assert.equal(limits.credits, null)
  assert.equal(limits.purchasedUsd, 3.25)
})

test('parseBalance: 异常响应体抛错', () => {
  assert.throws(() => parseBalance('not json'), /不是合法 JSON/)
  assert.throws(() => parseBalance('[]'), /格式异常/)
  assert.throws(() => parseBalance('null'), /格式异常/)
  assert.throws(() => parseBalance(42), /格式异常/)
})

/* -------------------------------- maskKey -------------------------------- */

test('maskKey: sk- 前缀保留，仅露末 4 位', () => {
  const masked = maskKey('sk-1234567890abcdef')
  assert.equal(masked, 'sk-****cdef')
  assert.ok(masked.endsWith('cdef'))
  assert.ok(masked.includes('****'))
  assert.ok(!masked.includes('1234567890'))
})

test('maskKey: 非 sk- 前缀不露任何前缀（契约承诺仅末 4 位）', () => {
  // 实测本机 Ollama key 是随机串（如 1fdd55...cWjS），不能露出前 3 位。
  const masked = maskKey('1fdd55aa11bb22cc33dd44ee55ffcWjS')
  assert.equal(masked, '****cWjS')
  assert.ok(!masked.startsWith('1fd'))
  assert.ok(!masked.includes('fdd'))
  assert.equal(maskKey('abcdef'), '****cdef')
})

test('maskKey: 短 key / 空值', () => {
  assert.equal(maskKey('abcd'), '****')
  assert.equal(maskKey('abc'), '****')
  assert.equal(maskKey(''), null)
  assert.equal(maskKey('   '), null)
  assert.equal(maskKey(null), null)
  assert.equal(maskKey(undefined), null)
  assert.equal(maskKey(1234), null)
})

/* ------------------------------ weekStartDate ----------------------------- */

const iso = (dayKey) => dayKey

test('weekStartDate: 周五 → 本周一', () => {
  // 2026-10-23 是周五，本周一是 2026-10-19。
  assert.equal(weekStartDate(new Date(2026, 9, 23, 10, 30)), iso('2026-10-19'))
})

test('weekStartDate: 周一当天是自己', () => {
  assert.equal(weekStartDate(new Date(2026, 9, 19, 0, 0, 0)), iso('2026-10-19'))
})

test('weekStartDate: 周日属于上一周', () => {
  assert.equal(weekStartDate(new Date(2026, 9, 25, 23, 59, 59)), iso('2026-10-19'))
})

test('weekStartDate: 跨月边界（2026-11-01 周日 → 10-26）', () => {
  assert.equal(weekStartDate(new Date(2026, 10, 1, 12)), iso('2026-10-26'))
})

test('weekStartDate: 跨年边界（2027-01-01 周五 → 2026-12-28）', () => {
  assert.equal(weekStartDate(new Date(2027, 0, 1, 9)), iso('2026-12-28'))
})

test('weekStartDate: 跨年边界（2026-01-01 周四 → 2025-12-29）', () => {
  assert.equal(weekStartDate(new Date(2026, 0, 1, 9)), iso('2025-12-29'))
})

test('weekStartDate: 接受毫秒时间戳', () => {
  assert.equal(weekStartDate(new Date(2026, 9, 23, 10).getTime()), iso('2026-10-19'))
})

/* ------------------------------- localDayKey ------------------------------ */

test('localDayKey: 本地日历日（含补零）', () => {
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59, 59)), '2026-01-05')
  assert.equal(localDayKey(new Date(2026, 9, 23, 0, 0, 1)), '2026-10-23')
  assert.equal(localDayKey(new Date(2026, 9, 23, 23, 59, 59).getTime()), '2026-10-23')
})

test('localDayKey: 非法日期抛错', () => {
  assert.throws(() => localDayKey(new Date('nope')), /invalid date/)
})

/* ------------------------------ localHourKey ----------------------------- */

test('localHourKey: 本地小时键（补零）', () => {
  assert.equal(localHourKey(new Date(2026, 9, 23, 0, 0, 0)), '2026-10-23T00')
  assert.equal(localHourKey(new Date(2026, 9, 23, 9, 5, 30)), '2026-10-23T09')
  assert.equal(localHourKey(new Date(2026, 9, 23, 14, 30, 0)), '2026-10-23T14')
})

test('localHourKey: 边界 23:59:59 → 23、00:00:00 → 00（本地日历日不串）', () => {
  assert.equal(localHourKey(new Date(2026, 9, 23, 23, 59, 59, 999)), '2026-10-23T23')
  assert.equal(localHourKey(new Date(2026, 9, 23, 0, 0, 0, 0)), '2026-10-23T00')
  // 跨日零点：前一天 23:59:59 与当天 00:00:00 分属两个日键
  assert.equal(localHourKey(new Date(2026, 9, 22, 23, 59, 59).getTime()), '2026-10-22T23')
  assert.equal(localHourKey(new Date(2026, 9, 23, 0, 0, 0).getTime()), '2026-10-23T00')
})

test('localHourKey: 非法日期抛错', () => {
  assert.throws(() => localHourKey(new Date('nope')), /invalid hour key|invalid date/)
})

/* ---------------------------- parseRetryAfterMs --------------------------- */

test('parseRetryAfterMs: 秒数 / HTTP 日期 / 非法值', () => {
  assert.equal(parseRetryAfterMs('120'), 120000)
  assert.equal(parseRetryAfterMs('0'), 0)
  assert.equal(parseRetryAfterMs(null), null)
  assert.equal(parseRetryAfterMs(''), null)
  assert.equal(parseRetryAfterMs('soon'), null)
  const future = Date.now() + 5000
  const parsed = parseRetryAfterMs(new Date(future).toUTCString())
  assert.ok(parsed !== null && parsed >= 3000 && parsed <= 6000)
})
