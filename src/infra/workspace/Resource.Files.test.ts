import assert from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { isResourceFilePath, readOnlyResourceDirs, ResourceFilesStore } from './Resource.Files'

describe('ResourceFilesStore — o depósito e as pastas dos arquivos de recurso', () => {
  const data = mkdtempSync(join(tmpdir(), 'gw-files-'))
  const env = { CONVERSATIONS_DB: join(data, 'gateway.db') }
  const store = new ResourceFilesStore(env)
  after(() => rmSync(data, { recursive: true, force: true }))

  it('o depósito por sha256: o mesmo conteúdo uma vez, lido de volta', () => {
    const first = store.put(Buffer.from('echo oi\n'))
    assert.deepStrictEqual(store.put(Buffer.from('echo oi\n')), first)
    assert.strictEqual(first.bytes, 8)
    assert.ok(store.has(first.sha256))
    assert.strictEqual(store.read(first.sha256)!.toString(), 'echo oi\n')
    assert.strictEqual(store.has('0'.repeat(64)), false)
  })

  it('a pasta: escrita da lista (o "#!" roda), trocada inteira, e apagada com a lista vazia', () => {
    const script = store.put(Buffer.from('#!/bin/sh\necho oi\n'))
    const data_ = store.put(Buffer.from('{"a":1}'))
    store.sync('skill', 'deploy', undefined, [
      { path: 'scripts/run.sh', ...script },
      { path: 'dados.json', ...data_ },
    ])
    const dir = store.dirOf('skill', 'deploy')
    assert.strictEqual(dir, join(data, 'global', 'skills', 'deploy'))
    assert.strictEqual(readFileSync(join(dir, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho oi\n')
    assert.strictEqual(statSync(join(dir, 'scripts', 'run.sh')).mode & 0o777, 0o755)
    assert.strictEqual(statSync(join(dir, 'dados.json')).mode & 0o777, 0o644)
    // Trocada inteira: o que saiu da lista sai da pasta.
    store.sync('skill', 'deploy', undefined, [{ path: 'dados.json', ...data_ }])
    assert.strictEqual(existsSync(join(dir, 'scripts')), false)
    store.sync('skill', 'deploy', undefined, [])
    assert.strictEqual(existsSync(dir), false)
  })

  it('⛔ conteúdo que não está no depósito: recusa, e a pasta de antes fica', () => {
    const kept = store.put(Buffer.from('fica'))
    store.sync('agent', 'maya', 'alfa', [{ path: 'a.txt', ...kept }])
    const dir = store.dirOf('agent', 'maya', 'alfa')
    assert.strictEqual(dir, join(data, 'projects', 'alfa', 'agents', 'maya'))
    assert.throws(() => store.sync('agent', 'maya', 'alfa', [{ path: 'b.txt', sha256: 'f'.repeat(64), bytes: 1 }]), /content not found/)
    assert.strictEqual(readFileSync(join(dir, 'a.txt'), 'utf8'), 'fica')
  })

  it('as pastas só leitura de quem trabalha numa raiz, e o que é arquivo de recurso', () => {
    assert.deepStrictEqual(readOnlyResourceDirs(join(data, 'projects', 'alfa', 'repositories', 'app'), env), [
      join(data, 'global'),
      join(data, 'projects', 'alfa', 'skills'),
      join(data, 'projects', 'alfa', 'commands'),
      join(data, 'projects', 'alfa', 'agents'),
    ])
    assert.deepStrictEqual(readOnlyResourceDirs('/tmp/conversa', env), [join(data, 'global')])
    assert.strictEqual(isResourceFilePath(join(data, 'global', 'skills', 'x', 'a.sh'), env), true)
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'agents', 'maya', 'a.txt'), env), true)
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'notas', 'a.md'), env), false)
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'repositories', 'app', 'skills', 'x'), env), false)
  })
})
