/**
 * OpenCode（v0.8 增量，契约 §7）Host 单测：
 *  - parseOpenCodeUsage：新形状 / 旧 windows 形状 / 空 usage / 缺字段 / 非法 percent / resetInSec；
 *  - requestOpenCodeUsage：200 / 401 上游 message / 403 / 429 Retry-After / 非 JSON / 超时 / 非 2xx；
 *  - resolveOpenCodeKey：manual > credentials > env > local-cli 优先级与存在性；
 *  - readOpenCodeAuthToken / resolveOpenCodeAuthPaths：路径候选、opencode-go 优先、包装与裸字符串；
 *  - resolveOpenCodeDbPath：四个候选路径的优先级；
 *  - aggregateOpenCodeMessages：role 过滤、total 回退、cost 6 位、会话去重、模型 top10、非法行忽略；
 *  - readOpenCodeLocal：no-db / no-sqlite / read-failed / 正常（node:sqlite；Node 20 自动跳过）；
 *  - collectOpenCode：200 / 401 / 200 空 / 无 key / 429 / 本机 DB；
 *  - runCollect 双 key：只有 OpenCode key 时照常采集，Ollama 部分为空形状；
 *  - buildSnapshot 默认 opencode 形状；
 *  - auth-state / set-key / clear-key 的 provider=opencode 分支。
 * 全部测试隔离真实 HOME / 环境变量 / DSH_HOME，不发真实网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateOpenCodeMessages,
  buildSnapshot,
  collectOpenCode,
  dispatch,
  emptyLimits,
  emptyOpenCode,
  loadPersisted,
  parseOpenCodeUsage,
  readOpenCodeAuthToken,
  readOpenCodeLocal,
  requestOpenCodeUsage,
  resolveOpenCodeAuthPaths,
  resolveOpenCodeDbPath,
  resolveOpenCodeKey,
} from '../lib/index.js'

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance'

/** 动态探测 node:sqlite（Node 20 没有 → 依赖它的用例 skip）。 */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}
const hasSqlite = sqlite !== null && typeof sqlite.DatabaseSync === 'function'
const SQLITE_SKIP = hasSqlite ? false : '需要 node:sqlite（Node >= 22.5）'

/** 临时替换 globalThis.fetch，结束后恢复（与 network.test.mjs 同款）。 */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

function usageResponse(body, status = 200, headers = {}) {
  return jsonResponse(body, status, headers)
}

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

/**
 * 隔离真实环境：清掉所有 key / 路径环境变量，把 HOME / XDG_DATA_HOME / LOCALAPPDATA / DSH_HOME
 * 指向空临时目录，保证不读真实 opencode auth.json / opencode.db，也不覆盖真实 state.json。
 */
async function withIsolatedEnv(run) {
  const saved = new Map()
  for (const name of ISOLATED_ENV_KEYS) saved.set(name, process.env[name])
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencode-test-'))
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
    return await run({ root, home, dshHome, dataHome, localAppData })
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

/** 最小 rt：只实现 handler / runCollect 用到的字段。 */
function makeRt(overrides = {}) {
  return {
    ctx: { get: () => undefined },
    state: {
      version: 1,
      manualKey: null,
      opencodeManualKey: null,
      opencodeDisabled: false,
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

const at = (year, monthIndex, day, hour = 12) => new Date(year, monthIndex, day, hour).getTime()

/* --------------------------------- parseOpenCodeUsage -------------------------------- */

test('parseOpenCodeUsage: 新形状 usage.rolling/weekly/monthly（percent 0..100、2 位小数、clamp）', () => {
  const parsed = parseOpenCodeUsage(
    {
      usage: {
        rolling: { status: 'ok', percent: 52, resetsAt: '2026-09-23T00:34:52.704Z' },
        weekly: { status: 'ok', percent: 20.006 },
        monthly: { status: 'ok', percent: 100.5, resetsAt: '2026-09-25T14:30:41.000Z' },
      },
    },
    at(2026, 9, 30, 9),
  )
  assert.equal(parsed.kind, 'go')
  assert.equal(parsed.note, null)
  assert.deepEqual(parsed.usage.rolling, {
    status: 'ok',
    usedPercent: 52,
    remainingPercent: 48,
    resetsAt: '2026-09-23T00:34:52.704Z',
  })
  assert.equal(parsed.usage.weekly.usedPercent, 20.01, '20.006 四舍五入到 2 位')
  assert.equal(parsed.usage.weekly.remainingPercent, 79.99)
  assert.equal(parsed.usage.weekly.resetsAt, null)
  assert.equal(parsed.usage.monthly.usedPercent, 100, '超过 100 clamp 到 100')
  assert.equal(parsed.usage.monthly.remainingPercent, 0)
})

test('parseOpenCodeUsage: 负 percent clamp 到 0，数字字符串也接受', () => {
  const parsed = parseOpenCodeUsage({
    usage: { rolling: { status: 'ok', percent: -8 }, weekly: { status: 'ok', percent: '37.5' } },
  })
  assert.equal(parsed.kind, 'go')
  assert.equal(parsed.usage.rolling.usedPercent, 0)
  assert.equal(parsed.usage.rolling.remainingPercent, 100)
  assert.equal(parsed.usage.weekly.usedPercent, 37.5)
  assert.equal(parsed.usage.weekly.remainingPercent, 62.5)
  assert.equal(parsed.usage.monthly, null)
})

test('parseOpenCodeUsage: 旧 windows[] 形状（percent/usagePercent + resetsAt/resetInSec）', () => {
  const now = at(2026, 9, 30, 9)
  const parsed = parseOpenCodeUsage(
    {
      windows: [
        { name: 'rolling', status: 'ok', usagePercent: 12.5, resetInSec: 60 },
        { name: 'weekly', status: 'warn', percent: 33.333 },
        { name: 'monthly', status: 'ok', percent: 61, resetsAt: '2026-10-25T00:00:00.000Z' },
        { name: 'unknown-window', percent: 99 },
        null,
      ],
    },
    now,
  )
  assert.equal(parsed.kind, 'go')
  assert.equal(parsed.usage.rolling.usedPercent, 12.5)
  assert.equal(parsed.usage.rolling.remainingPercent, 87.5)
  assert.equal(parsed.usage.rolling.resetsAt, new Date(now + 60000).toISOString(), 'resetInSec → fetchedAt + N 秒')
  assert.equal(parsed.usage.weekly.status, 'warn')
  assert.equal(parsed.usage.weekly.usedPercent, 33.33)
  assert.equal(parsed.usage.weekly.resetsAt, null)
  assert.equal(parsed.usage.monthly.resetsAt, '2026-10-25T00:00:00.000Z')
  assert.equal(parsed.usage.rolling.status, 'ok')
})

test('parseOpenCodeUsage: 200 但没有任何窗口 → kind=none + note（Zen 按量计费无官方额度接口）', () => {
  for (const body of [{}, { usage: {} }, { usage: null }, { windows: [] }, { usage: { rolling: null } }]) {
    const parsed = parseOpenCodeUsage(body)
    assert.equal(parsed.kind, 'none')
    assert.equal(parsed.usage, null)
    assert.match(parsed.note, /Zen 按量计费无官方额度接口/)
  }
})

test('parseOpenCodeUsage: 缺 percent 的窗口保留 status，两个 percent 为 null', () => {
  const parsed = parseOpenCodeUsage({
    usage: { rolling: { status: 'ok', resetsAt: '2026-09-23T00:34:52.704Z' } },
  })
  assert.equal(parsed.kind, 'go')
  assert.deepEqual(parsed.usage.rolling, {
    status: 'ok',
    usedPercent: null,
    remainingPercent: null,
    resetsAt: '2026-09-23T00:34:52.704Z',
  })
  assert.equal(parsed.usage.weekly, null)
})

test('parseOpenCodeUsage: 只有全空字段的窗口视为没有窗口', () => {
  const parsed = parseOpenCodeUsage({ usage: { rolling: { percent: null }, weekly: { status: '   ' } } })
  assert.equal(parsed.kind, 'none')
  assert.equal(parsed.usage, null)
})

test('parseOpenCodeUsage: 缺字段（无 status / resetsAt）也能解析', () => {
  const parsed = parseOpenCodeUsage({ usage: { rolling: { percent: 10 } } })
  assert.equal(parsed.kind, 'go')
  assert.deepEqual(parsed.usage.rolling, {
    status: null,
    usedPercent: 10,
    remainingPercent: 90,
    resetsAt: null,
  })
})

test('parseOpenCodeUsage: 非法 percent 按 null 处理，保留 status', () => {
  const parsed = parseOpenCodeUsage({ usage: { rolling: { status: 'ok', percent: 'abc' } } })
  assert.equal(parsed.kind, 'go')
  assert.equal(parsed.usage.rolling.usedPercent, null)
  assert.equal(parsed.usage.rolling.remainingPercent, null)
  assert.equal(parsed.usage.rolling.status, 'ok')
})

test('parseOpenCodeUsage: 接受 JSON 字符串；非对象 / 非法 JSON 抛错', () => {
  const parsed = parseOpenCodeUsage(JSON.stringify({ usage: { rolling: { percent: 5 } } }))
  assert.equal(parsed.kind, 'go')
  assert.equal(parsed.usage.rolling.usedPercent, 5)
  assert.throws(() => parseOpenCodeUsage('nope'), /不是合法 JSON/)
  assert.throws(() => parseOpenCodeUsage(null), /格式异常/)
  assert.throws(() => parseOpenCodeUsage([]), /格式异常/)
  assert.throws(() => parseOpenCodeUsage('null'), /格式异常/)
})

/* ------------------------------- requestOpenCodeUsage ------------------------------- */

test('requestOpenCodeUsage: 200 合法 JSON，带 Bearer / UA / 正确 URL', async () => {
  let seen = null
  await withFetch(
    async (url, init) => {
      seen = { url, init }
      return usageResponse({ usage: { rolling: { status: 'ok', percent: 52 } } })
    },
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.ok, true)
      assert.equal(result.status, 200)
      assert.equal(result.json.usage.rolling.percent, 52)
      assert.equal(seen.url, USAGE_URL)
      assert.equal(seen.init.method, 'GET')
      assert.equal(seen.init.headers.Authorization, 'Bearer oc-secret-1234')
      assert.match(seen.init.headers['User-Agent'], /^dsh-ollama-statistical\//)
      assert.ok(seen.init.signal, '必须带 20s AbortSignal.timeout')
    },
  )
})

test('requestOpenCodeUsage: 401 优先读取上游 error.message 并追加中文操作提示', async () => {
  await withFetch(
    async () =>
      usageResponse(
        { error: { type: 'auth', code: 'api_key_expired', message: 'api key expired' } },
        401,
      ),
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'unauthorized')
      assert.equal(result.status, 401)
      assert.match(result.message, /OpenCode API Key 已失效或被拒绝（HTTP 401）：api key expired/)
      assert.match(result.message, /请在 OpenCode Console 重新创建 Key/)
    },
  )
})

test('requestOpenCodeUsage: 403 同 unauthorized；401 非 JSON 错误体用兜底说明', async () => {
  await withFetch(
    async () => new Response('nope', { status: 403 }),
    async () => {
      const forbidden = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(forbidden.code, 'unauthorized')
      assert.equal(forbidden.status, 403)
      assert.match(forbidden.message, /无上游错误说明/)
    },
  )
  await withFetch(
    async () => new Response('<html>forbidden</html>', { status: 401 }),
    async () => {
      const unauthorized = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(unauthorized.code, 'unauthorized')
      assert.match(unauthorized.message, /无上游错误说明/)
    },
  )
})

test('requestOpenCodeUsage: 429 解析 Retry-After；缺省 60s 冷却', async () => {
  await withFetch(
    async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.code, 'rate-limit')
      assert.equal(result.status, 429)
      assert.equal(result.retryAfterMs, 7000)
      assert.match(result.message, /7 秒/)
    },
  )
  await withFetch(
    async () => new Response('slow down', { status: 429 }),
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.code, 'rate-limit')
      assert.equal(result.retryAfterMs, 60000)
    },
  )
})

test('requestOpenCodeUsage: 其它非 2xx → http；200 非 JSON → internal', async () => {
  await withFetch(
    async () => new Response('boom', { status: 500 }),
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.code, 'http')
      assert.equal(result.status, 500)
    },
  )
  await withFetch(
    async () => new Response('<html>oops</html>', { status: 200 }),
    async () => {
      const result = await requestOpenCodeUsage('oc-secret-1234')
      assert.equal(result.code, 'internal')
      assert.match(result.message, /不是合法 JSON/)
    },
  )
})

test('requestOpenCodeUsage: 超时 / AbortError → network', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    await withFetch(
      async () => {
        throw Object.assign(new Error('aborted'), { name })
      },
      async () => {
        const result = await requestOpenCodeUsage('oc-secret-1234')
        assert.equal(result.code, 'network')
        assert.equal(result.status, null)
        if (name === 'TimeoutError') assert.match(result.message, /超时/)
      },
    )
  }
})

/* ------------------------------- resolveOpenCodeKey -------------------------------- */

const allOpenCodeSources = () => ({
  readManualKey: () => 'man-1234567890abcd',
  resolveCredential: async () => ({ value: 'cred-1234567890abcd', source: 'provider' }),
  env: 'env-1234567890abcd',
  readLocalToken: () => 'cli-1234567890abcd',
})

test('resolveOpenCodeKey: 四个来源都存在时选 manual（与 Ollama 相反，manual 最高）', async () => {
  const info = await resolveOpenCodeKey(allOpenCodeSources())
  assert.equal(info.source, 'manual')
  assert.equal(info.key, 'man-1234567890abcd')
  assert.deepEqual(info.sources, { credentials: true, env: true, localCli: true, manual: true })
})

test('resolveOpenCodeKey: 无 manual 时依次降级 credentials → env → local-cli', async () => {
  const noManual = allOpenCodeSources()
  delete noManual.readManualKey
  const credentials = await resolveOpenCodeKey(noManual)
  assert.equal(credentials.source, 'credentials')
  assert.equal(credentials.sources.manual, false)
  assert.equal(credentials.sources.credentials, true)

  const noCredentials = await resolveOpenCodeKey({
    readManualKey: () => null,
    env: 'env-1234567890abcd',
    readLocalToken: () => 'cli-1234567890abcd',
  })
  assert.equal(noCredentials.source, 'env')

  const localOnly = await resolveOpenCodeKey({
    readManualKey: () => '   ',
    resolveCredential: async () => null,
    env: '',
    readLocalToken: () => 'cli-1234567890abcd',
  })
  assert.equal(localOnly.source, 'local-cli')
  assert.equal(localOnly.key, 'cli-1234567890abcd')
  assert.deepEqual(localOnly.sources, { credentials: false, env: false, localCli: true, manual: false })
})

test('resolveOpenCodeKey: 四个来源都没有 → source=none、key=null、presence 全 false', async () => {
  const info = await resolveOpenCodeKey({})
  assert.equal(info.source, 'none')
  assert.equal(info.key, null)
  assert.deepEqual(info.sources, { credentials: false, env: false, localCli: false, manual: false })
})

test('resolveOpenCodeKey: 空白字符串视作不存在；producer 支持函数/字符串/{value}', async () => {
  const blank = await resolveOpenCodeKey({
    readManualKey: () => '\t\n',
    resolveCredential: async () => ({ value: '   ' }),
    env: '  ',
    readLocalToken: () => '',
  })
  assert.equal(blank.source, 'none')

  const viaString = await resolveOpenCodeKey({ env: '  env-1234567890abcd  ' })
  assert.equal(viaString.source, 'env')
  assert.equal(viaString.key, 'env-1234567890abcd', '返回值会 trim')

  const viaValue = await resolveOpenCodeKey({
    resolveCredential: async () => ({ value: '  cred-1234567890abcd  ' }),
  })
  assert.equal(viaValue.source, 'credentials')
  assert.equal(viaValue.key, 'cred-1234567890abcd')
})

test('resolveOpenCodeKey: 某个来源抛错只跳过该来源，不中断解析', async () => {
  const info = await resolveOpenCodeKey({
    readManualKey: () => {
      throw new Error('state broken')
    },
    resolveCredential: async () => {
      throw new Error('credentials service down')
    },
    env: () => 'env-1234567890abcd',
    readLocalToken: () => {
      throw new Error('auth.json broken')
    },
  })
  assert.equal(info.source, 'env')
  assert.equal(info.key, 'env-1234567890abcd')
  assert.deepEqual(info.sources, { credentials: false, env: true, localCli: false, manual: false })
})

/* --------------------------- auth.json / 路径候选 --------------------------- */

test('resolveOpenCodeAuthPaths: OPENCODE_AUTH_PATH → XDG_DATA_HOME → ~/.local/share → LOCALAPPDATA', () => {
  const paths = resolveOpenCodeAuthPaths(
    {
      OPENCODE_AUTH_PATH: join('A', 'auth.json'),
      XDG_DATA_HOME: 'X',
      LOCALAPPDATA: 'L',
    },
    'H',
  )
  assert.deepEqual(paths, [
    join('A', 'auth.json'),
    join('X', 'opencode', 'auth.json'),
    join('H', '.local', 'share', 'opencode', 'auth.json'),
    join('L', 'opencode', 'auth.json'),
  ])
  // 默认（无 env）只有 ~/.local/share 一项
  assert.deepEqual(resolveOpenCodeAuthPaths({}, 'H'), [join('H', '.local', 'share', 'opencode', 'auth.json')])
  // 重复路径去重
  assert.deepEqual(
    resolveOpenCodeAuthPaths({ XDG_DATA_HOME: 'X', OPENCODE_AUTH_PATH: join('X', 'opencode', 'auth.json') }, 'H'),
    [join('X', 'opencode', 'auth.json'), join('H', '.local', 'share', 'opencode', 'auth.json')],
  )
})

test('readOpenCodeAuthToken: opencode-go 优先、支持 {type:api,key} 与裸字符串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-auth-'))
  try {
    const wrap = (name, value) => {
      const filePath = join(dir, name)
      writeFileSync(filePath, JSON.stringify(value))
      return filePath
    }
    // 两个都有 → opencode-go 优先
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: wrap('a.json', { opencode: 'oc-bare', 'opencode-go': { type: 'api', key: 'oc-go' } }) },
        home: dir,
      }),
      'oc-go',
    )
    // 只有 opencode → opencode
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: wrap('b.json', { opencode: { type: 'api', key: 'oc-only' } }) },
        home: dir,
      }),
      'oc-only',
    )
    // 裸字符串
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: wrap('c.json', { 'opencode-go': 'oc-string' }) },
        home: dir,
      }),
      'oc-string',
    )
    // 没有 opencode 键 / 损坏 / 不存在 → null
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: wrap('d.json', { anthropic: { key: 'x' } }) },
        home: dir,
      }),
      null,
    )
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: wrap('e.json', 'not json at all') },
        home: dir,
      }),
      null,
    )
    assert.equal(
      readOpenCodeAuthToken({
        env: { OPENCODE_AUTH_PATH: join(dir, 'missing.json') },
        home: dir,
      }),
      null,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeAuthToken: 按候选路径顺序取第一个存在的 key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-auth-order-'))
  try {
    const home = join(dir, 'home')
    const xdg = join(dir, 'xdg')
    const local = join(dir, 'local')
    for (const path of [join(xdg, 'opencode'), join(home, '.local', 'share', 'opencode'), join(local, 'opencode')]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(join(xdg, 'opencode', 'auth.json'), JSON.stringify({ opencode: 'oc-xdg' }))
    writeFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ opencode: 'oc-home' }))
    writeFileSync(join(local, 'opencode', 'auth.json'), JSON.stringify({ opencode: 'oc-local' }))

    assert.equal(
      readOpenCodeAuthToken({ env: { XDG_DATA_HOME: xdg, LOCALAPPDATA: local }, home }),
      'oc-xdg',
    )
    assert.equal(readOpenCodeAuthToken({ env: { LOCALAPPDATA: local }, home }), 'oc-home')
    assert.equal(readOpenCodeAuthToken({ env: {}, home }), 'oc-home')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------- resolveOpenCodeDbPath ------------------------------ */

test('resolveOpenCodeDbPath: 四个候选路径按优先级取第一个存在的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-dbpath-'))
  try {
    const home = join(dir, 'home')
    const xdg = join(dir, 'xdg')
    const local = join(dir, 'local')
    const explicit = join(dir, 'custom', 'opencode.db')
    for (const path of [
      join(dir, 'custom'),
      join(xdg, 'opencode'),
      join(home, '.local', 'share', 'opencode'),
      join(local, 'opencode'),
    ]) {
      mkdirSync(path, { recursive: true })
    }
    const env = { OPENCODE_DB_PATH: explicit, XDG_DATA_HOME: xdg, LOCALAPPDATA: local }
    assert.equal(resolveOpenCodeDbPath(env, home), null, '一个都不存在 → null')

    writeFileSync(join(local, 'opencode', 'opencode.db'), 'x')
    assert.equal(resolveOpenCodeDbPath(env, home), join(local, 'opencode', 'opencode.db'))

    writeFileSync(join(home, '.local', 'share', 'opencode', 'opencode.db'), 'x')
    assert.equal(resolveOpenCodeDbPath(env, home), join(home, '.local', 'share', 'opencode', 'opencode.db'))

    writeFileSync(join(xdg, 'opencode', 'opencode.db'), 'x')
    assert.equal(resolveOpenCodeDbPath(env, home), join(xdg, 'opencode', 'opencode.db'))

    writeFileSync(explicit, 'x')
    assert.equal(resolveOpenCodeDbPath(env, home), explicit)

    // OPENCODE_DB_PATH 指向不存在的文件时继续尝试后面的候选
    assert.equal(
      resolveOpenCodeDbPath({ ...env, OPENCODE_DB_PATH: join(dir, 'nope.db') }, home),
      join(xdg, 'opencode', 'opencode.db'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ----------------------------- aggregateOpenCodeMessages ---------------------------- */

function aggregateSampleRows() {
  return [
    {
      sessionId: 's1',
      timeCreated: at(2026, 9, 30, 10),
      data: {
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
        cost: 0.0123456,
        tokens: { total: 100, input: 60, output: 20, reasoning: 7, cache: { read: 15, write: 5 } },
      },
    },
    {
      sessionId: 's2',
      timeCreated: at(2026, 9, 30, 11),
      data: JSON.stringify({
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'glm-5',
        cost: 0.5,
        tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
      }),
    },
    {
      sessionId: 's1',
      timeCreated: at(2026, 9, 29, 9),
      data: {
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
        cost: 0.1,
        tokens: { total: 50 },
      },
    },
    {
      sessionId: 's3',
      timeCreated: at(2026, 9, 25, 9),
      data: { role: 'assistant', providerID: 'other', modelID: 'm', cost: 0.2, tokens: { total: 30 } },
    },
    {
      sessionId: 's4',
      timeCreated: at(2026, 9, 30, 12),
      data: { role: 'user', tokens: { total: 999 } },
    },
    { sessionId: 's5', timeCreated: at(2026, 9, 30, 12), data: '{bad json' },
    {
      sessionId: 's6',
      timeCreated: at(2026, 8, 20, 12),
      data: { role: 'assistant', tokens: { total: 777 } },
    },
    { sessionId: 's7', timeCreated: at(2026, 9, 30, 12), data: { role: 'assistant', providerID: 'x', modelID: 'y', tokens: { total: -3, input: 1, output: 2, cache: { read: 3, write: 4 } } } },
    null,
    1,
    'x',
    { sessionId: 's8', timeCreated: at(2026, 9, 30, 12), data: { role: 'assistant', tokens: { total: 1 } } },
  ]
}

test('aggregateOpenCodeMessages: 30 天窗口、日桶、totals（今天/本周/本月）、会话去重', () => {
  const now = at(2026, 9, 30, 12)
  const local = aggregateOpenCodeMessages(aggregateSampleRows(), now, 30)

  assert.equal(local.available, true)
  assert.equal(local.generatedAt, new Date(now).toISOString())
  assert.equal(typeof local.timeZone, 'string')
  assert.equal(local.today, '2026-10-30')
  assert.equal(local.weekStart, '2026-10-26')
  assert.equal(local.monthStart, '2026-10-01')
  assert.equal(local.windowDays, 30)
  assert.equal(local.days.length, 30)
  assert.deepEqual(local.days.map((day) => day.date), [...local.days.map((day) => day.date)].sort(), '升序')
  assert.equal(local.days[0].date, '2026-10-01')
  assert.equal(local.days[29].date, '2026-10-30')

  // 每个日桶必须是完整桶
  const dayKeys = [
    'cacheRead',
    'cacheWrite',
    'costUsd',
    'date',
    'input',
    'output',
    'reasoning',
    'requests',
    'sessions',
    'total',
  ]
  for (const day of local.days) assert.deepEqual(Object.keys(day).sort(), dayKeys)

  const today = local.days[29]
  assert.deepEqual(today, {
    date: '2026-10-30',
    input: 60 + 10 + 1,
    output: 20 + 5 + 2,
    cacheRead: 15 + 0 + 3,
    cacheWrite: 5 + 0 + 4,
    reasoning: 7,
    total: 100 + 15 + 10 + 1,
    requests: 4,
    sessions: 4,
    costUsd: 0.512346,
  })

  const yesterday = local.days.find((day) => day.date === '2026-10-29')
  assert.equal(yesterday.total, 50)
  assert.equal(yesterday.requests, 1)
  assert.equal(yesterday.sessions, 1)
  assert.equal(yesterday.costUsd, 0.1)

  const sunday = local.days.find((day) => day.date === '2026-10-25')
  assert.equal(sunday.total, 30, '10-25（周日）属上一周，但在本月的窗口内')
  // 窗口外（9 月 20 日）的 777 不能计入：窗口内合计 = 100+15+1+50+30+10 = 206
  assert.equal(local.days.reduce((sum, day) => sum + day.total, 0), 206)
  assert.equal(
    local.totals.month.total,
    local.days.reduce((sum, day) => sum + day.total, 0),
    'totals.month 与窗口内日桶同口径',
  )

  assert.deepEqual(local.totals.today, {
    input: 71,
    output: 27,
    cacheRead: 18,
    cacheWrite: 9,
    reasoning: 7,
    total: 126,
    requests: 4,
    sessions: 4,
    costUsd: 0.512346,
  })
  assert.deepEqual(local.totals.week, {
    input: 71,
    output: 27,
    cacheRead: 18,
    cacheWrite: 9,
    reasoning: 7,
    total: 176,
    requests: 5,
    sessions: 4,
    costUsd: 0.612346,
  })
  assert.deepEqual(local.totals.month, {
    input: 71,
    output: 27,
    cacheRead: 18,
    cacheWrite: 9,
    reasoning: 7,
    total: 206,
    requests: 6,
    sessions: 5,
    costUsd: 0.812346,
  })

  // 模型榜按 total 降序（窗口内），不合并「(其余)」
  assert.deepEqual(
    local.models.map((item) => [item.provider, item.model, item.total, item.requests, item.costUsd]),
    [
      ['opencode-go', 'deepseek-v4-flash', 150, 2, 0.112346],
      ['other', 'm', 30, 1, 0.2],
      ['opencode-go', 'glm-5', 15, 1, 0.5],
      ['x', 'y', 10, 1, 0],
      ['(未知)', '(未知)', 1, 1, 0],
    ],
  )
  for (const model of local.models) {
    assert.deepEqual(Object.keys(model).sort(), ['costUsd', 'model', 'provider', 'requests', 'total'])
  }

  assert.deepEqual(local.scan, {
    messages: aggregateSampleRows().length,
    matched: 6,
    elapsedMs: 0,
    truncated: false,
  })

  // v0.9.3：今天小时桶与日桶同口径
  assert.equal(local.hours.length, 24)
  assert.equal(local.hours.reduce((sum, item) => sum + item.total, 0), today.total)
  assert.equal(local.hours.reduce((sum, item) => sum + item.requests, 0), today.requests)
})

test('aggregateOpenCodeMessages: local.hours 今天 24 个小时桶（09/10/23 点、cost/requests、跨日不进）', () => {
  const now = at(2026, 9, 30, 12)
  const rows = [
    {
      sessionId: 's1',
      timeCreated: at(2026, 9, 30, 9, 5),
      data: {
        role: 'assistant',
        providerID: 'opencode-go',
        modelID: 'm',
        cost: 0.0123456,
        tokens: { total: 100, input: 60, output: 20, reasoning: 7, cache: { read: 15, write: 5 } },
      },
    },
    {
      sessionId: 's2',
      timeCreated: at(2026, 9, 30, 10),
      data: { role: 'assistant', cost: 0.5, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } },
    },
    {
      sessionId: 's1',
      timeCreated: at(2026, 9, 30, 23, 59, 59),
      data: { role: 'assistant', cost: 0.1, tokens: { total: 50 } },
    },
    // 昨天 10 点：只进 days/totals，不进今天的小时桶
    {
      sessionId: 's3',
      timeCreated: at(2026, 9, 29, 10),
      data: { role: 'assistant', cost: 1, tokens: { total: 999 } },
    },
    // 非 assistant：一律忽略
    { sessionId: 's4', timeCreated: at(2026, 9, 30, 9), data: { role: 'user', tokens: { total: 777 } } },
  ]
  const local = aggregateOpenCodeMessages(rows, now, 30)

  assert.equal(local.hours.length, 24, '固定 24 条完整小时桶')
  assert.deepEqual(
    local.hours.map((item) => item.hour),
    Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')),
    '严格升序 00..23',
  )
  const zeroHour = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    requests: 0,
    costUsd: 0,
  }
  for (const item of local.hours) {
    assert.deepEqual(Object.keys(item).sort(), [
      'cacheRead',
      'cacheWrite',
      'costUsd',
      'hour',
      'input',
      'output',
      'reasoning',
      'requests',
      'total',
    ])
  }

  assert.deepEqual(local.hours[9], {
    hour: '09',
    input: 60,
    output: 20,
    cacheRead: 15,
    cacheWrite: 5,
    reasoning: 7,
    total: 100,
    requests: 1,
    costUsd: 0.012346,
  })
  assert.deepEqual(local.hours[10], {
    hour: '10',
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 15,
    requests: 1,
    costUsd: 0.5,
  })
  assert.deepEqual(local.hours[23], {
    hour: '23',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 50,
    requests: 1,
    costUsd: 0.1,
  })
  for (const item of local.hours) {
    if (item.hour === '09' || item.hour === '10' || item.hour === '23') continue
    assert.deepEqual(item, { hour: item.hour, ...zeroHour })
  }

  // 小时桶与今天日桶 / totals.today 同口径
  const today = local.days[29]
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'requests']) {
    assert.equal(
      local.hours.reduce((sum, item) => sum + item[field], 0),
      today[field],
      'sum(hours.' + field + ') === today.' + field,
    )
    assert.equal(local.hours.reduce((sum, item) => sum + item[field], 0), local.totals.today[field])
  }
  assert.ok(
    Math.abs(local.hours.reduce((sum, item) => sum + item.costUsd, 0) - today.costUsd) < 1e-9,
    'sum(hours.costUsd) 与今天日桶一致',
  )

  // 昨天（10-29 10 点）的 999 只进 days/totals，不进 hours
  assert.equal(local.hours[10].total, 15, '昨天的消息不得进今天小时桶')
  assert.equal(local.days.find((day) => day.date === '2026-10-29').total, 999)
  assert.equal(local.days[29].total, 165)
  assert.equal(local.totals.month.total, 1164)
  assert.equal(local.scan.matched, 4)
  assert.equal(local.scan.messages, rows.length)
})

test('aggregateOpenCodeMessages: total 回退不含 reasoning，缺失 provider/model 归 (未知)', () => {
  const now = at(2026, 9, 30, 12)
  const local = aggregateOpenCodeMessages(
    [
      {
        sessionId: 's1',
        timeCreated: at(2026, 9, 30, 10),
        data: {
          role: 'assistant',
          cost: -5,
          tokens: { total: -1, input: 1, output: 2, reasoning: 100, cache: { read: 3, write: 4 } },
        },
      },
      {
        sessionId: 's2',
        timeCreated: at(2026, 9, 30, 11),
        data: { role: 'assistant', tokens: { total: 0, input: 100, output: 100 } },
      },
    ],
    now,
    30,
  )
  const today = local.days[29]
  assert.equal(today.total, 10, 'total=-1 → 1+2+3+4=10（不加 reasoning=100）')
  assert.equal(today.reasoning, 100, 'reasoning 只做展示')
  assert.equal(today.requests, 2, 'total=0 也算一条请求')
  assert.equal(today.costUsd, 0, '负数 cost 按 0')
  assert.equal(local.models[0].provider, '(未知)')
  assert.equal(local.models[0].model, '(未知)')
  assert.equal(local.models[0].total, 10)
})

test('aggregateOpenCodeMessages: 非法输入不抛错；空输入输出完整 30 天空桶', () => {
  const now = at(2026, 9, 30, 12)
  for (const rows of [null, undefined, [], [null, 1, 'x'], [{ sessionId: 's', timeCreated: 'bad', data: {} }]]) {
    const local = aggregateOpenCodeMessages(rows, now, 30)
    assert.equal(local.available, true)
    assert.equal(local.days.length, 30)
    assert.equal(local.scan.matched, 0)
    assert.deepEqual(local.models, [])
    assert.equal(local.totals.today.total, 0)
    assert.equal(local.hours.length, 24, '空输入也必须输出 24 条零填充小时桶')
    assert.ok(local.hours.every((item) => item.total === 0 && item.requests === 0 && item.costUsd === 0))
  }
  // windowDays 可注入（用于自定义窗口）
  const local = aggregateOpenCodeMessages([], new Date(now), 7)
  assert.equal(local.days.length, 7)
  assert.equal(local.windowDays, 7)
  assert.equal(local.days[0].date, '2026-10-24')
  assert.equal(local.days[6].date, '2026-10-30')
})

test('aggregateOpenCodeMessages: 模型榜最多 10 条、按 total 降序', () => {
  const now = at(2026, 9, 30, 12)
  const rows = []
  for (let index = 1; index <= 12; index += 1) {
    rows.push({
      sessionId: 's1',
      timeCreated: at(2026, 9, 30, 10),
      data: {
        role: 'assistant',
        providerID: 'p',
        modelID: 'model-' + String(index).padStart(2, '0'),
        tokens: { total: 13 - index },
      },
    })
  }
  const local = aggregateOpenCodeMessages(rows, now, 30)
  assert.equal(local.models.length, 10)
  assert.equal(local.models[0].model, 'model-01')
  assert.equal(local.models[9].model, 'model-10')
  assert.ok(local.models.every((item, index) => index === 0 || local.models[index - 1].total >= item.total))
  assert.equal(local.models.length, 10, '不生成 (其余) 合并条目')
})

/* --------------------------------- emptyOpenCode ---------------------------------- */

test('emptyOpenCode: 无数据形状（configured=false / kind=none / fetchedAt=null / disabled=false）', () => {
  assert.deepEqual(emptyOpenCode(), {
    configured: false,
    key: { source: 'none', masked: null },
    kind: 'none',
    fetchedAt: null,
    note: null,
    usage: null,
    local: null,
    disabled: false,
  })
  assert.equal(emptyOpenCode('2026-10-30T01:23:45.000Z').fetchedAt, '2026-10-30T01:23:45.000Z')
  assert.equal(emptyOpenCode('2026-10-30T01:23:45.000Z').disabled, false)
})

/* ---------------------------------- buildSnapshot ---------------------------------- */

test('buildSnapshot: 默认 opencode 形状（version 仍为 1；plain object 才采用）', () => {
  const value = buildSnapshot({})
  assert.equal(value.version, 1)
  assert.equal(value.opencode.configured, false)
  assert.deepEqual(value.opencode.key, { source: 'none', masked: null })
  assert.equal(value.opencode.kind, 'none')
  assert.equal(value.opencode.usage, null)
  assert.equal(value.opencode.note, null)
  assert.equal(value.opencode.local, null)
  assert.equal(value.opencode.fetchedAt, null, '无 key / 失败时 fetchedAt 必须为 null（契约 §7.3）')

  const opencode = {
    configured: true,
    key: { source: 'manual', masked: 'sk-****U61I' },
    kind: 'go',
    fetchedAt: '2026-10-30T01:23:45.000Z',
    note: null,
    usage: { rolling: { status: 'ok', usedPercent: 52, remainingPercent: 48, resetsAt: 'x' } },
    local: null,
  }
  const adopted = buildSnapshot({ opencode })
  assert.deepEqual(adopted.opencode, opencode)
  assert.equal(adopted.version, 1)

  for (const invalid of [null, [], 'x', 1]) {
    assert.equal(buildSnapshot({ opencode: invalid }).opencode.kind, 'none')
  }
})

/* ---------------------------------- collectOpenCode -------------------------------- */

const SAMPLE_USAGE = {
  usage: {
    rolling: { status: 'ok', percent: 52, resetsAt: '2026-10-30T06:00:00.000Z' },
    weekly: { status: 'ok', percent: 20, resetsAt: '2026-11-02T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 61, resetsAt: '2026-11-25T00:00:00.000Z' },
  },
}

test('collectOpenCode: 有 env key + 200 → kind=go，key 脱敏、fetchedAt 为采集时间', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const now = at(2026, 9, 30, 9)
    await withFetch(
      async () => usageResponse(SAMPLE_USAGE),
      async () => {
        const result = await collectOpenCode(makeRt(), now)
        assert.deepEqual(result.errors, [])
        const opencode = result.opencode
        assert.equal(opencode.configured, true)
        assert.deepEqual(opencode.key, { source: 'env', masked: '****cret' })
        assert.equal(opencode.kind, 'go')
        assert.deepEqual(opencode.usage, {
          rolling: { status: 'ok', usedPercent: 52, remainingPercent: 48, resetsAt: '2026-10-30T06:00:00.000Z' },
          weekly: { status: 'ok', usedPercent: 20, remainingPercent: 80, resetsAt: '2026-11-02T00:00:00.000Z' },
          monthly: { status: 'ok', usedPercent: 61, remainingPercent: 39, resetsAt: '2026-11-25T00:00:00.000Z' },
        })
        assert.equal(opencode.fetchedAt, new Date(now).toISOString())
        assert.equal(opencode.note, null)
        assert.equal(opencode.local, null, '隔离环境里没有 opencode.db')
      },
    )
  })
})

test('collectOpenCode: 401 只进 errors，kind=none/usage=null/fetchedAt=null', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_GO_API_KEY = 'oc-go-secret'
    await withFetch(
      async () =>
        usageResponse({ error: { type: 'auth', code: 'api_key_expired', message: 'api key expired' } }, 401),
      async () => {
        const result = await collectOpenCode(makeRt(), at(2026, 9, 30, 9))
        assert.equal(result.opencode.configured, true)
        assert.deepEqual(result.opencode.key, { source: 'env', masked: '****cret' })
        assert.equal(result.opencode.kind, 'none')
        assert.equal(result.opencode.usage, null)
        assert.equal(result.opencode.note, null)
        assert.equal(result.opencode.fetchedAt, null)
        assert.equal(result.errors.length, 1)
        assert.equal(result.errors[0].source, 'opencode')
        assert.equal(result.errors[0].code, 'unauthorized')
        assert.match(result.errors[0].message, /重新创建 Key/)
      },
    )
  })
})

test('collectOpenCode: 200 空 usage → kind=none + note（fetchedAt 仍是采集时间）', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const now = at(2026, 9, 30, 9)
    await withFetch(
      async () => usageResponse({}),
      async () => {
        const result = await collectOpenCode(makeRt(), now)
        assert.deepEqual(result.errors, [])
        assert.equal(result.opencode.configured, true)
        assert.equal(result.opencode.kind, 'none')
        assert.equal(result.opencode.usage, null)
        assert.match(result.opencode.note, /Zen 按量计费无官方额度接口/)
        assert.equal(result.opencode.fetchedAt, new Date(now).toISOString())
      },
    )
  })
})

test('collectOpenCode: 429 → errors[source=opencode, code=rate-limit]', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    await withFetch(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '9' } }),
      async () => {
        const result = await collectOpenCode(makeRt(), at(2026, 9, 30, 9))
        assert.equal(result.errors.length, 1)
        assert.equal(result.errors[0].code, 'rate-limit')
        assert.equal(result.opencode.kind, 'none')
        assert.equal(result.opencode.usage, null)
      },
    )
  })
})

test('collectOpenCode: 失败时保留同一个 key 的上次成功 Go 额度（契约 §7.3/§7.5）', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const rt = makeRt()
    let first = null
    await withFetch(
      async () => usageResponse(SAMPLE_USAGE),
      async () => {
        first = await collectOpenCode(rt, at(2026, 9, 30, 12))
      },
    )
    assert.equal(first.opencode.kind, 'go')
    const firstFetchedAt = first.opencode.fetchedAt
    // 模拟 runCollect 把上一次成功快照写进 state.lastSnapshot
    rt.state.lastSnapshot = {
      version: 1,
      updatedAt: new Date(at(2026, 9, 30, 12)).toISOString(),
      opencode: first.opencode,
      errors: first.errors,
    }
    await withFetch(
      async () => usageResponse({ error: { type: 'authentication_error', message: 'expired' } }, 401),
      async () => {
        const second = await collectOpenCode(rt, at(2026, 9, 30, 13))
        assert.ok(second.errors.some((item) => item.source === 'opencode' && item.code === 'unauthorized'))
        assert.equal(second.opencode.kind, 'go', '失败时沿用旧 kind')
        assert.deepEqual(second.opencode.usage, first.opencode.usage, '失败时沿用旧 usage')
        assert.equal(second.opencode.fetchedAt, firstFetchedAt, '保留旧采集时间，不伪造新时间')
        assert.equal(second.opencode.key.source, 'env')
      },
    )
  })
})

test('collectOpenCode: 换 key 后失败不复用旧 key 的额度', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const rt = makeRt()
    let first = null
    await withFetch(
      async () => usageResponse(SAMPLE_USAGE),
      async () => {
        first = await collectOpenCode(rt, at(2026, 9, 30, 12))
      },
    )
    rt.state.lastSnapshot = {
      version: 1,
      updatedAt: new Date(at(2026, 9, 30, 12)).toISOString(),
      opencode: first.opencode,
      errors: first.errors,
    }
    // 手动 key 优先级最高，来源变成 manual → 不能沿用上一个 env key 的额度
    rt.state.opencodeManualKey = 'oc-manual-other-key'
    await withFetch(
      async () => usageResponse({ error: { message: 'invalid' } }, 401),
      async () => {
        const second = await collectOpenCode(rt, at(2026, 9, 30, 13))
        assert.ok(second.errors.some((item) => item.source === 'opencode' && item.code === 'unauthorized'))
        assert.equal(second.opencode.kind, 'none')
        assert.equal(second.opencode.usage, null)
        assert.equal(second.opencode.key.source, 'manual')
      },
    )
  })
})

test('runCollect: OpenCode 先 200 后 401 → 保留上次 Go 额度，不覆盖成空', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const responses = [
      usageResponse(SAMPLE_USAGE),
      usageResponse({ error: { type: 'authentication_error', message: 'expired' } }, 401),
    ]
    let usageCalls = 0
    await withFetch(
      async (url) => {
        if (url === USAGE_URL) {
          const response = responses[Math.min(usageCalls, responses.length - 1)]
          usageCalls += 1
          return response
        }
        return usageResponse({})
      },
      async () => {
        const rt = makeRt()
        const first = await dispatch(rt, 'refresh', {})
        assert.equal(first.ok, true)
        assert.equal(first.value.opencode.kind, 'go')
        const firstFetchedAt = first.value.opencode.fetchedAt
        rt.lastCollectAt = 0 // 跳过 refresh 的 15s 节流
        const second = await dispatch(rt, 'refresh', {})
        assert.equal(second.ok, true)
        assert.equal(second.value.opencode.kind, 'go', '失败的那次 refresh 不得把 Go 额度清空')
        assert.equal(second.value.opencode.usage.rolling.usedPercent, 52)
        assert.equal(second.value.opencode.fetchedAt, firstFetchedAt)
        assert.ok(second.value.errors.some((item) => item.source === 'opencode' && item.code === 'unauthorized'))
        assert.equal(second.value.cached, false)
        // lastSnapshot 也必须保留 usage（下次冷启动 SWR 才有旧卡片可回退）
        assert.equal(rt.state.lastSnapshot.opencode.kind, 'go')
        assert.equal(rt.state.lastSnapshot.opencode.usage.rolling.usedPercent, 52)
      },
    )
  })
})

test('collectOpenCode: 无 key 时不发网络请求，configured=false 且不产生 errors', async () => {
  await withIsolatedEnv(async () => {
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('不得发起网络请求')
      },
      async () => {
        const result = await collectOpenCode(makeRt(), at(2026, 9, 30, 9))
        assert.equal(fetchCalls, 0)
        assert.deepEqual(result.errors, [])
        assert.equal(result.opencode.configured, false)
        assert.deepEqual(result.opencode.key, { source: 'none', masked: null })
        assert.equal(result.opencode.kind, 'none')
        assert.equal(result.opencode.fetchedAt, null)
        assert.equal(result.opencode.usage, null)
        assert.equal(result.opencode.local, null)
      },
    )
  })
})

test('collectOpenCode: 无 key 也读取本机 opencode.db（local 有值）', { skip: SQLITE_SKIP }, async () => {
  await withIsolatedEnv(async ({ root }) => {
    const now = at(2026, 9, 30, 12)
    const dbPath = createMessageDb(join(root, 'localdb'), now)
    process.env.OPENCODE_DB_PATH = dbPath
    const result = await collectOpenCode(makeRt(), now)
    assert.deepEqual(result.errors, [])
    assert.equal(result.opencode.configured, false)
    assert.ok(result.opencode.local !== null)
    assert.equal(result.opencode.local.available, true)
    assert.equal(result.opencode.local.today, '2026-10-30')
    assert.ok(result.opencode.local.scan.matched > 0)
  })
})

test('collectOpenCode: DB 打不开 → errors[source=opencode-local]', { skip: SQLITE_SKIP }, async () => {
  await withIsolatedEnv(async ({ root }) => {
    const corrupt = join(root, 'corrupt', 'opencode.db')
    mkdirSync(join(root, 'corrupt'), { recursive: true })
    writeFileSync(corrupt, 'definitely not a sqlite database')
    process.env.OPENCODE_DB_PATH = corrupt
    const result = await collectOpenCode(makeRt(), at(2026, 9, 30, 12))
    assert.equal(result.opencode.local, null)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].source, 'opencode-local')
    assert.equal(result.errors[0].code, 'internal')
    assert.match(result.errors[0].message, /读取本机 opencode.db 失败/)
  })
})

/* ---------------------------------- readOpenCodeLocal ------------------------------ */

/** 用 node:sqlite 建临时库（message 表结构按 opencode ≥1.x 的实测列）。 */
function createMessageDb(dir, now, rows) {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'opencode.db')
  const db = new sqlite.DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    const list = rows || [
      {
        sessionId: 's1',
        timeCreated: at(2026, 9, 30, 10),
        data: {
          role: 'assistant',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash',
          cost: 0.0123456,
          tokens: { total: 100, input: 60, output: 20, reasoning: 7, cache: { read: 15, write: 5 } },
        },
      },
      {
        sessionId: 's2',
        timeCreated: at(2026, 9, 30, 11),
        data: {
          role: 'assistant',
          providerID: 'opencode-go',
          modelID: 'glm-5',
          cost: 0.5,
          tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
        },
      },
      {
        sessionId: 's1',
        timeCreated: at(2026, 9, 29, 9),
        data: { role: 'assistant', providerID: 'opencode-go', modelID: 'deepseek-v4-flash', cost: 0.1, tokens: { total: 50 } },
      },
      {
        sessionId: 's4',
        timeCreated: at(2026, 9, 30, 12),
        data: { role: 'user', tokens: { total: 999 } },
      },
      { sessionId: 's5', timeCreated: at(2026, 9, 30, 12), data: '{bad json' },
      {
        sessionId: 's6',
        timeCreated: at(2026, 8, 20, 12),
        data: { role: 'assistant', tokens: { total: 777 } },
      },
    ]
    list.forEach((row, index) => {
      insert.run(
        'm' + index,
        row.sessionId,
        row.timeCreated,
        typeof row.data === 'string' ? row.data : JSON.stringify(row.data),
      )
    })
  } finally {
    db.close()
  }
  return dbPath
}

test('readOpenCodeLocal: 只读聚合本机 DB（日桶/窗口/total/cost/models/scan）', { skip: SQLITE_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-db-'))
  try {
    const now = at(2026, 9, 30, 12)
    const dbPath = createMessageDb(dir, now)
    const before = readFileSync(dbPath)
    const filesBefore = readdirSync(dir).sort()

    const result = await readOpenCodeLocal({ dbPath, now })
    assert.equal(result.reason, null)
    assert.equal(result.error, null)
    const local = result.local
    assert.equal(local.available, true)
    assert.equal(local.today, '2026-10-30')
    assert.equal(local.weekStart, '2026-10-26')
    assert.equal(local.monthStart, '2026-10-01')
    assert.equal(local.windowDays, 30)
    assert.equal(local.days.length, 30)
    assert.equal(local.days[29].date, '2026-10-30')
    assert.equal(local.days[29].total, 100 + 15)
    assert.equal(local.days[29].requests, 2)
    assert.equal(local.days[29].sessions, 2)
    assert.equal(local.days[29].costUsd, 0.512346)
    assert.equal(local.days.find((day) => day.date === '2026-10-29').total, 50)
    assert.equal(
      local.days.reduce((sum, day) => sum + day.total, 0),
      165,
      '窗口外（8 月 20 日）的 777 由 SQL 时间过滤挡住',
    )
    assert.equal(local.scan.matched, 3)
    assert.equal(local.scan.truncated, false)
    assert.ok(local.scan.elapsedMs >= 0)

    // v0.9.3：readOpenCodeLocal 正常路径输出今天 24 小时桶（10 点 100 / 11 点 15；昨天 09 点的 50 不进）
    assert.equal(local.hours.length, 24)
    assert.equal(local.hours[10].total, 100)
    assert.equal(local.hours[10].requests, 1)
    assert.equal(local.hours[10].costUsd, 0.012346)
    assert.equal(local.hours[11].total, 15)
    assert.equal(local.hours[11].costUsd, 0.5)
    assert.equal(local.hours[9].total, 0, '昨天的消息不得进今天小时桶')
    assert.deepEqual(
      local.models.map((item) => item.model),
      ['deepseek-v4-flash', 'glm-5'],
    )

    // 绝不写库：DB 字节与目录内容都不变
    assert.ok(before.equals(readFileSync(dbPath)), 'readOnly 打开不得修改 DB 文件')
    assert.deepEqual(readdirSync(dir).sort(), filesBefore, '不得创建 -wal / -journal 等文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeLocal: 超过 maxMessages 时截断并标记 scan.truncated', { skip: SQLITE_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-db-limit-'))
  try {
    const now = at(2026, 9, 30, 12)
    const rows = [28, 29, 30].map((day) => ({
      sessionId: 's' + day,
      timeCreated: at(2026, 9, day, 10),
      data: { role: 'assistant', tokens: { total: day }, cost: 0.01 },
    }))
    const dbPath = createMessageDb(dir, now, rows)
    const result = await readOpenCodeLocal({ dbPath, now, maxMessages: 2 })
    assert.equal(result.reason, null)
    assert.equal(result.local.scan.truncated, true)
    assert.equal(result.local.scan.messages, 2)
    assert.equal(result.local.scan.matched, 2)
    // 截断必须保留窗口内**最新**的行（DESC），不能只剩最旧的两天
    const byDate = new Map(result.local.days.map((day) => [day.date, day]))
    assert.equal(byDate.get('2026-10-28').total, 0, '最旧的一天应被截掉')
    assert.equal(byDate.get('2026-10-29').total, 29)
    assert.equal(byDate.get('2026-10-30').total, 30, '今天的数据必须保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeLocal: DB 不存在 → no-db；node:sqlite 不可用 → no-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-db-none-'))
  try {
    const missing = await readOpenCodeLocal({ dbPath: join(dir, 'missing.db'), now: at(2026, 9, 30, 12) })
    assert.deepEqual(missing, { local: null, error: null, reason: 'no-db' })

    const existing = join(dir, 'fake.db')
    writeFileSync(existing, 'x')
    const noSqlite = await readOpenCodeLocal({
      dbPath: existing,
      now: at(2026, 9, 30, 12),
      sqlite: null,
    })
    assert.deepEqual(noSqlite, { local: null, error: null, reason: 'no-sqlite' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeLocal: Node 20（没有 node:sqlite）→ no-sqlite，不抛错', { skip: hasSqlite }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-db-node20-'))
  try {
    const filePath = join(dir, 'opencode.db')
    writeFileSync(filePath, 'x')
    const result = await readOpenCodeLocal({ dbPath: filePath, now: at(2026, 9, 30, 12) })
    assert.deepEqual(result, { local: null, error: null, reason: 'no-sqlite' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOpenCodeLocal: DB 存在但打不开/查询失败 → read-failed（不抛错）', { skip: SQLITE_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-db-broken-'))
  try {
    const corrupt = join(dir, 'opencode.db')
    writeFileSync(corrupt, 'definitely not a sqlite database')
    const result = await readOpenCodeLocal({ dbPath: corrupt, now: at(2026, 9, 30, 12) })
    assert.equal(result.local, null)
    assert.equal(result.reason, 'read-failed')
    assert.equal(result.error.code, 'internal')
    assert.equal(result.error.source, 'opencode-local')
    assert.match(result.error.message, /读取本机 opencode.db 失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------- runCollect ----------------------------------- */

test('runCollect: 只有 OpenCode key 时照常采集（Ollama 部分空形状，不产生 no-key）', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const calls = []
    await withFetch(
      async (url, init) => {
        calls.push({ url, auth: init && init.headers ? init.headers.Authorization : null })
        return usageResponse(SAMPLE_USAGE)
      },
      async () => {
        const rt = makeRt()
        const out = await dispatch(rt, 'refresh', {})
        assert.equal(out.ok, true)
        const value = out.value
        assert.equal(value.version, 1)
        assert.equal(value.cached, false)
        assert.deepEqual(value.key, { source: 'none', masked: null })
        assert.deepEqual(value.limits, emptyLimits())
        assert.equal(value.official.range24h, null)
        assert.equal(value.official.range7d, null)
        assert.equal(value.official.range30d, null)
        assert.equal(value.opencode.configured, true)
        assert.equal(value.opencode.key.source, 'env')
        assert.equal(value.opencode.kind, 'go')
        assert.equal(value.opencode.usage.rolling.usedPercent, 52)
        assert.ok(value.opencode.fetchedAt !== null)

        assert.equal(calls.length, 1, '没有 Ollama key 时不得请求 balance / usage')
        assert.equal(calls[0].url, USAGE_URL)
        assert.equal(calls[0].auth, 'Bearer oc-env-secret')

        assert.equal(value.errors.some((item) => item.code === 'no-key'), false)
        assert.ok(
          value.errors.some((item) => item.source === 'tokens' && item.code === 'internal'),
          '没有 sessionQuery 时 tokens 独立降级，不影响 OpenCode',
        )

        const stateFile = join(dshHome, 'storages', 'ollama-statistical', 'state.json')
        const state = JSON.parse(readFileSync(stateFile, 'utf8'))
        assert.equal(state.version, 1)
        assert.equal(state.lastSnapshot.opencode.kind, 'go')
      },
    )
  })
})

test('runCollect: 两个 key 都没有 → 仍返回 ok:true + 本地 token 统计（v0.9/契约 §8）', async () => {
  await withIsolatedEnv(async () => {
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('不得发起网络请求')
      },
      async () => {
        const out = await dispatch(makeRt(), 'refresh', {})
        assert.equal(out.ok, true, 'Key 不是必填项：没有 key 也返回 ok:true')
        assert.equal(fetchCalls, 0, '没有 key 时不得发任何网络请求')
        const value = out.value
        assert.equal(value.version, 1)
        assert.equal(value.cached, false)
        assert.deepEqual(value.key, { source: 'none', masked: null })
        assert.deepEqual(value.limits, emptyLimits())
        assert.equal(value.official.range24h, null)
        assert.equal(value.opencode.configured, false)
        assert.deepEqual(value.opencode.key, { source: 'none', masked: null })
        assert.equal(value.opencode.kind, 'none')
        assert.equal(value.tokens.days.length, 30, '本地 token 统计照常返回 30 天桶')
        assert.deepEqual(value.tokens.providers, [])
        assert.equal(value.errors.some((item) => item.source === 'key'), false, '新 host 不再产生 no-key')
        assert.equal(
          value.errors.some((item) => item.code === 'no-key' || item.code === 'no-data'),
          false,
          'no-key / no-data 只保留给旧 host 兼容',
        )
        // 没有 sessionQuery 时 tokens 独立降级为 internal，属正常
        assert.ok(value.errors.some((item) => item.source === 'tokens' && item.code === 'internal'))
      },
    )
  })
})

test('runCollect: OpenCode 401 只进 errors，不影响 Ollama 限额与官方用量', async () => {
  await withIsolatedEnv(async () => {
    process.env.OLLAMA_API_KEY = 'ollama-env-secret'
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    await withFetch(
      async (url) => {
        if (url.includes('opencode.ai')) {
          return usageResponse({ error: { code: 'api_key_expired', message: 'api key expired' } }, 401)
        }
        if (url === OLLAMA_BALANCE_URL) {
          return jsonResponse({
            included: { session: { remaining_percent: 70.83, resets_at: '2026-10-30T09:00:00Z' } },
            purchased: { balance_usd: 0 },
          })
        }
        return jsonResponse({
          range: url.includes('24h') ? '24h' : url.includes('7d') ? '7d' : '30d',
          granularity: url.includes('24h') ? 'hour' : 'day',
          totals: { request_count: 10 },
          buckets: [{ from: '2026-10-30T00:00:00Z', until: '2026-10-30T01:00:00Z', request_count: 10 }],
        })
      },
      async () => {
        const out = await dispatch(makeRt(), 'refresh', {})
        assert.equal(out.ok, true)
        const value = out.value
        // Ollama 侧完全正常
        assert.equal(value.limits.kind, 'legacy')
        assert.equal(value.limits.session.usedPercent, 29.17)
        assert.equal(value.official.range24h.requestCount, 10)
        assert.equal(value.key.source, 'env')
        assert.equal(value.key.masked, '****cret')
        assert.equal(value.errors.some((item) => item.source === 'balance'), false, 'OpenCode 失败不得污染 Ollama')
        // OpenCode 侧只降级进 errors
        assert.equal(value.opencode.configured, true)
        assert.equal(value.opencode.kind, 'none')
        assert.equal(value.opencode.usage, null)
        assert.equal(value.opencode.fetchedAt, null)
        const openCodeErrors = value.errors.filter((item) => item.source === 'opencode')
        assert.equal(openCodeErrors.length, 1)
        assert.equal(openCodeErrors[0].code, 'unauthorized')
      },
    )
  })
})

test('安全：完整 key 不出现在任何返回给浏览器的 JSON 中（snapshot / auth-state / set-key / clear-key）', async () => {
  await withIsolatedEnv(async () => {
    const ollamaKey = 'ollama-env-secret-1234'
    const opencodeKey = 'oc-env-secret-5678'
    const manualKey = 'oc-manual-secret-9012'
    process.env.OLLAMA_API_KEY = ollamaKey
    process.env.OPENCODE_API_KEY = opencodeKey
    await withFetch(
      async (url) => {
        if (url.includes('opencode.ai')) return usageResponse(SAMPLE_USAGE)
        if (url === OLLAMA_BALANCE_URL) {
          return jsonResponse({ included: { session: { remaining_percent: 70 } } })
        }
        return jsonResponse({
          range: '24h',
          granularity: 'hour',
          totals: { request_count: 1 },
          buckets: [],
        })
      },
      async () => {
        const rt = makeRt()
        const snapshotOut = await dispatch(rt, 'refresh', {})
        const authOut = await dispatch(rt, 'auth-state', {})
        const setOut = await dispatch(rt, 'set-key', { token: manualKey, provider: 'opencode' })
        const clearOut = await dispatch(rt, 'clear-key', { provider: 'opencode' })
        const payloads = [snapshotOut, authOut, setOut, clearOut].map((out) => JSON.stringify(out))
        for (const payload of payloads) {
          for (const secret of [ollamaKey, opencodeKey, manualKey]) {
            assert.equal(payload.includes(secret), false, '返回 JSON 不得包含完整 key：' + secret)
          }
        }
        // 只返回脱敏（末 4 位）
        assert.equal(snapshotOut.value.key.masked, '****1234')
        assert.equal(snapshotOut.value.opencode.key.masked, '****5678')
        assert.equal(authOut.value.opencode.key.masked, '****5678')
        assert.equal(setOut.value.key.masked, '****9012')
        assert.equal(clearOut.value.key.masked, '****5678')
      },
    )
  })
})

/* ------------------------- auth-state / set-key / clear-key ------------------------- */

test('auth-state: 新增 opencode 子对象，原有 Ollama 字段不变', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const out = await dispatch(makeRt(), 'auth-state', {})
    assert.equal(out.ok, true)
    const value = out.value
    // Ollama 部分维持原样（没有 Ollama key）
    assert.equal(value.hasKey, false)
    assert.deepEqual(value.key, { source: 'none', masked: null })
    assert.deepEqual(value.sources, { credentials: false, env: false, localCli: false, manual: false })
    assert.equal(value.source, 'none')
    assert.equal(value.masked, null)
    // v0.8 增量
    assert.deepEqual(value.opencode, {
      hasKey: true,
      key: { source: 'env', masked: '****cret' },
      sources: { credentials: false, env: true, localCli: false, manual: false },
      disabled: false,
    })
  })
})

test('auth-state: opencode 来源为 local-cli（auth.json）', async () => {
  await withIsolatedEnv(async ({ home }) => {
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc-go-token-1234' } }),
    )
    const out = await dispatch(makeRt(), 'auth-state', {})
    assert.equal(out.value.opencode.hasKey, true)
    assert.deepEqual(out.value.opencode.key, { source: 'local-cli', masked: '****1234' })
    assert.deepEqual(out.value.opencode.sources, {
      credentials: false,
      env: false,
      localCli: true,
      manual: false,
    })
  })
})

test('set-key provider=opencode: 200 即通过，写 state.opencodeManualKey 且不动 Ollama 冷却', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    await withFetch(
      async (url) => {
        assert.equal(url, USAGE_URL)
        return usageResponse({})
      },
      async () => {
        const rt = makeRt({ rateLimitedUntil: 987654 })
        const out = await dispatch(rt, 'set-key', { token: 'oc-manual-key', provider: 'opencode' })
        assert.equal(out.ok, true)
        assert.deepEqual(out.value, { valid: true, key: { source: 'manual', masked: '****-key' } })
        assert.equal(rt.state.opencodeManualKey, 'oc-manual-key')
        assert.equal(rt.snapshotCache, null)
        assert.equal(rt.rateLimitedUntil, 987654, 'opencode 校验不得重置 Ollama 的限流冷却')
        const stateFile = join(dshHome, 'storages', 'ollama-statistical', 'state.json')
        const state = JSON.parse(readFileSync(stateFile, 'utf8'))
        assert.equal(state.version, 1)
        assert.equal(state.opencodeManualKey, 'oc-manual-key')
        assert.equal('manualKey' in state, false)
      },
    )
  })
})

test('set-key provider=opencode: 401/429/空 token → 对应错误码且不持久化', async () => {
  await withIsolatedEnv(async () => {
    const cases = [
      {
        response: () => usageResponse({ error: { code: 'api_key_expired', message: 'api key expired' } }, 401),
        code: 'unauthorized',
      },
      {
        response: () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
        code: 'rate-limit',
      },
    ]
    for (const item of cases) {
      await withFetch(item.response, async () => {
        const rt = makeRt({ rateLimitedUntil: 555 })
        const out = await dispatch(rt, 'set-key', { token: 'oc-bad-key', provider: 'opencode' })
        assert.equal(out.ok, false)
        assert.equal(out.error.code, item.code)
        assert.equal(rt.state.opencodeManualKey, null)
        assert.equal(rt.rateLimitedUntil, 555)
      })
    }
    const rt = makeRt()
    const empty = await dispatch(rt, 'set-key', { token: '   ', provider: 'opencode' })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'bad-request')
  })
})

test('set-key provider=ollama: 缺省行为不变（balance 校验、写 manualKey、清冷却）', async () => {
  await withIsolatedEnv(async () => {
    await withFetch(
      async (url) => {
        assert.equal(url, OLLAMA_BALANCE_URL)
        return jsonResponse({ included: { session: { remaining_percent: 70 } } })
      },
      async () => {
        const rt = makeRt({ rateLimitedUntil: 555 })
        const out = await dispatch(rt, 'set-key', { token: 'ollama-manual-key' })
        assert.equal(out.ok, true)
        assert.deepEqual(out.value, {
          valid: true,
          key: { source: 'manual', masked: '****-key' },
          source: 'manual',
          masked: '****-key',
        })
        assert.equal(rt.state.manualKey, 'ollama-manual-key')
        assert.equal(rt.state.opencodeManualKey, null)
        assert.equal(rt.rateLimitedUntil, 0)
      },
    )
  })
})

test('clear-key provider=opencode: 只清 opencodeManualKey，并按优先级重新 resolve', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const rt = makeRt()
    rt.state.opencodeManualKey = 'oc-manual-key'
    rt.state.manualKey = 'ollama-manual-key'
    const out = await dispatch(rt, 'clear-key', { provider: 'opencode' })
    assert.equal(out.ok, true)
    assert.deepEqual(out.value, {
      cleared: true,
      key: { source: 'env', masked: '****cret' },
    })
    assert.equal(rt.state.opencodeManualKey, null)
    assert.equal(rt.state.manualKey, 'ollama-manual-key', '不得清 Ollama 手动 key')
  })
})

test('clear-key provider=opencode: 没有其它来源时 key={source:none,masked:null}', async () => {
  await withIsolatedEnv(async () => {
    const rt = makeRt()
    rt.state.opencodeManualKey = 'oc-manual-key'
    const out = await dispatch(rt, 'clear-key', { provider: 'opencode' })
    assert.deepEqual(out.value, { cleared: true, key: { source: 'none', masked: null } })
    assert.equal(rt.state.opencodeManualKey, null)
  })
})

test('clear-key provider=ollama（缺省）: 行为不变，不动 opencodeManualKey', async () => {
  await withIsolatedEnv(async () => {
    process.env.OLLAMA_API_KEY = 'ollama-env-key'
    const rt = makeRt()
    rt.state.manualKey = 'ollama-manual-key'
    rt.state.opencodeManualKey = 'oc-manual-key'
    const out = await dispatch(rt, 'clear-key', {})
    assert.equal(out.ok, true)
    assert.equal(out.value.cleared, true)
    assert.equal(out.value.key.source, 'env')
    assert.equal(rt.state.manualKey, null)
    assert.equal(rt.state.opencodeManualKey, 'oc-manual-key')
  })
})

/* ------------------- v0.9.1 页面「移除 Key」（契约 §8.4） ------------------- */

test('snapshot/auth-state.opencode.disabled 默认 false（未停用时）', async () => {
  await withIsolatedEnv(async () => {
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('不得发起网络请求')
      },
      async () => {
        const out = await dispatch(makeRt(), 'refresh', {})
        assert.equal(out.ok, true)
        assert.equal(out.value.opencode.disabled, false)
        const auth = await dispatch(makeRt(), 'auth-state', {})
        assert.equal(auth.value.opencode.disabled, false)
        assert.equal(fetchCalls, 0)
      },
    )
  })
})

test('collectOpenCode: disabled=true 时零 key 解析 / 零 fetch / 零 DB，返回 disabled 空形状', async () => {
  await withIsolatedEnv(async ({ root }) => {
    // 环境里有可用 key、DB 也「存在但损坏」：disabled 时都不能被碰（否则会出 error / fetch）
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    mkdirSync(join(root, 'db'), { recursive: true })
    const corrupt = join(root, 'db', 'opencode.db')
    writeFileSync(corrupt, 'definitely not a sqlite database')
    process.env.OPENCODE_DB_PATH = corrupt
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        return usageResponse(SAMPLE_USAGE)
      },
      async () => {
        const rt = makeRt()
        rt.state.opencodeDisabled = true
        // 停用后不得再访问任何 DSH 服务（key 解析会走 ctx.get('credentials')）
        rt.ctx = {
          get() {
            throw new Error('disabled 时不得访问任何服务')
          },
        }
        const result = await collectOpenCode(rt, at(2026, 9, 30, 9))
        assert.equal(fetchCalls, 0, 'disabled 时不得请求 usage')
        assert.deepEqual(result.errors, [], 'disabled 时不产生任何 errors（含 opencode-local）')
        assert.deepEqual(result.opencode, { ...emptyOpenCode(), disabled: true })
        assert.equal(result.opencode.configured, false)
        assert.equal(result.opencode.usage, null)
        assert.equal(result.opencode.local, null)
      },
    )
  })
})

test('clear-key mode=disable: 清手动 key + 置 disabled + 删 DSH 凭证 + 持久化', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const deleteCalls = []
    const rt = makeRt()
    rt.state.opencodeManualKey = 'oc-manual-key'
    rt.ctx = {
      get(name) {
        if (name === 'credentials') {
          return {
            resolve: async () => null,
            deleteRecord: async (ref) => {
              deleteCalls.push(ref)
            },
          }
        }
        return undefined
      },
    }
    const out = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'disable' })
    assert.equal(out.ok, true)
    assert.deepEqual(out.value, {
      cleared: true,
      disabled: true,
      key: { source: 'none', masked: null },
    })
    assert.equal(rt.state.opencodeDisabled, true)
    assert.equal(rt.state.opencodeManualKey, null)
    assert.equal(rt.snapshotCache, null)
    assert.deepEqual(deleteCalls.sort(), ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY'])

    const stateFile = join(dshHome, 'storages', 'ollama-statistical', 'state.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.opencodeDisabled, true)
    assert.equal('opencodeManualKey' in state, false)
  })
})

test('clear-key mode=disable 后 refresh：snapshot.opencode.disabled=true、零 fetch、零 DB、无 opencode 错误', async () => {
  await withIsolatedEnv(async ({ root }) => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    mkdirSync(join(root, 'db'), { recursive: true })
    const corrupt = join(root, 'db', 'opencode.db')
    writeFileSync(corrupt, 'definitely not a sqlite database')
    process.env.OPENCODE_DB_PATH = corrupt

    const rt = makeRt()
    const disabled = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'disable' })
    assert.equal(disabled.value.disabled, true)

    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        throw new Error('停用后不得发起网络请求')
      },
      async () => {
        const out = await dispatch(rt, 'refresh', {})
        assert.equal(out.ok, true)
        assert.equal(fetchCalls, 0)
        const opencode = out.value.opencode
        assert.equal(opencode.disabled, true)
        assert.equal(opencode.configured, false)
        assert.deepEqual(opencode.key, { source: 'none', masked: null })
        assert.equal(opencode.kind, 'none')
        assert.equal(opencode.usage, null)
        assert.equal(opencode.local, null)
        assert.equal(
          out.value.errors.some((item) => item.source === 'opencode' || item.source === 'opencode-local'),
          false,
          '停用后不得出现 opencode / opencode-local 错误',
        )
        // tokens 仍照常统计（没有 sessionQuery → internal 属正常）
        assert.equal(out.value.tokens.days.length, 30)
      },
    )
  })
})

test('auth-state: disabled=true 时不 resolve OpenCode key，返回全 false + disabled', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const resolveCalls = []
    const rt = makeRt()
    rt.state.opencodeDisabled = true
    rt.ctx = {
      get(name) {
        if (name === 'credentials') {
          return {
            resolve: async (ref) => {
              resolveCalls.push(ref)
              return null
            },
          }
        }
        return undefined
      },
    }
    const out = await dispatch(rt, 'auth-state', {})
    assert.equal(out.ok, true)
    assert.deepEqual(out.value.opencode, {
      hasKey: false,
      key: { source: 'none', masked: null },
      sources: { credentials: false, env: false, localCli: false, manual: false },
      disabled: true,
    })
    assert.equal(resolveCalls.includes('OPENCODE_API_KEY'), false, 'disabled 时不得解析 OpenCode 凭证')
    assert.equal(resolveCalls.includes('OPENCODE_GO_API_KEY'), false)
    // Ollama 部分照常（只有 OLLAMA_API_KEY 会被解析）
    assert.equal(out.value.hasKey, false)
  })
})

test('clear-key mode=enable: 清除 disabled 并按优先级恢复外部 Key（持久化不写标志）', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const rt = makeRt()
    rt.state.opencodeDisabled = true
    const out = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'enable' })
    assert.equal(out.ok, true)
    assert.deepEqual(out.value, {
      enabled: true,
      disabled: false,
      key: { source: 'env', masked: '****cret' },
    })
    assert.equal(rt.state.opencodeDisabled, false)

    const stateFile = join(dshHome, 'storages', 'ollama-statistical', 'state.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.version, 1)
    assert.equal('opencodeDisabled' in state, false, 'enable 后不落 disabled 标志')

    const auth = await dispatch(rt, 'auth-state', {})
    assert.equal(auth.value.opencode.disabled, false)
    assert.equal(auth.value.opencode.key.source, 'env')
  })
})

test('clear-key provider=opencode 缺省 / manual：只清手动 key，不置 disabled', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    const rt = makeRt()
    rt.state.opencodeManualKey = 'oc-manual-key'
    const manual = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'manual' })
    assert.equal(manual.ok, true)
    assert.deepEqual(manual.value, { cleared: true, key: { source: 'env', masked: '****cret' } })
    assert.equal('disabled' in manual.value, false)
    assert.equal(rt.state.opencodeDisabled, false)
    assert.equal(rt.state.opencodeManualKey, null)

    rt.state.opencodeManualKey = 'oc-manual-key-2'
    const fallback = await dispatch(rt, 'clear-key', { provider: 'opencode' })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.value.cleared, true)
    assert.equal(rt.state.opencodeDisabled, false)
  })
})

test('set-key provider=opencode: 粘贴新 Key 自动清除 disabled（恢复）', async () => {
  await withIsolatedEnv(async () => {
    const rt = makeRt()
    rt.state.opencodeDisabled = true
    await withFetch(
      async () => usageResponse({}),
      async () => {
        const out = await dispatch(rt, 'set-key', { token: 'oc-manual-key', provider: 'opencode' })
        assert.equal(out.ok, true)
        assert.equal(rt.state.opencodeDisabled, false)
        assert.equal(rt.state.opencodeManualKey, 'oc-manual-key')
        const auth = await dispatch(rt, 'auth-state', {})
        assert.equal(auth.value.opencode.disabled, false)
        assert.equal(auth.value.opencode.key.source, 'manual')
      },
    )
  })
})

test('clear-key mode=disable: credentials 无 deleteRecord / 抛错 / 服务异常都不影响成功', async () => {
  await withIsolatedEnv(async () => {
    // 1) 没有 deleteRecord
    const rt1 = makeRt()
    rt1.ctx = { get: () => ({ resolve: async () => null }) }
    const out1 = await dispatch(rt1, 'clear-key', { provider: 'opencode', mode: 'disable' })
    assert.equal(out1.ok, true)
    assert.equal(rt1.state.opencodeDisabled, true)

    // 2) deleteRecord 抛错
    const rt2 = makeRt()
    rt2.ctx = {
      get: () => ({
        resolve: async () => null,
        deleteRecord: async () => {
          throw new Error('delete failed')
        },
      }),
    }
    const out2 = await dispatch(rt2, 'clear-key', { provider: 'opencode', mode: 'disable' })
    assert.equal(out2.ok, true)
    assert.equal(rt2.state.opencodeDisabled, true)

    // 3) ctx.get 本身抛错
    const rt3 = makeRt()
    rt3.ctx = {
      get() {
        throw new Error('credentials service down')
      },
    }
    const out3 = await dispatch(rt3, 'clear-key', { provider: 'opencode', mode: 'disable' })
    assert.equal(out3.ok, true)
    assert.deepEqual(out3.value, { cleared: true, disabled: true, key: { source: 'none', masked: null } })
  })
})

test('loadPersisted: 读取 state.opencodeDisabled=true（state.version 仍为 1）', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    const dir = join(dshHome, 'storages', 'ollama-statistical')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, opencodeDisabled: true }))
    const rt = makeRt()
    rt.state.opencodeDisabled = false
    loadPersisted(rt)
    assert.equal(rt.state.opencodeDisabled, true)
  })
})

test('loadPersisted: 没有 opencodeDisabled 字段时保持 false（旧 state 兼容）', async () => {
  await withIsolatedEnv(async ({ dshHome }) => {
    const dir = join(dshHome, 'storages', 'ollama-statistical')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, manualKey: 'x' }))
    const rt = makeRt()
    loadPersisted(rt)
    assert.equal(rt.state.opencodeDisabled, false)
  })
})

test('disable 后立即 snapshot（SWR 旧值路径）已反映 disabled=true，且停用后重采零 usage 请求', async () => {
  await withIsolatedEnv(async () => {
    process.env.OPENCODE_API_KEY = 'oc-env-secret'
    let fetchCalls = 0
    await withFetch(
      async () => {
        fetchCalls += 1
        return usageResponse(SAMPLE_USAGE)
      },
      async () => {
        const rt = makeRt()
        const first = await dispatch(rt, 'snapshot', {})
        assert.equal(first.ok, true)
        assert.equal(first.value.opencode.kind, 'go')
        assert.equal(fetchCalls, 1)

        // 停用前残留的 OpenCode 错误不应继续留在 lastSnapshot（SWR 会返回它）
        rt.state.lastSnapshot.errors = [
          { source: 'opencode-local', code: 'internal', message: 'stale' },
          { source: 'balance', code: 'network', message: 'keep-me' },
        ]
        const disabled = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'disable' })
        assert.equal(disabled.value.disabled, true)
        assert.equal(rt.state.lastSnapshot.opencode.disabled, true, '停用状态要同步进已保存快照')
        assert.deepEqual(rt.state.lastSnapshot.errors, [{ source: 'balance', code: 'network', message: 'keep-me' }], '停用时应清掉 opencode/opencode-local 旧错误')

        // 紧接着的 snapshot 走 SWR（60s 内存缓存被清、返回 lastSnapshot）
        const second = await dispatch(rt, 'snapshot', {})
        assert.equal(second.ok, true)
        assert.equal(second.value.cached, true)
        assert.equal(second.value.opencode.disabled, true)
        assert.equal(second.value.opencode.configured, false)
        assert.equal(second.value.opencode.usage, null)
        assert.equal(second.value.opencode.local, null)
        const bg = rt.inflight
        if (bg) await bg
        assert.equal(fetchCalls, 1, '停用后的后台重采不得再请求 usage')

        // enable 后立即 snapshot 也不再显示 disabled=true
        const enabled = await dispatch(rt, 'clear-key', { provider: 'opencode', mode: 'enable' })
        assert.equal(enabled.value.enabled, true)
        const third = await dispatch(rt, 'snapshot', {})
        assert.equal(third.ok, true)
        assert.equal(third.value.opencode.disabled, false)
        const bg2 = rt.inflight
        if (bg2) await bg2
      },
    )
  })
})

