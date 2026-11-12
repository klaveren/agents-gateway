import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { parseJsonc } from './Opencode.Detector'
import { repositoryExclusion } from '@domain/Import.Ignore'
import { listRepoFiles, readRepoBytes, readRepoFile, readRepoText, readRepoTree, REPO_FILE_MAX_BYTES, REPO_TEXT_MAX_BYTES } from './Repo.Tree'

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

  it('⛔ arquivo acima do teto não vai para a memória; o que virou link depois da varredura não é seguido', () => {
    const root = join(base, 'grande')
    mkdirSync(root)
    writeFileSync(join(root, 'ok.md'), 'ok')
    writeFileSync(join(root, 'enorme.md'), 'x')
    truncateSync(join(root, 'enorme.md'), REPO_FILE_MAX_BYTES + 1)
    writeFileSync(join(root, 'troca.md'), 'antes')
    writeFileSync(join(base, 'segredo-de-fora.txt'), 'de fora')
    const tree = readRepoTree(root, { mask: (text) => text })
    assert.strictEqual(tree.read('ok.md')?.text, 'ok')
    assert.strictEqual(tree.read('enorme.md'), undefined)
    assert.strictEqual(readRepoBytes(root, 'enorme.md'), undefined)
    assert.strictEqual(readRepoFile(root, 'enorme.md', { mask: (text) => text }), undefined)
    // Depois da varredura, o arquivo vira link para fora: a leitura não o segue.
    unlinkSync(join(root, 'troca.md'))
    symlinkSync(join(base, 'segredo-de-fora.txt'), join(root, 'troca.md'))
    assert.strictEqual(tree.read('troca.md'), undefined)
    assert.strictEqual(readRepoBytes(root, 'troca.md'), undefined)
  })

  it('o texto sai mascarado e marcado; o cru nunca', () => {
    const root = join(base, 's')
    mkdirSync(root)
    writeFileSync(join(root, 'env.md'), 'TOKEN=cru')
    const file = readRepoTree(root, { mask: (text) => text.replace('cru', '[segredo]') }).read('env.md')
    assert.deepStrictEqual([file?.text, file?.secret, file?.tokens], ['TOKEN=[segredo]', true, 3])
  })

  it('⛔ um arquivo só (readRepoFile): contido, mascarado, com o sha256 do cru; fora, por link ou por pasta ignorada, não existe', () => {
    const root = join(base, 'f')
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules/p'), { recursive: true })
    writeFileSync(join(root, 'docs/env.md'), 'TOKEN=cru')
    writeFileSync(join(root, 'node_modules/p/x.md'), 'x')
    writeFileSync(join(base, 'fora-f.md'), 'de fora')
    symlinkSync(join(base, 'fora-f.md'), join(root, 'docs/link-fora.md'))
    symlinkSync('env.md', join(root, 'docs/link-dentro.md'))
    const mask = { mask: (text: string) => text.replace('cru', '[segredo]') }
    const file = readRepoFile(root, 'docs/env.md', mask)
    assert.deepStrictEqual(file, { sha256: createHash('sha256').update('TOKEN=cru').digest('hex'), text: 'TOKEN=[segredo]', binary: false })
    assert.strictEqual(readRepoFile(root, './docs/link-dentro.md', mask)?.text, 'TOKEN=[segredo]')
    for (const path of ['../fora-f.md', 'docs/../../fora-f.md', 'docs/link-fora.md', join(base, 'fora-f.md'), 'node_modules/p/x.md', 'docs', 'nao-existe.md'])
      assert.strictEqual(readRepoFile(root, path, mask), undefined, path)
  })

  it('⛔ a navegação do construtor (listRepoFiles/readRepoText): contida, sem os excluídos, mascarada', () => {
    const root = join(base, 'nav')
    for (const dir of ['docs/sub', '.credentials', '.git', 'node_modules/p', 'cfg']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'docs/a.md'), 'TOKEN=cru')
    writeFileSync(join(root, 'docs/sub/b.md'), 'b')
    writeFileSync(join(root, 'docs/bin.dat'), Buffer.from([1, 0, 2]))
    writeFileSync(join(root, 'docs/grande.md'), 'x'.repeat(REPO_TEXT_MAX_BYTES + 1))
    writeFileSync(join(root, '.credentials/key.json'), '{}')
    writeFileSync(join(root, '.git/config'), '[core]')
    writeFileSync(join(root, '.env'), 'A=1')
    writeFileSync(join(root, 'cfg/.env.local'), 'B=2')
    writeFileSync(join(root, 'node_modules/p/x.md'), 'x')
    writeFileSync(join(base, 'nav-fora.md'), 'de fora')
    symlinkSync(join(base, 'nav-fora.md'), join(root, 'docs/link-fora.md'))
    symlinkSync('../.env', join(root, 'docs/env-link.md'))
    symlinkSync('docs', join(root, 'atalho'))
    const exclude = repositoryExclusion([])
    const listed = listRepoFiles(root, undefined, exclude)
    assert.ok(Array.isArray(listed))
    assert.deepStrictEqual(
      listed.map((entry) => entry.path),
      ['docs/a.md', 'docs/bin.dat', 'docs/grande.md', 'docs/sub/b.md'],
    )
    assert.deepStrictEqual(listed[0].aliases, ['atalho/a.md'])
    assert.deepStrictEqual(
      (listRepoFiles(root, 'docs/sub', exclude) as Array<{ path: string }>).map((entry) => entry.path),
      ['docs/sub/b.md'],
    )
    assert.deepStrictEqual(
      ['../', '/etc', '.credentials', '.git', 'node_modules', 'nao-existe', 'docs/a.md'].map((under) => listRepoFiles(root, under, exclude)),
      ['outside', 'outside', 'excluded', 'excluded', 'excluded', 'not_found', 'not_found'],
    )
    const read = { mask: (text: string) => text.replace('cru', '[segredo]'), exclude }
    assert.deepStrictEqual(readRepoText(root, './docs/a.md', read), { path: 'docs/a.md', bytes: 9, text: 'TOKEN=[segredo]' })
    assert.deepStrictEqual(readRepoText(root, 'atalho/a.md', read), { path: 'docs/a.md', bytes: 9, text: 'TOKEN=[segredo]' })
    const refused = {
      '../nav-fora.md': 'outside',
      'docs/../../nav-fora.md': 'outside',
      [join(base, 'nav-fora.md')]: 'outside',
      'docs/link-fora.md': 'outside',
      '.env': 'excluded',
      'cfg/.env.local': 'excluded',
      'docs/env-link.md': 'excluded',
      '.credentials/key.json': 'excluded',
      '.git/config': 'excluded',
      'node_modules/p/x.md': 'excluded',
      'docs/bin.dat': 'binary',
      'docs/grande.md': 'too_large',
      docs: 'not_found',
      '': 'not_found',
      'nao-existe.md': 'not_found',
    }
    for (const [path, reason] of Object.entries(refused)) assert.strictEqual(readRepoText(root, path, read), reason, path)
    // O ignorar do projeto também tira (na lista e na leitura).
    const project = repositoryExclusion(['sub'])
    assert.ok(!(listRepoFiles(root, undefined, project) as Array<{ path: string }>).some((entry) => entry.path.includes('sub/')))
    assert.strictEqual(readRepoText(root, 'docs/sub/b.md', { ...read, exclude: project }), 'excluded')
  })

  it('JSONC: comentário fora de string e vírgula sobrando', () => {
    assert.deepStrictEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] })
  })
})
