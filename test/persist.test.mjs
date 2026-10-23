/**
 * 持久化写盘单测：
 *  - 成功：嵌套目录自动创建、JSON 可回读、POSIX 下权限 0600；
 *  - 失败：父路径是普通文件 / 值无法 JSON 序列化 → 返回 false 且不抛错、无残留临时文件。
 * 全部用系统临时目录，不碰 $DSH_HOME。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJsonAtomic } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-ollama-persist-'))
}

test('writeJsonAtomic: 成功写盘、嵌套目录、JSON 可回读', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'storages', 'ollama-statistical', 'state.json')
    assert.equal(writeJsonAtomic(file, { version: 1, manualKey: 'secret-key-value' }), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: 1,
      manualKey: 'secret-key-value',
    })
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'POSIX 下必须是 0600')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic: 覆盖写不会留下临时文件', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'token-cache.json')
    assert.equal(writeJsonAtomic(file, { version: 2, sessions: {} }), true)
    assert.equal(writeJsonAtomic(file, { version: 2, sessions: { a: 1 } }), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, sessions: { a: 1 } })
    assert.deepEqual(readdirSync(dir), ['token-cache.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic: 父路径是文件（无法建目录）→ 返回 false，不抛错', () => {
  const dir = tempDir()
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    assert.equal(writeJsonAtomic(join(blocker, 'state.json'), { version: 1 }), false)
    // 不残留临时文件（失败发生在 mkdir 阶段，本来也没建）
    assert.deepEqual(readdirSync(dir), ['blocker'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic: 值无法 JSON 序列化（循环引用）→ 返回 false，不抛错', () => {
  const dir = tempDir()
  try {
    const cyclic = { version: 1 }
    cyclic.self = cyclic
    const file = join(dir, 'state.json')
    assert.equal(writeJsonAtomic(file, cyclic), false)
    assert.deepEqual(readdirSync(dir), [], '失败后临时文件必须被清理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
