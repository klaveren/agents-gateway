import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { changesOf, fileDiff, headOf } from './Git.Changes'

const env = { ...process.env, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'a@a' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env })

describe('Git.Changes (o que mudou na pasta da conversa)', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gw-changes-')))
  const canary = join(repo, '..', `canario-${process.pid}`)
  const place = { dir: repo, gitCommonDir: join(repo, '.git') }
  let start = ''
  before(async () => {
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'um\ndois\n')
    writeFileSync(join(repo, 'velho.txt'), 'renomear\n'.repeat(20))
    writeFileSync(join(repo, 'apagar.txt'), 'x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'checkout', '-q', '-b', 'epic-EP-1')
    start = (await headOf(place))!
    // Na conversa: um commit (edita a.txt, renomeia velho.txt) e o que ainda não foi commitado.
    appendFileSync(join(repo, 'a.txt'), 'tres\n')
    git(repo, 'mv', 'velho.txt', 'novo-nome.txt')
    git(repo, 'commit', '-q', '-am', 'edita e renomeia')
    git(repo, 'rm', '-q', 'apagar.txt')
    writeFileSync(join(repo, 'nao-rastreado.txt'), 'novo\nnovo\n')
    writeFileSync(join(repo, '.env'), 'SEGREDO=abc\n')
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]))
    // ⛔ Um diff externo e um fsmonitor maliciosos no .git/config: não podem rodar.
    git(repo, 'config', 'diff.external', `sh -c 'touch ${canary}'`)
    git(repo, 'config', 'core.fsmonitor', `sh -c 'touch ${canary}'`)
  })
  after(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(canary, { force: true })
  })

  it('nesta conversa: o commitado e o não commitado desde o início, com os commits; segredo sem conteúdo', async () => {
    const changes = await changesOf(place, 'conversation', { startCommit: start })
    const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]))
    assert.deepStrictEqual(
      changes.files.map((file) => `${file.status} ${file.path}`),
      ['A .env', 'M a.txt', 'D apagar.txt', 'A img.bin', 'A nao-rastreado.txt', 'R novo-nome.txt'],
    )
    assert.deepStrictEqual([byPath['a.txt'].additions, byPath['a.txt'].deletions], [1, 0])
    assert.strictEqual(byPath['novo-nome.txt'].oldPath, 'velho.txt')
    assert.strictEqual(byPath['nao-rastreado.txt'].additions, 2)
    assert.strictEqual(byPath['.env'].protected, true)
    assert.deepStrictEqual(
      changes.commits.map((commit) => [commit.subject, commit.author]),
      [['edita e renomeia', 'Ana']],
    )

    assert.match((await fileDiff(place, changes, 'a.txt')).diff, /\+tres/)
    assert.match((await fileDiff(place, changes, 'nao-rastreado.txt')).diff, /\+novo/)
    // O apagado mostra as linhas que saíram (não "sem diferença").
    assert.match((await fileDiff(place, changes, 'apagar.txt')).diff, /^-/m)
    assert.deepStrictEqual(await fileDiff(place, changes, '.env'), { diff: '', truncated: false, protected: true })
    await assert.rejects(fileDiff(place, changes, '../../etc/passwd'), /não está entre as alterações/)
    assert.ok(!existsSync(canary), 'nenhuma config do repositório rodou programa')
  })

  it('não commitado: só o que mudou depois do HEAD; um commit: só o dele; branch inteiro contra a base', async () => {
    const uncommitted = await changesOf(place, 'uncommitted')
    assert.ok(!uncommitted.files.some((file) => file.path === 'a.txt'))
    assert.ok(uncommitted.files.some((file) => file.path === 'apagar.txt' && file.status === 'D'))
    assert.deepStrictEqual(uncommitted.commits, [])

    const head = (await headOf(place))!
    const one = await changesOf(place, 'conversation', { commit: head })
    assert.deepStrictEqual(
      one.files.map((file) => `${file.status} ${file.path}`),
      ['M a.txt', 'R novo-nome.txt'],
    )
    assert.match((await fileDiff(place, one, 'a.txt')).diff, /\+tres/)

    const branch = await changesOf(place, 'branch')
    assert.strictEqual(branch.from, start, 'a base é o merge-base com a main')
    assert.ok(!existsSync(canary))
  })

  it('⛔ filtro do .gitattributes e do info/attributes: o diff e o status do gateway não executam o comando', async () => {
    const fake = realpathSync(mkdtempSync(join(tmpdir(), 'gw-filtro-')))
    const mark = join(fake, 'filtro-rodou')
    try {
      git(fake, 'init', '-q', '-b', 'main')
      writeFileSync(join(fake, 'f.txt'), 'um\n')
      git(fake, 'add', '.')
      git(fake, 'commit', '-q', '-m', 'f')
      git(fake, 'config', 'filter.x.clean', `sh -c 'touch ${mark}; cat'`)
      git(fake, 'config', 'filter.x.smudge', `sh -c 'touch ${mark}; cat'`)
      writeFileSync(join(fake, '.gitattributes'), '* filter=x\n')
      writeFileSync(join(fake, '.git', 'info', 'attributes'), '* filter=x\n')
      appendFileSync(join(fake, 'f.txt'), 'dois\n')
      const fakePlace = { dir: fake, gitCommonDir: join(fake, '.git') }
      const changes = await changesOf(fakePlace, 'uncommitted')
      assert.ok(changes.files.some((file) => file.path === 'f.txt'))
      await fileDiff(fakePlace, changes, 'f.txt')
      assert.ok(!existsSync(mark), 'o filtro do repositório rodou programa no gateway')
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
  })

  it('sem o repositório calculado pelo servidor, nada roda', async () => {
    await assert.rejects(changesOf({ dir: repo }, 'uncommitted'), /não é um repositório/)
  })
})
