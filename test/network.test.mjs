/**
 * 官方 HTTP 分支单测（stub 全局 fetch，不发真实网络请求）：
 *  - 200 合法 JSON / 非 JSON；
 *  - 401/403 → unauthorized、其他非 2xx → http；
 *  - 429 → rate-limit + Retry-After 解析（含缺省 60s）；
 *  - 超时/AbortError → network；
 *  - collectOfficial 的 429 冷却窗口写入 rt.rateLimitedUntil，以及 allNetworkFailed 标记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectOfficial, parseRetryAfterMs, requestJson } from '../lib/index.js'

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

const URL_BALANCE = 'https://ollama.com/api/balance'

test('requestJson: 200 合法 JSON', async () => {
  await withFetch(
    async () => new Response('{"included":{"session":{"remaining_percent":70.83}}}', { status: 200 }),
    async () => {
      const result = await requestJson(URL_BALANCE, 'secret')
      assert.equal(result.ok, true)
      assert.equal(result.status, 200)
      assert.equal(result.json.included.session.remaining_percent, 70.83)
    },
  )
})

test('requestJson: 200 非 JSON → internal', async () => {
  await withFetch(
    async () => new Response('<html>oops</html>', { status: 200 }),
    async () => {
      const result = await requestJson(URL_BALANCE, 'secret')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'internal')
      assert.match(result.message, /不是合法 JSON/)
    },
  )
})

test('requestJson: 401/403 → unauthorized', async () => {
  for (const status of [401, 403]) {
    await withFetch(
      async () => new Response('nope', { status }),
      async () => {
        const result = await requestJson(URL_BALANCE, 'secret')
        assert.equal(result.ok, false)
        assert.equal(result.code, 'unauthorized')
        assert.equal(result.status, status)
      },
    )
  }
})

test('requestJson: 500 → http', async () => {
  await withFetch(
    async () => new Response('boom', { status: 500 }),
    async () => {
      const result = await requestJson(URL_BALANCE, 'secret')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'http')
      assert.equal(result.status, 500)
    },
  )
})

test('requestJson: 429 + Retry-After 秒数 → rate-limit 且 retryAfterMs 正确', async () => {
  await withFetch(
    async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    async () => {
      const result = await requestJson(URL_BALANCE, 'secret')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'rate-limit')
      assert.equal(result.retryAfterMs, 7000)
      assert.match(result.message, /7 秒/)
    },
  )
})

test('requestJson: 429 无 Retry-After → 默认 60s 冷却', async () => {
  await withFetch(
    async () => new Response('slow down', { status: 429 }),
    async () => {
      const result = await requestJson(URL_BALANCE, 'secret')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'rate-limit')
      assert.equal(result.retryAfterMs, 60000)
    },
  )
})

test('requestJson: 超时（TimeoutError）/ AbortError → network', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    await withFetch(
      async () => {
        throw Object.assign(new Error('aborted'), { name })
      },
      async () => {
        const result = await requestJson(URL_BALANCE, 'secret')
        assert.equal(result.ok, false)
        assert.equal(result.code, 'network')
        if (name === 'TimeoutError') assert.match(result.message, /超时/)
      },
    )
  }
})

test('parseRetryAfterMs: HTTP 日期形式', () => {
  const future = new Date(Date.now() + 10000).toUTCString()
  const parsed = parseRetryAfterMs(future)
  assert.ok(parsed !== null && parsed >= 8000 && parsed <= 11000)
})

/* ------------------------------- collectOfficial ------------------------------ */

function fakeResponseFor(url, override) {
  if (override !== undefined) return override(url)
  if (url === URL_BALANCE) {
    return new Response(
      JSON.stringify({
        included: {
          session: { remaining_percent: 70.83, resets_at: '2026-10-23T09:00:00Z' },
          weekly: { remaining_percent: 15.87, resets_at: '2026-10-26T00:00:00Z' },
        },
        purchased: { balance_usd: 0 },
      }),
      { status: 200 },
    )
  }
  return new Response(
    JSON.stringify({
      range: url.includes('24h') ? '24h' : url.includes('7d') ? '7d' : '30d',
      granularity: url.includes('24h') ? 'hour' : 'day',
      totals: { request_count: 10 },
      buckets: [{ from: '2026-10-22T00:00:00Z', until: '2026-10-23T00:00:00Z', request_count: 10 }],
    }),
    { status: 200 },
  )
}

test('collectOfficial: 全 200 时 limits/official 解析成功且无 errors', async () => {
  await withFetch(
    async (url) => fakeResponseFor(url),
    async () => {
      const rt = { rateLimitedUntil: 0 }
      const result = await collectOfficial(rt, 'secret')
      assert.deepEqual(result.errors, [])
      assert.equal(result.allNetworkFailed, false)
      assert.equal(result.limits.kind, 'legacy')
      assert.equal(result.limits.session.usedPercent, 29.17)
      assert.equal(result.official.range24h.requestCount, 10)
      assert.equal(rt.rateLimitedUntil, 0)
    },
  )
})

test('collectOfficial: 429 时四个请求都降级并写入冷却窗口', async () => {
  await withFetch(
    async () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } }),
    async () => {
      const rt = { rateLimitedUntil: 0 }
      const before = Date.now()
      const result = await collectOfficial(rt, 'secret')
      assert.equal(result.errors.length, 4)
      assert.ok(result.errors.every((item) => item.code === 'rate-limit'))
      assert.equal(result.limits.kind, 'none')
      assert.equal(result.official.range24h, null)
      assert.ok(rt.rateLimitedUntil >= before + 4000, '冷却窗口应按 Retry-After 生效')
    },
  )
})

test('collectOfficial: 24h/7d/30d 按今天/本周/本月窗口重过滤（now 可注入）', async () => {
  await withFetch(
    async (url) => {
      if (url === URL_BALANCE) return fakeResponseFor(url)
      const is24h = url.includes('24h')
      return new Response(
        JSON.stringify({
          range: is24h ? '24h' : url.includes('7d') ? '7d' : '30d',
          granularity: is24h ? 'hour' : 'day',
          totals: { request_count: 100 },
          buckets: is24h
            ? [
                { from: '2026-10-24T23:00:00Z', until: '2026-10-25T00:00:00Z', request_count: 30 },
                { from: '2026-10-25T00:00:00Z', until: '2026-10-25T01:00:00Z', request_count: 55 },
                { from: '2026-10-25T11:00:00Z', until: '2026-10-25T12:00:00Z', partial: true, request_count: 15 },
              ]
            : [
                { from: '2026-10-18T00:00:00Z', until: '2026-10-19T00:00:00Z', request_count: 40 },
                { from: '2026-10-19T00:00:00Z', until: '2026-10-20T00:00:00Z', request_count: 60 },
              ],
        }),
        { status: 200 },
      )
    },
    async () => {
      const rt = { rateLimitedUntil: 0 }
      // 锚定 UTC 2026-10-25（周日）12:00：今天 = 10-25，本周 = 10-19..10-25，本月 = 10-01..10-25。
      const result = await collectOfficial(rt, 'secret', new Date(Date.UTC(2026, 9, 25, 12)))
      assert.equal(result.official.range24h.requestCount, 70, '今天 = UTC 10-25，只计 55+15（10-24 的桶不计）')
      assert.equal(result.official.range24h.from, '2026-10-25T00:00:00Z')
      assert.equal(result.official.range7d.requestCount, 60, '本周 = UTC 10-19..10-25，只计 10-19 的桶（10-18 属上周）')
      assert.equal(result.official.range7d.from, '2026-10-19T00:00:00Z')
      assert.equal(result.official.range30d.requestCount, 100, '本月 = UTC 10-01..10-25，10-18 与 10-19 都在内（40+60）')
    },
  )
})

test('collectOfficial: 单 range 网络失败只降级该 range，不影响其他', async () => {
  await withFetch(
    async (url) => {
      if (url.includes('range=24h')) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      return fakeResponseFor(url)
    },
    async () => {
      const rt = { rateLimitedUntil: 0 }
      const result = await collectOfficial(rt, 'secret')
      assert.equal(result.limits.kind, 'legacy', 'balance 正常解析')
      assert.equal(result.official.range24h, null)
      assert.ok(result.official.range7d !== null)
      assert.ok(result.official.range30d !== null)
      assert.deepEqual(
        result.errors.map((item) => item.source),
        ['usage24h'],
      )
      assert.equal(result.allNetworkFailed, false)
    },
  )
})

test('collectOfficial: 四个请求全网络失败 → allNetworkFailed=true', async () => {
  await withFetch(
    async () => {
      throw Object.assign(new Error('offline'), { name: 'TimeoutError' })
    },
    async () => {
      const rt = { rateLimitedUntil: 0 }
      const result = await collectOfficial(rt, 'secret')
      assert.equal(result.allNetworkFailed, true)
      assert.deepEqual(
        result.errors.map((item) => item.code),
        ['network', 'network', 'network', 'network'],
      )
    },
  )
})
