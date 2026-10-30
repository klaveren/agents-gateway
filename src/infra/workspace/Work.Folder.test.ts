import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { listRepositories, resolveWorkFolder, WorkFolderError } from './Work.Folder'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })

describe('Work.Folder (a pasta de trabalho da conversa)', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gw-wf-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'gw-wf-fora-')))
  const repo = join(project, 'repositories', 'abc')
  before(() => {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'a')
    git(repo, 'worktree', 'add', '-q', '-b', 'epic-EP-1', join(repo, '_worktrees', 'EP-1'))
    git(repo, 'worktree', 'add', '-q', '-b', 'fora', join(outside, 'wt-fora'))
    mkdirSync(join(project, 'repositories', 'nao-git'))
    symlinkSync(outside, join(project, 'repositories', 'link'))
  })
  after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('sem parâmetro, o projeto; só o repositório, a pasta dele com o .git dentro', () => {
    assert.deepStrictEqual(resolveWorkFolder(project), { dir: project })
    const only = resolveWorkFolder(project, 'abc')
    assert.deepStrictEqual([only.dir, only.gitCommonDir, only.worktree], [repo, join(repo, '.git'), undefined])
  })

  it('⛔ a worktree pelo nome da pasta ou pelo branch, com o .git comum (que fica fora dela)', () => {
    for (const name of ['EP-1', 'epic-EP-1']) {
      const folder = resolveWorkFolder(project, 'abc', name)
      assert.strictEqual(folder.dir, join(repo, '_worktrees', 'EP-1'))
      assert.strictEqual(folder.worktree, 'EP-1')
      assert.strictEqual(folder.gitCommonDir, join(repo, '.git'))
      assert.strictEqual(folder.worktreeGitDir, join(repo, '.git', 'worktrees', 'EP-1'))
    }
  })

  it('⛔ recusa: worktree sem repositório, barra ou .., não git, link para fora, worktree fora do projeto, inexistente', () => {
    const cases: Array<[string | undefined, string | undefined, RegExp]> = [
      [undefined, 'EP-1', /informe também o repository/],
      ['../abc', undefined, /sem barra/],
      ['..', undefined, /sem barra/],
      ['nao-git', undefined, /não é um repositório git/],
      ['link', undefined, /não existe/],
      ['abc', 'fora', /fora do projeto/],
      ['abc', 'EP-9', /não é uma worktree/],
      ['zzz', undefined, /não existe/],
      ['abc', '../x', /o nome da pasta/],
    ]
    for (const [repository, worktree, message] of cases)
      assert.throws(
        () => resolveWorkFolder(project, repository, worktree),
        (error: unknown) => error instanceof WorkFolderError && message.test(error.message),
        `${repository}/${worktree}`,
      )
  })

  it('a lista para a tela: os repositórios git e só as worktrees dentro do projeto', () => {
    assert.deepStrictEqual(listRepositories(project), [{ name: 'abc', worktrees: [{ name: 'EP-1', branch: 'epic-EP-1', path: 'repositories/abc/_worktrees/EP-1' }] }])
  })
})
