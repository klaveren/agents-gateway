import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathspecs, replaceInRepository, searchRepository } from './Repository.Search'
import { IWorkFolder } from './Work.Folder'

describe('Repository.Search — buscar e substituir nos arquivos', () => {
  let root: string
  let folder: IWorkFolder
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-search-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'src', 'a.ts'), 'const MONGO_URI = "x"\nconst mongo = 1\n')
    writeFileSync(join(root, 'docs', 'b.md'), 'use MONGO_URI here\n')
    writeFileSync(join(root, '.env'), 'MONGO_URI=segredo\n')
    folder = { dir: root, gitCommonDir: join(root, '.git') }
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('acha com e sem maiúsculas, palavra inteira e regex; nunca no segredo', async () => {
    const all = await searchRepository(folder, { query: 'mongo' })
    assert.deepEqual(all.files.map((file) => file.path).sort(), ['docs/b.md', 'src/a.ts'])
    assert.equal(all.total, 3)
    const exact = await searchRepository(folder, { query: 'mongo', caseSensitive: true })
    assert.equal(exact.total, 1)
    // Palavra inteira: `mongo` (sozinho) sim; `MONGO` dentro de `MONGO_URI`, não.
    const word = await searchRepository(folder, { query: 'MONGO', wholeWord: true })
    assert.deepEqual(
      word.files.flatMap((file) => file.matches.map((match) => match.text)),
      ['const mongo = 1'],
    )
    const regex = await searchRepository(folder, { query: 'MONGO_\\w+', regex: true, caseSensitive: true })
    assert.equal(regex.total, 2)
    assert.deepEqual(regex.files.find((file) => file.path === 'src/a.ts')?.matches[0], { line: 1, column: 7, text: 'const MONGO_URI = "x"' })
  })

  it('inclui e exclui por glob', async () => {
    assert.deepEqual(
      (await searchRepository(folder, { query: 'MONGO_URI', include: 'src' })).files.map((file) => file.path),
      ['src/a.ts'],
    )
    assert.deepEqual(
      (await searchRepository(folder, { query: 'MONGO_URI', exclude: '*.md' })).files.map((file) => file.path),
      ['src/a.ts'],
    )
    assert.ok(pathspecs('../fora', false).length === 0)
  })

  it('substitui nos arquivos achados (com grupos na regex) e não no segredo', async () => {
    const done = await replaceInRepository(folder, { query: 'MONGO_(URI)', regex: true, caseSensitive: true }, 'DB_$1')
    assert.deepEqual(done, { files: 2, replacements: 2 })
    assert.match(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), /DB_URI/)
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'MONGO_URI=segredo\n')
  })
})
