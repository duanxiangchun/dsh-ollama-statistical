/**
 * key 四级优先级单测：credentials → env → local-cli → manual。
 * 全部用注入 stub，不读真实凭证、不访问网络、不落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveApiKey } from '../lib/index.js'

const allSources = () => ({
  resolveCredential: async () => ({ value: 'cred-1234567890abcd', source: 'provider' }),
  env: 'env-1234567890abcd',
  readLocalToken: () => 'cli-1234567890abcd',
  readManualKey: () => 'man-1234567890abcd',
})

test('resolveApiKey: 四个来源都存在时选 credentials', async () => {
  const info = await resolveApiKey(allSources())
  assert.equal(info.source, 'credentials')
  assert.equal(info.key, 'cred-1234567890abcd')
  assert.deepEqual(info.sources, { credentials: true, env: true, localCli: true, manual: true })
})

test('resolveApiKey: 无 credentials 时选 env', async () => {
  const sources = allSources()
  delete sources.resolveCredential
  const info = await resolveApiKey(sources)
  assert.equal(info.source, 'env')
  assert.equal(info.key, 'env-1234567890abcd')
  assert.equal(info.sources.credentials, false)
  assert.equal(info.sources.env, true)
})

test('resolveApiKey: 只有 local-cli 时选 local-cli', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => undefined,
    env: undefined,
    readLocalToken: () => 'cli-1234567890abcd',
    readManualKey: () => 'man-1234567890abcd',
  })
  assert.equal(info.source, 'local-cli')
  assert.equal(info.key, 'cli-1234567890abcd')
  assert.deepEqual(info.sources, { credentials: false, env: false, localCli: true, manual: true })
})

test('resolveApiKey: 只有 manual 时选 manual', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => null,
    env: '',
    readLocalToken: () => '   ',
    readManualKey: () => 'man-1234567890abcd',
  })
  assert.equal(info.source, 'manual')
  assert.equal(info.key, 'man-1234567890abcd')
  assert.deepEqual(info.sources, { credentials: false, env: false, localCli: false, manual: true })
})

test('resolveApiKey: 四个来源都没有 → source=none，key=null', async () => {
  const info = await resolveApiKey({})
  assert.equal(info.source, 'none')
  assert.equal(info.key, null)
  assert.deepEqual(info.sources, { credentials: false, env: false, localCli: false, manual: false })
})

test('resolveApiKey: 空白字符串视作不存在（不会把空格当 key）', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => ({ value: '   ', source: 'provider' }),
    env: '  ',
    readLocalToken: () => '',
    readManualKey: () => '\t\n',
  })
  assert.equal(info.source, 'none')
  assert.equal(info.key, null)
  assert.deepEqual(info.sources, { credentials: false, env: false, localCli: false, manual: false })
})

test('resolveApiKey: 凭证服务抛错时降级到 env，不中断解析', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => {
      throw new Error('credentials service down')
    },
    env: 'env-1234567890abcd',
  })
  assert.equal(info.source, 'env')
  assert.equal(info.key, 'env-1234567890abcd')
  assert.equal(info.sources.credentials, false)
})

test('resolveApiKey: 本地 CLI 读取抛错时降级到 manual', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => {
      throw new Error('no credentials service')
    },
    env: undefined,
    readLocalToken: () => {
      throw new Error('auth.json broken')
    },
    readManualKey: () => 'man-1234567890abcd',
  })
  assert.equal(info.source, 'manual')
  assert.equal(info.key, 'man-1234567890abcd')
  assert.equal(info.sources.localCli, false)
})

test('resolveApiKey: 返回值会 trim，凭证包装的 { value } 也能解包', async () => {
  const info = await resolveApiKey({
    resolveCredential: async () => ({ value: '  cred-1234567890abcd  ', source: 'provider' }),
  })
  assert.equal(info.key, 'cred-1234567890abcd')
  assert.equal(info.source, 'credentials')
})

test('resolveApiKey: 纯字符串 producer 也支持（env / manual 可以直接传字符串）', async () => {
  const info = await resolveApiKey({ env: '  env-1234567890abcd  ' })
  assert.equal(info.source, 'env')
  assert.equal(info.key, 'env-1234567890abcd')
})
