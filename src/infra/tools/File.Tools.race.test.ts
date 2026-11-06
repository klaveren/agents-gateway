import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileTools } from './File.Tools'

describe('File.Tools — corrida entre a checagem e a abertura (C2)', () => {
  let base: string
  let root: string
  let secret: string
  let swapper: ChildProcess | undefined

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'file-tools-race-'))
    root = join(base, 'root')
    mkdirSync(root)
    secret = join(base, 'segredo.txt')
    writeFileSync(secret, 'SEGREDO-MESTRE')
    writeFileSync(join(root, 'ok.txt'), 'comum')
  })
  after(() => {
    swapper?.kill()
    rmSync(base, { recursive: true, force: true })
  })

  const call = (name: string, args: Record<string, unknown>) =>
    makeFileTools({ rootFor: () => root })
      .find((tool) => tool.name === name)!
      .execute(args)

  /** Um processo à parte alterna `s.txt` entre arquivo comum e symlink para `target` (rename atômico), como o bash_start do agente. */
  const startSwapper = (target: string) => {
    const code = `
      const fs = require('fs'), path = require('path')
      const s = path.join(${JSON.stringify(root)}, 's.txt'), tmp = s + '.t'
      let i = 0
      setInterval(() => { for (let n = 0; n < 200; n++) {
        try { if (i++ % 2) fs.symlinkSync(${JSON.stringify(target)}, tmp); else fs.writeFileSync(tmp, 'comum'); fs.renameSync(tmp, s) } catch {}
      } }, 0)`
    swapper = spawn(process.execPath, ['-e', code], { stdio: 'ignore' })
  }
  const stopSwapper = () => {
    swapper?.kill()
    swapper = undefined
  }

  it('⛔ read_file e search_files em laço contra o alterna-symlink nunca devolvem o segredo', async () => {
    startSwapper(secret)
    try {
      for (let n = 0; n < 1500; n++) {
        const out = await call('read_file', { path: 's.txt' })
        assert.ok(!String(out.result).includes('SEGREDO-MESTRE'), 'vazou o conteúdo de fora da raiz')
        const found = await call('search_files', { pattern: 'SEGREDO' })
        assert.ok(!String(found.result).includes('SEGREDO-MESTRE'), 'a busca vazou o conteúdo de fora da raiz')
      }
    } finally {
      stopSwapper()
    }
  })

  it('⛔ write_file / edit_file em laço contra o alterna-symlink nunca gravam fora da raiz', async () => {
    startSwapper(secret)
    try {
      for (let n = 0; n < 1500; n++) {
        await call('write_file', { path: 's.txt', content: 'PWNED' })
        await call('edit_file', { path: 's.txt', old_string: 'comum', new_string: 'PWNED' })
        assert.equal(readFileSync(secret, 'utf8'), 'SEGREDO-MESTRE', 'gravou fora da raiz')
      }
    } finally {
      stopSwapper()
    }
  })

  it('⛔ um symlink fixo (para fora) nunca é aberto pelas ferramentas', async () => {
    symlinkSync(secret, join(root, 'fixo.txt'))
    for (const out of [await call('read_file', { path: 'fixo.txt' }), await call('write_file', { path: 'fixo.txt', content: 'PWNED' })])
      assert.ok(!String(out.result).includes('SEGREDO-MESTRE'))
    assert.equal(readFileSync(secret, 'utf8'), 'SEGREDO-MESTRE')
  })

  it('write_file mantém o modo do arquivo', async () => {
    writeFileSync(join(root, 'modo.sh'), 'a', { mode: 0o755 })
    assert.equal((await call('write_file', { path: 'modo.sh', content: 'b' })).status, 'success')
    assert.equal(readFileSync(join(root, 'modo.sh'), 'utf8'), 'b')
    assert.equal(statSync(join(root, 'modo.sh')).mode & 0o777, 0o755)
  })
})
