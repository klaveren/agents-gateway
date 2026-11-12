import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { discoveredGitSync, safeGit, safeGitSync } from './Git.Safe'

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Ana',
  GIT_AUTHOR_EMAIL: 'a@a',
  GIT_COMMITTER_NAME: 'Ana',
  GIT_COMMITTER_EMAIL: 'a@a',
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })

describe('Git.Safe — ⛔ o repositório aninhado (submódulo) é do agente: o git do servidor não entra nele', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gw-git-safe-')))
  const repo = join(base, 'repo')
  const sub = join(repo, 'sub')
  const mark = join(base, 'filtro-rodou')
  const place = { dir: repo, gitCommonDir: join(repo, '.git') }

  before(() => {
    mkdirSync(sub, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'um\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-q', '-m', 'base')
    // O aninhado: quem o cria, e escreve a config dele, é o agente (de dentro do cerco). No índice de fora, um gitlink.
    git(sub, 'init', '-q', '-b', 'main')
    writeFileSync(join(sub, 'f.txt'), 'one\n')
    git(sub, 'add', 'f.txt')
    git(sub, 'commit', '-q', '-m', 'sub')
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(sub, 'rev-parse', 'HEAD').trim()},sub`)
    git(sub, 'config', 'filter.x.clean', `sh -c 'touch ${mark}; cat'`)
    mkdirSync(join(sub, '.git', 'info'), { recursive: true })
    writeFileSync(join(sub, '.git', 'info', 'attributes'), '* filter=x\n')
    // Mesmo tamanho, outra data: o git só sabe se mudou LENDO o conteúdo, e é aí que o filtro `clean` roda.
    writeFileSync(join(sub, 'f.txt'), 'two\n')
    utimesSync(join(sub, 'f.txt'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  })
  // Cada teste parte sem a marca: o que um deixou não reprova (nem aprova) o seguinte.
  beforeEach(() => rmSync(mark, { force: true }))
  after(() => rmSync(base, { recursive: true, force: true }))

  it('o diff e o status não abrem o aninhado (o filtro da config dele não roda); a troca de commit dele continua à vista', async () => {
    assert.match(await safeGit(place, ['diff', '--name-status', 'HEAD']), /^A\tsub$/m)
    await safeGit(place, ['diff', '--numstat', 'HEAD'])
    assert.match(await safeGit(place, ['diff', '-U3', 'HEAD', '--', 'sub']), /^\+Subproject commit [0-9a-f]{40}$/m)
    assert.match(safeGitSync(place, ['--no-optional-locks', 'status', '--porcelain']) ?? '', /^A {2}sub$/m)
    assert.ok(!existsSync(mark), 'o filtro do repositório aninhado rodou no servidor')
  })

  it('⛔ o `.gitmodules` (que o agente escreve) não religa a leitura de dentro: `ignore = none` perde para a linha de comando', async () => {
    writeFileSync(join(repo, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n')
    await safeGit(place, ['diff', '--name-status', 'HEAD'])
    await safeGit(place, ['diff', '--numstat', 'HEAD'])
    safeGitSync(place, ['--no-optional-locks', 'status', '--porcelain'])
    assert.ok(!existsSync(mark), 'o filtro do repositório aninhado rodou no servidor')
  })

  it('⛔ `diff.submodule=diff` na config: o diff não pede o diff de dentro do aninhado', async () => {
    git(repo, 'config', 'diff.submodule', 'diff')
    const out = await safeGit(place, ['diff', '-U3', 'HEAD', '--', 'sub'])
    assert.doesNotMatch(out, /^Submodule sub/m)
    assert.match(out, /^\+Subproject commit [0-9a-f]{40}$/m)
    assert.ok(!existsSync(mark), 'o filtro do repositório aninhado rodou no servidor')
  })

  it('⚖️ o que mudou no próprio repositório continua a aparecer, e os outros subcomandos seguem como eram', async () => {
    writeFileSync(join(repo, 'a.txt'), 'um\ndois\n')
    assert.match(await safeGit(place, ['diff', '--name-status', 'HEAD']), /^M\ta\.txt$/m)
    assert.match(await safeGit(place, ['diff', '--numstat', 'HEAD']), /^1\t0\ta\.txt$/m)
    assert.match(safeGitSync(place, ['status', '--porcelain']) ?? '', /^ M a\.txt$/m)
    assert.match((await safeGit(place, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim(), /^[0-9a-f]{40}$/)
    assert.match(await safeGit(place, ['-c', 'core.quotePath=false', 'log', '--format=%s', '-n', '1']), /^base$/m)
    assert.strictEqual(safeGitSync(place, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim(), 'main')
  })
})

describe('Git.Safe — ⛔ o git que descobre o repositório pela pasta (o `.git` dela pode ser do agente)', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gw-git-achado-')))
  const dir = join(base, 'pasta')
  const mark = join(base, 'fsmonitor-rodou')
  after(() => rmSync(base, { recursive: true, force: true }))

  it('o `core.fsmonitor` plantado na config não roda; a resposta do git vem igual', () => {
    mkdirSync(dir)
    const hook = join(base, 'fsmonitor.sh')
    writeFileSync(hook, `#!/bin/sh\ntouch '${mark}'\nprintf 'x\\0'\n`, { mode: 0o755 })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, '.gitconfig'), '')
    git(dir, 'add', '.gitconfig')
    git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'config', 'core.fsmonitor', hook)
    git(dir, 'update-index', '--fsmonitor')
    rmSync(mark, { force: true })
    assert.strictEqual(discoveredGitSync(dir, ['ls-files', '-z', '--', '.gitconfig', 'nao-rastreado']), '.gitconfig\0')
    assert.strictEqual(discoveredGitSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim(), 'main')
    assert.ok(!existsSync(mark), 'o programa da config do repositório rodou no servidor')
  })

  it('fora de repositório (ou com o git falhando), `undefined`', () => {
    const fora = join(base, 'sem-git')
    mkdirSync(fora)
    // ⚖️ A descoberta sobe pelas pastas: o teto garante que um repositório acima da pasta temporária não responde.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = base
    try {
      assert.strictEqual(discoveredGitSync(fora, ['rev-parse', '--abbrev-ref', 'HEAD']), undefined)
      assert.strictEqual(discoveredGitSync(join(base, 'nao-existe'), ['ls-files', '-z']), undefined)
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = ceiling
    }
  })
})

describe('Git.Safe — ⛔ o git do servidor só lê: não busca objeto que falta nem confere assinatura', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gw-git-rede-')))
  const mark = join(base, 'programa-rodou')
  beforeEach(() => rmSync(mark, { force: true }))
  after(() => rmSync(base, { recursive: true, force: true }))

  /** Um repositório "clone parcial" a que falta o conteúdo do `a.txt` de HEAD: o diff, para comparar, iria buscá-lo. */
  const partial = (name: string) => {
    const repo = join(base, name)
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-q', '-m', 'base')
    writeFileSync(join(repo, 'a.txt'), 'two\nthree\n')
    const blob = git(repo, 'rev-parse', 'HEAD:a.txt').trim()
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true })
    git(repo, 'config', 'core.repositoryformatversion', '1')
    git(repo, 'config', 'extensions.partialClone', 'origin')
    git(repo, 'config', 'remote.origin.promisor', 'true')
    git(repo, 'config', 'remote.origin.partialclonefilter', 'blob:none')
    // O agente também escreve a liberação do protocolo: ela não pode valer.
    git(repo, 'config', 'protocol.allow', 'always')
    return { repo, place: { dir: repo, gitCommonDir: join(repo, '.git') } }
  }
  const diffs = async (place: { dir: string; gitCommonDir: string }) => {
    for (const args of [
      ['diff', '--numstat', 'HEAD'],
      ['diff', '--name-status', 'HEAD'],
      ['diff', '-U3', 'HEAD', '--', 'a.txt'],
    ])
      await safeGit(place, args).catch(() => undefined)
    safeGitSync(place, ['--no-optional-locks', 'status', '--porcelain'])
  }

  it('⛔ o `remote.<nome>.uploadpack` do remoto "promisor" não roda', async () => {
    const { repo, place } = partial('uploadpack')
    git(repo, 'config', 'remote.origin.url', join(base, 'nao-existe'))
    git(repo, 'config', 'remote.origin.uploadpack', `touch '${mark}';`)
    git(repo, 'config', 'protocol.file.allow', 'always')
    await diffs(place)
    assert.ok(!existsSync(mark), 'o programa da config do repositório rodou no servidor')
  })

  it('⛔ o ajudante de transporte de nome inventado (um alias `remote-<nome>` da config) não roda, mesmo com o protocolo liberado na config', async () => {
    const { repo, place } = partial('ajudante')
    git(repo, 'config', 'remote.origin.url', 'foo::bar')
    git(repo, 'config', 'protocol.foo.allow', 'always')
    git(repo, 'config', 'alias.remote-foo', `!touch '${mark}'`)
    await diffs(place)
    assert.ok(!existsSync(mark), 'o programa da config do repositório rodou no servidor')
  })

  it('⛔ `log.showSignature` + `gpg.program` na config: o log não roda o programa a cada commit assinado', async () => {
    const repo = join(base, 'assinado')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-q', '-m', 'base')
    // O mesmo commit com um cabeçalho `gpgsig`: para o git, um commit assinado.
    const [header, ...message] = git(repo, 'cat-file', 'commit', 'HEAD').split('\n\n')
    const signed = `${header}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\n${message.join('\n\n')}`
    const id = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { encoding: 'utf8', input: signed, env }).trim()
    git(repo, 'update-ref', 'refs/heads/main', id)
    const program = join(base, 'gpg.sh')
    writeFileSync(program, `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, { mode: 0o755 })
    git(repo, 'config', 'log.showSignature', 'true')
    git(repo, 'config', 'gpg.program', program)
    assert.match(await safeGit({ dir: repo, gitCommonDir: join(repo, '.git') }, ['log', '--no-color', '--format=%s', '-n', '5', 'HEAD']), /^base$/m)
    assert.ok(!existsSync(mark), 'o programa da config do repositório rodou no servidor')
  })
})
