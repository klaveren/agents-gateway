import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MANIFEST_PATH } from '@domain/Catalog.Files'
import { readCatalogDirectory, writeCatalogDirectory } from './Catalog.Directory'

describe('Catalog.Directory — o pacote em pasta', () => {
  let base: string
  let dir: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'catalog-dir-'))
    dir = join(base, 'catalogo')
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('escreve o pacote, apaga o que o export anterior tinha e não veio, e lê de volta sem o .git', () => {
    const manifest = (files: string[]) => JSON.stringify({ files: Object.fromEntries(files.map((path) => [path, 'h'])) })
    writeCatalogDirectory(dir, { [MANIFEST_PATH]: manifest(['global/a.md', 'global/b.md']), 'global/a.md': 'a', 'global/b.md': 'b' })
    writeFileSync(join(dir, 'README.md'), 'meu')
    const second = writeCatalogDirectory(dir, { [MANIFEST_PATH]: manifest(['global/a.md']), 'global/a.md': 'a2' })
    assert.deepStrictEqual(second.removed, ['global/b.md'])
    assert.strictEqual(readFileSync(join(dir, 'global/a.md'), 'utf8'), 'a2')
    assert.strictEqual(readFileSync(join(dir, 'README.md'), 'utf8'), 'meu', 'o que não é do pacote fica')
    assert.deepStrictEqual(Object.keys(readCatalogDirectory(dir)).sort(), ['README.md', MANIFEST_PATH, 'global/a.md'].sort())
  })

  it('⛔ caminho fora da pasta, dentro de .git ou por link simbólico: recusa antes de escrever qualquer coisa', () => {
    const outside = join(base, 'fora')
    mkdirSync(outside)
    symlinkSync(outside, join(dir, 'global'))
    writeFileSync(join(outside, 'alvo.txt'), 'intacto')
    symlinkSync(join(outside, 'alvo.txt'), join(dir, 'link.md'))

    for (const path of ['../fora/x.md', '.git/hooks/pre-commit', '.GIT/config', 'projects/p/.git/config', 'global/x.md', 'link.md']) {
      assert.throws(() => writeCatalogDirectory(dir, { 'ok.md': 'ok', [path]: 'payload' }), /catalog: caminho/, path)
    }
    assert.ok(!existsSync(join(dir, 'ok.md')), 'nada foi escrito')
    assert.ok(!existsSync(join(dir, '.git', 'hooks', 'pre-commit')))
    assert.ok(!existsSync(join(outside, 'x.md')))
    assert.strictEqual(readFileSync(join(outside, 'alvo.txt'), 'utf8'), 'intacto')
  })
})
