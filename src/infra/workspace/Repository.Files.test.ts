import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { listRepositoryFiles, parseStatus, readRepositoryFile, RepositoryFileError, writeRepositoryFile } from './Repository.Files'
import { IWorkFolder } from './Work.Folder'

describe('Repository.Files — o editor de arquivos da conversa', () => {
  let root: string
  let folder: IWorkFolder

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-files-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dist'))
    mkdirSync(join(root, '.credentials'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'dist', 'out.js'), 'x')
    writeFileSync(join(root, '.env'), 'SECRET=1')
    writeFileSync(join(root, '.env.example'), 'SECRET=')
    writeFileSync(join(root, '.credentials', 'k.env'), 'K=1')
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
    folder = { dir: root, gitCommonDir: join(root, '.git') }
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('lista pelo .gitignore e sem segredo', async () => {
    const { files } = await listRepositoryFiles(folder)
    assert.ok(files.includes('src/a.ts'))
    assert.ok(files.includes('.env.example'))
    assert.ok(!files.includes('.env'))
    assert.ok(!files.some((path) => path.startsWith('dist/') || path.startsWith('.credentials/')))
  })

  it('marca o que não foi commitado', async () => {
    const { status } = await listRepositoryFiles(folder)
    assert.equal(status['src/a.ts'], 'U')
    assert.equal(status['.env'], undefined)
  })

  it('lê o porcelain: modificado, adicionado, novo, renomeado', () => {
    assert.deepEqual(parseStatus(' M a.ts\0A  b.ts\0?? c.ts\0R  novo.ts\0velho.ts\0 D d.ts\0'), { 'a.ts': 'M', 'b.ts': 'A', 'c.ts': 'U', 'novo.ts': 'R', 'd.ts': 'D' })
  })

  it('lê texto e avisa binário', () => {
    assert.equal(readRepositoryFile(folder, 'src/a.ts').content, 'export const a = 1\n')
    assert.equal(readRepositoryFile(folder, 'bin.dat').binary, true)
  })

  it('recusa segredo, .git, fora da pasta e link para fora', () => {
    const kind = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof RepositoryFileError ? error.kind : 'other'
      }
      return 'ok'
    }
    assert.equal(
      kind(() => readRepositoryFile(folder, '.env')),
      'not_found',
    )
    assert.equal(
      kind(() => readRepositoryFile(folder, '.credentials/k.env')),
      'not_found',
    )
    assert.equal(
      kind(() => readRepositoryFile(folder, '.git/config')),
      'not_found',
    )
    assert.equal(
      kind(() => readRepositoryFile(folder, '../x')),
      'invalid',
    )
    assert.equal(
      kind(() => readRepositoryFile(folder, '/etc/hosts')),
      'invalid',
    )
    const outside = mkdtempSync(join(tmpdir(), 'gw-out-'))
    writeFileSync(join(outside, 'x.txt'), 'fora')
    symlinkSync(outside, join(root, 'link'))
    assert.equal(
      kind(() => readRepositoryFile(folder, 'link/x.txt')),
      'not_found',
    )
    assert.equal(
      kind(() => writeRepositoryFile(folder, 'link/y.txt', 'y')),
      'not_found',
    )
    rmSync(outside, { recursive: true, force: true })
  })

  it('grava com o hash aberto e recusa se o arquivo mudou', () => {
    const opened = readRepositoryFile(folder, 'src/a.ts')
    const saved = writeRepositoryFile(folder, 'src/a.ts', 'export const a = 2\n', opened.hash)
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 2\n')
    assert.throws(
      () => writeRepositoryFile(folder, 'src/a.ts', 'velho', opened.hash),
      (error: unknown) => error instanceof RepositoryFileError && error.kind === 'conflict' && error.current?.hash === saved.hash,
    )
    assert.equal(writeRepositoryFile(folder, 'src/novo.ts', 'n').path, 'src/novo.ts')
    assert.throws(() => writeRepositoryFile(folder, '.env', 'X=1'), RepositoryFileError)
  })
})
