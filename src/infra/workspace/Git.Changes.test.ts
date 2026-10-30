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
  let start = ''
  before(async () => {
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'um\ndois\n')
    writeFileSync(join(repo, 'velho.txt'), 'renomear\n'.repeat(20))
    writeFileSync(join(repo, 'apagar.txt'), 'x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'base')
    git(repo, 'checkout', '-q', '-b', 'epic-EP-1')
    start = (await headOf(repo))!
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
    const changes = await changesOf(repo, 'conversation', { startCommit: start })
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

    assert.match((await fileDiff(repo, changes, 'a.txt')).diff, /\+tres/)
    assert.match((await fileDiff(repo, changes, 'nao-rastreado.txt')).diff, /\+novo/)
    assert.deepStrictEqual(await fileDiff(repo, changes, '.env'), { diff: '', truncated: false, protected: true })
    await assert.rejects(fileDiff(repo, changes, '../../etc/passwd'), /não está entre as alterações/)
    assert.ok(!existsSync(canary), 'nenhuma config do repositório rodou programa')
  })

  it('não commitado: só o que mudou depois do HEAD; um commit: só o dele; branch inteiro contra a base', async () => {
    const uncommitted = await changesOf(repo, 'uncommitted')
    assert.ok(!uncommitted.files.some((file) => file.path === 'a.txt'))
    assert.ok(uncommitted.files.some((file) => file.path === 'apagar.txt' && file.status === 'D'))
    assert.deepStrictEqual(uncommitted.commits, [])

    const head = (await headOf(repo))!
    const one = await changesOf(repo, 'conversation', { commit: head })
    assert.deepStrictEqual(
      one.files.map((file) => `${file.status} ${file.path}`),
      ['M a.txt', 'R novo-nome.txt'],
    )
    assert.match((await fileDiff(repo, one, 'a.txt')).diff, /\+tres/)

    const branch = await changesOf(repo, 'branch')
    assert.strictEqual(branch.from, start, 'a base é o merge-base com a main')
    assert.ok(!existsSync(canary))
  })
})
