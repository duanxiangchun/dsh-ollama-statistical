/**
 * RPC 信封 / 路由 / 错误码单测。
 * handleBridgeCore 与 HTTP 解耦，因此这里不需要真的监听端口。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  buildServerResponse,
  dispatch,
  endpointFromPath,
  fail,
  handleBridgeCore,
  isLoopbackHost,
  readRequestBody,
  validateEnvelope,
} from '../lib/index.js'

const CHANNEL = '/ollama-statistical'

function envelope(overrides = {}) {
  return { type: 'client-request', rpcId: 'rpc-1', method: 'snapshot', payload: {}, ...overrides }
}

function bridgeInput(overrides = {}) {
  return {
    method: 'POST',
    contentType: 'application/json',
    host: '127.0.0.1:64609',
    url: CHANNEL + '/snapshot',
    body: JSON.stringify(envelope()),
    ...overrides,
  }
}

/** 记录 dispatch 实际收到的 endpoint/payload。 */
function stubDispatch(result) {
  const calls = []
  const fn = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    return result === undefined ? { ok: true, value: { pong: true } } : result
  }
  fn.calls = calls
  return fn
}

/* ---------------------------------- fail ---------------------------------- */

test('fail: 契约里的每个错误码都带对象 details', () => {
  for (const code of [
    'bad-request',
    'no-key',
    'unauthorized',
    'rate-limit',
    'network',
    'http',
    'no-data',
    'internal',
  ]) {
    const result = fail(code, 'message-' + code)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.equal(result.error.message, 'message-' + code)
    assert.equal(typeof result.error.details, 'object')
    assert.ok(result.error.details !== null)
    assert.equal(Array.isArray(result.error.details), false)
  }
})

test('fail: details 非对象时归一成 {}，不会让浏览器端 reject', () => {
  for (const details of [undefined, null, 'str', 42, ['a']]) {
    const result = fail('network', 'x', details)
    assert.deepEqual(result.error.details, {})
  }
  assert.deepEqual(fail('network', 'x', { retryAfterMs: 1000 }).error.details, { retryAfterMs: 1000 })
})

test('buildServerResponse: server-response 信封形状', () => {
  const response = buildServerResponse('rpc-9', { ok: true, value: 1 })
  assert.deepEqual(response, {
    type: 'server-response',
    rpcId: 'rpc-9',
    result: { ok: true, value: 1 },
  })
})

/* ------------------------------ validateEnvelope ----------------------------- */

test('validateEnvelope: 合法信封', () => {
  const result = validateEnvelope(envelope({ payload: { force: true } }))
  assert.equal(result.ok, true)
  assert.equal(result.method, 'snapshot')
  assert.deepEqual(result.payload, { force: true })
})

test('validateEnvelope: 缺省 payload 宽容成 {}', () => {
  const result = validateEnvelope({ type: 'client-request', rpcId: 'r', method: 'auth-state' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.payload, {})
})

test('validateEnvelope: 非法信封逐项拒绝', () => {
  assert.equal(validateEnvelope(null).ok, false)
  assert.equal(validateEnvelope([]).ok, false)
  assert.equal(validateEnvelope('x').ok, false)
  // type 不对
  assert.equal(validateEnvelope({ type: 'server-response', rpcId: 'r', method: 'snapshot' }).ok, false)
  // rpcId 不是字符串
  assert.equal(validateEnvelope({ type: 'client-request', rpcId: 7, method: 'snapshot' }).ok, false)
  // method 缺失 / 空
  assert.equal(validateEnvelope({ type: 'client-request', rpcId: 'r' }).ok, false)
  assert.equal(validateEnvelope({ type: 'client-request', rpcId: 'r', method: '' }).ok, false)
})

/* -------------------------------- loopback -------------------------------- */

test('isLoopbackHost: 只放行 loopback', () => {
  for (const host of ['127.0.0.1:64609', '127.0.0.1', 'localhost:3000', 'localhost', '[::1]:8080']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['192.168.1.10:80', '10.0.0.1:1', 'evil.com', '127.0.0.1.evil.com', '', '   ']) {
    assert.equal(isLoopbackHost(host), false, JSON.stringify(host))
  }
  assert.equal(isLoopbackHost(undefined), false)
  assert.equal(isLoopbackHost(null), false)
})

test('endpointFromPath: 只接受直接子路径', () => {
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical/snapshot'), 'snapshot')
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical/a/b'), 'a/b')
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical/'), undefined)
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical'), undefined)
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical/../secret'), undefined)
  assert.equal(endpointFromPath(CHANNEL, '/ollama-statistical/a//b'), undefined)
  assert.equal(endpointFromPath(CHANNEL, '/other/snapshot'), undefined)
  assert.equal(endpointFromPath(CHANNEL, undefined), undefined)
})

/* ------------------------------ handleBridgeCore ----------------------------- */

test('handleBridgeCore: 非 POST → 404 纯文本', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ method: 'GET' }), stubDispatch())
  assert.equal(outcome.status, 404)
  assert.equal(outcome.json, undefined)
  assert.equal(outcome.text, 'not found')
})

test('handleBridgeCore: 非 JSON Content-Type → 415 纯文本', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ contentType: 'text/plain' }), stubDispatch())
  assert.equal(outcome.status, 415)
  assert.equal(outcome.json, undefined)
})

test('handleBridgeCore: 非 loopback Host → 403 纯文本', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ host: '192.168.1.20:64609' }), stubDispatch())
  assert.equal(outcome.status, 403)
  assert.equal(outcome.text, 'forbidden')
})

test('handleBridgeCore: body 不是 JSON → 400 纯文本', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ body: '{oops' }), stubDispatch())
  assert.equal(outcome.status, 400)
  assert.equal(outcome.text, 'body is not JSON')
})

test('handleBridgeCore: 非法信封 → 200 + bad-request（details 是对象）', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ body: '{"type":"client-request"}' }), stubDispatch())
  assert.equal(outcome.status, 200)
  assert.equal(outcome.json.type, 'server-response')
  assert.equal(outcome.json.result.ok, false)
  assert.equal(outcome.json.result.error.code, 'bad-request')
  assert.equal(typeof outcome.json.result.error.details, 'object')
  assert.ok(Array.isArray(outcome.json.result.error.details.issues))
})

test('handleBridgeCore: 合法信封 → 200 + server-response，dispatch 收到 endpoint/payload', async () => {
  const dispatcher = stubDispatch({ ok: true, value: { hello: 'world' } })
  const outcome = await handleBridgeCore(
    bridgeInput({
      url: CHANNEL + '/set-key',
      body: JSON.stringify(envelope({ rpcId: 'rpc-42', method: 'set-key', payload: { token: 'abc' } })),
    }),
    dispatcher,
  )
  assert.equal(outcome.status, 200)
  assert.deepEqual(outcome.json, {
    type: 'server-response',
    rpcId: 'rpc-42',
    result: { ok: true, value: { hello: 'world' } },
  })
  assert.deepEqual(dispatcher.calls, [{ endpoint: 'set-key', payload: { token: 'abc' } }])
})

test('handleBridgeCore: 未知 endpoint → 200 + bad-request', async () => {
  const outcome = await handleBridgeCore(
    bridgeInput({
      url: CHANNEL + '/does-not-exist',
      body: JSON.stringify(envelope({ rpcId: 'rpc-x', method: 'does-not-exist' })),
    }),
    (endpoint, payload) => dispatch(null, endpoint, payload),
  )
  assert.equal(outcome.status, 200)
  assert.equal(outcome.json.result.ok, false)
  assert.equal(outcome.json.result.error.code, 'bad-request')
  assert.deepEqual(outcome.json.result.error.details, { endpoint: 'does-not-exist' })
})

test('handleBridgeCore: URL endpoint 与信封 method 不一致 → bad-request', async () => {
  const outcome = await handleBridgeCore(
    bridgeInput({
      url: CHANNEL + '/snapshot',
      body: JSON.stringify(envelope({ method: 'refresh' })),
    }),
    stubDispatch(),
  )
  assert.equal(outcome.status, 200)
  assert.equal(outcome.json.result.error.code, 'bad-request')
  assert.equal(outcome.json.result.error.details.issues.length, 1)
})

test('handleBridgeCore: 空 body 视为非法信封', async () => {
  const outcome = await handleBridgeCore(bridgeInput({ body: '' }), stubDispatch())
  assert.equal(outcome.status, 200)
  assert.equal(outcome.json.result.error.code, 'bad-request')
})

/* ------------------------------- 请求体读取 -------------------------------- */

/** 用 EventEmitter 伪造 IncomingMessage 的 data/end 事件。 */
function fakeRequestStream(body, { error } = {}) {
  const req = new EventEmitter()
  setImmediate(() => {
    if (error) {
      req.emit('error', error)
      return
    }
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

test('readRequestBody: 正常读取完整 body', async () => {
  const text = await readRequestBody(fakeRequestStream('{"ok":true}'), 1024)
  assert.equal(text, '{"ok":true}')
})

test('readRequestBody: 超过上限 → LIMIT 错误（HTTP 层会回 413）', async () => {
  const oversized = 'x'.repeat(64 * 1024 + 10)
  await assert.rejects(
    () => readRequestBody(fakeRequestStream(oversized), 64 * 1024),
    (error) => error.code === 'LIMIT',
  )
})

test('readRequestBody: 流错误原样 reject', async () => {
  await assert.rejects(
    () => readRequestBody(fakeRequestStream(undefined, { error: new Error('socket hang up') }), 1024),
    /socket hang up/,
  )
})
