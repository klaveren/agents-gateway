import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { parseJsonc } from './Opencode.Detector'
import { readRepoTree } from './Repo.Tree'

describe('Repo.Tree — a árvore contida de um repositório', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-repo-tree-'))
  after(() => rmSync(base, { recursive: true, force: true }))

  it('⛔ link em ciclo e link quebrado são recusados; pasta por link vira alias de cada arquivo', () => {
    const root = join(base, 'r')
    mkdirSync(join(root, 'a/b'), { recursive: true })
    writeFileSync(join(root, 'a/b/x.md'), 'x')
    symlinkSync('..', join(root, 'a/b/volta'))
    symlinkSync('nao-existe.md', join(root, 'quebrado.md'))
    symlinkSync('a', join(root, 'atalho'))
    const tree = readRepoTree(root, { mask: (text) => text })
    assert.deepStrictEqual(tree.entries(), [{ path: 'a/b/x.md', aliases: ['atalho/b/x.md'], bytes: 1 }])
    assert.deepStrictEqual(
      tree
        .refusedLinks()
        .map((link) => `${link.path}:${link.reason}`)
        .sort(),
      ['a/b/volta:cycle', 'atalho/b/volta:cycle', 'quebrado.md:broken'],
    )
    assert.strictEqual(tree.resolve('atalho/b/x.md'), 'a/b/x.md')
    assert.strictEqual(tree.read('atalho/b/x.md')?.text, 'x')
    assert.strictEqual(tree.read('../fora.md'), undefined)
  })

  it('o texto sai mascarado e marcado; o cru nunca', () => {
    const root = join(base, 's')
    mkdirSync(root)
    writeFileSync(join(root, 'env.md'), 'TOKEN=cru')
    const file = readRepoTree(root, { mask: (text) => text.replace('cru', '[segredo]') }).read('env.md')
    assert.deepStrictEqual([file?.text, file?.secret, file?.tokens], ['TOKEN=[segredo]', true, 3])
  })

  it('JSONC: comentário fora de string e vírgula sobrando', () => {
    assert.deepStrictEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] })
  })
})
