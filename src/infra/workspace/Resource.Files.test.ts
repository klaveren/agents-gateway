import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { agentFolderOwner, agentFolders, isResourceFilePath, readOnlyResourceDirs, ResourceFilesStore } from './Resource.Files'

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

  it('as pastas só leitura de quem trabalha numa raiz (sem as de agente), e o que é arquivo de recurso', () => {
    assert.deepStrictEqual(readOnlyResourceDirs(join(data, 'projects', 'alfa', 'repositories', 'app'), env), [
      join(data, 'global', 'skills'),
      join(data, 'global', 'commands'),
      join(data, 'projects', 'alfa', 'skills'),
      join(data, 'projects', 'alfa', 'commands'),
    ])
    assert.deepStrictEqual(readOnlyResourceDirs('/tmp/conversa', env), [join(data, 'global', 'skills'), join(data, 'global', 'commands')])
    assert.strictEqual(isResourceFilePath(join(data, 'global', 'skills', 'x', 'a.sh'), env), true)
    // A pasta de um agente não é "só leitura de recurso": é dele (`agentFolderOwner`).
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'agents', 'maya', 'a.txt'), env), false)
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'notas', 'a.md'), env), false)
    assert.strictEqual(isResourceFilePath(join(data, 'projects', 'alfa', 'repositories', 'app', 'skills', 'x'), env), false)
  })

  it('⛔ a pasta privada: o dono de cada caminho, e as dos OUTROS que uma raiz alcançaria', () => {
    assert.deepStrictEqual(agentFolderOwner(join(data, 'global', 'agents', 'atlas', 'notas.md'), env), { agentId: 'atlas', dir: join(data, 'global', 'agents', 'atlas') })
    assert.deepStrictEqual(agentFolderOwner(join(data, 'projects', 'alfa', 'agents', 'maya'), env), { agentId: 'maya', dir: join(data, 'projects', 'alfa', 'agents', 'maya') })
    assert.strictEqual(agentFolderOwner(join(data, 'global', 'skills', 'x'), env), undefined)
    assert.strictEqual(agentFolderOwner(join(data, 'projects', 'alfa', 'repositories', 'app', 'agents', 'x'), env), undefined)
    for (const dir of [
      join(data, 'global', 'agents', 'atlas'),
      join(data, 'global', 'agents', 'zeus'),
      join(data, 'projects', 'alfa', 'agents', 'maya'),
      join(data, 'projects', 'beta', 'agents', 'leo'),
    ])
      mkdirSync(dir, { recursive: true })
    const root = join(data, 'projects', 'alfa', 'repositories', 'app')
    assert.deepStrictEqual(agentFolders(root, join(data, 'projects', 'alfa', 'agents', 'maya'), env).others.sort(), [
      join(data, 'global', 'agents', 'atlas'),
      join(data, 'global', 'agents', 'zeus'),
    ])
    // Sem agente: todas as que a raiz alcançaria; as de outro projeto já estão fora.
    assert.deepStrictEqual(agentFolders(root, undefined, env).others.length, 3)
  })

  it('⚖️ a pasta do agente é dele: a gravação mexe só no que a lista mudou e no que foi tirado; o boot só repõe', () => {
    const a = store.put(Buffer.from('#!/bin/sh\necho a\n'))
    const b = store.put(Buffer.from('b'))
    store.writeAgent('iris', undefined, [{ path: 'scripts/a.sh', ...a }], [])
    const dir = store.dirOf('agent', 'iris')
    assert.strictEqual(statSync(join(dir, 'scripts', 'a.sh')).mode & 0o777, 0o755)
    // O agente grava uma nota e muda o próprio script.
    writeFileSync(join(dir, 'notas.md'), 'minha')
    writeFileSync(join(dir, 'scripts', 'a.sh'), 'mudei')
    // A tela põe um arquivo novo: o script mudado e a nota ficam.
    store.writeAgent(
      'iris',
      undefined,
      [
        { path: 'scripts/a.sh', ...a },
        { path: 'b.txt', ...b },
      ],
      [],
    )
    assert.strictEqual(readFileSync(join(dir, 'notas.md'), 'utf8'), 'minha')
    assert.strictEqual(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b')
    // A lista diz o conteúdo: o que difere do disco é regravado.
    assert.strictEqual(readFileSync(join(dir, 'scripts', 'a.sh'), 'utf8'), '#!/bin/sh\necho a\n')
    // Tirar: só o caminho pedido, e a pasta que ficou vazia.
    store.writeAgent('iris', undefined, [{ path: 'b.txt', ...b }], ['scripts/a.sh'])
    assert.strictEqual(existsSync(join(dir, 'scripts')), false)
    assert.strictEqual(existsSync(join(dir, 'notas.md')), true)
    // O retrato: o disco, com o conteúdo no depósito (binário e o que a lista não aceita ficam fora).
    writeFileSync(join(dir, 'dado.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(dir, 'com espaço.txt'), 'x')
    const live = store.snapshotAgent('iris', undefined)
    assert.deepStrictEqual(
      live.map((file) => file.path),
      ['b.txt', 'notas.md'],
    )
    assert.strictEqual(store.read(live[1]!.sha256)!.toString(), 'minha')
    // O boot: repõe o que sumiu, não apaga nem sobrescreve.
    rmSync(join(dir, 'b.txt'))
    writeFileSync(join(dir, 'notas.md'), 'de novo')
    store.restoreAgent('iris', undefined, [{ path: 'b.txt', ...b }])
    assert.strictEqual(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b')
    assert.strictEqual(readFileSync(join(dir, 'notas.md'), 'utf8'), 'de novo')
    // Mudar de projeto leva tudo.
    store.moveAgent('iris', undefined, 'alfa')
    assert.strictEqual(readFileSync(join(store.dirOf('agent', 'iris', 'alfa'), 'notas.md'), 'utf8'), 'de novo')
    assert.strictEqual(existsSync(dir), false)
  })
})
