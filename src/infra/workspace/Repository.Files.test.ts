import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  copyRepositoryFile,
  deleteRepositoryFile,
  listFolder,
  listRepositoryFiles,
  parseStatus,
  readRepositoryFile,
  renameRepositoryFile,
  RepositoryFileError,
  writeRepositoryFile,
} from './Repository.Files'
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

  it('lista tudo como está: o ignorado à parte (pasta fechada) e o segredo pelo nome', async () => {
    const { files, ignored, secrets } = await listRepositoryFiles(folder)
    assert.ok(files.includes('src/a.ts'))
    assert.ok(files.includes('.env.example'))
    assert.ok(ignored.includes('dist/'))
    assert.ok(!files.some((path) => path.startsWith('dist/') || path.startsWith('.git/')))
    assert.deepEqual(secrets.sort(), ['.credentials/k.env', '.env'])
    assert.deepEqual(listFolder(folder, 'dist').entries, [{ path: 'dist/out.js', folder: false }])
  })

  it('marca o que não foi commitado', async () => {
    const { status } = await listRepositoryFiles(folder)
    assert.equal(status['src/a.ts'], 'U')
    assert.equal(status['.env'], 'U')
  })

  it('o versionado que sumiu da pasta sai da lista (pelo `git ls-files --deleted`)', async () => {
    writeFileSync(join(root, 'src', 'gone.ts'), 'x\n')
    execFileSync('git', ['add', 'src/gone.ts'], { cwd: root })
    rmSync(join(root, 'src', 'gone.ts'))
    const { files } = await listRepositoryFiles(folder)
    assert.ok(!files.includes('src/gone.ts'))
    assert.ok(files.includes('src/a.ts'))
    execFileSync('git', ['rm', '-q', '--cached', 'src/gone.ts'], { cwd: root })
  })

  it('lê o porcelain: modificado, adicionado, novo, renomeado', () => {
    assert.deepEqual(parseStatus(' M a.ts\0A  b.ts\0?? c.ts\0R  novo.ts\0velho.ts\0 D d.ts\0'), { 'a.ts': 'M', 'b.ts': 'A', 'c.ts': 'U', 'novo.ts': 'R', 'd.ts': 'D' })
  })

  it('o admin do projeto abre o segredo; os demais, não', () => {
    assert.equal(readRepositoryFile(folder, '.env', { secrets: true }).content, 'SECRET=1')
    assert.throws(
      () => readRepositoryFile(folder, '.env'),
      (error: unknown) => error instanceof RepositoryFileError && error.kind === 'forbidden',
    )
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
      'forbidden',
    )
    assert.equal(
      kind(() => readRepositoryFile(folder, '.credentials/k.env')),
      'forbidden',
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

  it('renomeia e apaga só arquivo, dentro da pasta, sem segredo e sem sobrescrever', () => {
    writeFileSync(join(root, 'src', 'r.ts'), 'r')
    assert.deepEqual(renameRepositoryFile(folder, 'src/r.ts', 'src/s.ts'), { from: 'src/r.ts', to: 'src/s.ts' })
    assert.equal(readFileSync(join(root, 'src', 's.ts'), 'utf8'), 'r')
    assert.throws(
      () => renameRepositoryFile(folder, 'src/s.ts', 'src/a.ts'),
      (error: unknown) => error instanceof RepositoryFileError && error.kind === 'conflict',
    )
    assert.throws(() => renameRepositoryFile(folder, 'src/s.ts', '.env.local'), RepositoryFileError)
    assert.throws(() => renameRepositoryFile(folder, 'src/s.ts', '../fora.ts'), RepositoryFileError)
    assert.throws(() => renameRepositoryFile(folder, 'src/s.ts', 'nao/existe/s.ts'), RepositoryFileError)
    assert.throws(() => deleteRepositoryFile(folder, '.env'), RepositoryFileError)
    assert.deepEqual(deleteRepositoryFile(folder, 'src/s.ts'), { path: 'src/s.ts' })
  })

  it('pastas: copia, move e apaga; nunca a que tem segredo, nem para dentro dela mesma', () => {
    mkdirSync(join(root, 'lib', 'sub'), { recursive: true })
    writeFileSync(join(root, 'lib', 'sub', 'x.ts'), 'x')
    assert.deepEqual(copyRepositoryFile(folder, 'lib', 'lib2'), { from: 'lib', to: 'lib2' })
    assert.equal(readFileSync(join(root, 'lib2', 'sub', 'x.ts'), 'utf8'), 'x')
    assert.throws(() => renameRepositoryFile(folder, 'lib', 'lib/sub/lib'), RepositoryFileError)
    assert.deepEqual(renameRepositoryFile(folder, 'lib2', 'src/lib2'), { from: 'lib2', to: 'src/lib2' })
    assert.deepEqual(deleteRepositoryFile(folder, 'src/lib2'), { path: 'src/lib2' })
    // A pasta das credenciais não se move nem se apaga pela tela.
    assert.throws(() => renameRepositoryFile(folder, '.credentials', 'creds'), RepositoryFileError)
    mkdirSync(join(root, 'cfg'))
    writeFileSync(join(root, 'cfg', '.env'), 'S=1')
    assert.throws(
      () => deleteRepositoryFile(folder, 'cfg'),
      (error: unknown) => error instanceof RepositoryFileError && /secret/.test(error.message),
    )
    assert.throws(() => copyRepositoryFile(folder, 'cfg', 'cfg2'), RepositoryFileError)
  })
})
