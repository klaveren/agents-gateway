import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { changesOf } from './Git.Changes'
import { currentBranch, listRepositories, listWorktrees, projectAliases, resolveWorkFolder, WorkFolderError } from './Work.Folder'

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

  it('⛔ o arquivo da worktree também a partir da pasta do projeto, mesmo o que ainda não existe; fora dela, nada', () => {
    const folder = { dir: join(repo, '_worktrees', 'EP-1'), projectDir: project }
    assert.deepStrictEqual(projectAliases(join(folder.dir, 'a.txt'), folder), ['repositories/abc/_worktrees/EP-1/a.txt'])
    assert.deepStrictEqual(projectAliases(join(folder.dir, 'novo.test.ts'), folder), ['repositories/abc/_worktrees/EP-1/novo.test.ts'])
    assert.deepStrictEqual(projectAliases(join(outside, 'x'), folder), [])
    assert.deepStrictEqual(projectAliases(join(project, 'a'), { dir: project, projectDir: project }), [], 'mesma pasta: nada a acrescentar')
    assert.deepStrictEqual(projectAliases(join(project, 'a'), undefined), [])
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

describe('Work.Folder: o git calculado pelo servidor (o agente reescreve o .git da worktree)', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'gw-wf-forja-')))
  const secrets = realpathSync(mkdtempSync(join(tmpdir(), 'gw-wf-segredos-')))
  const repo = join(project, 'repositories', 'abc')
  const wt = join(repo, '_worktrees', 'EP-1')
  const gitDir = join(repo, '.git', 'worktrees', 'EP-1')
  before(() => {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'a')
    git(repo, 'worktree', 'add', '-q', '-b', 'epic-EP-1', wt)
    git(repo, 'worktree', 'add', '-q', '-b', 'epic-EP-2', join(repo, '_worktrees', 'EP-2'))
  })
  after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(secrets, { recursive: true, force: true })
  })
  const original = () => readFileSync(join(wt, '.git'), 'utf8')

  it('⛔ o .git da worktree reescrito para um caminho de fora (o cerco liberaria ler e gravar ali): recusado', () => {
    const before = original()
    try {
      for (const target of [join(secrets, 'secrets.key'), secrets, join(project, 'gateway.db'), join(secrets, 'worktrees', 'EP-1'), join(repo, '.git')]) {
        writeFileSync(join(wt, '.git'), `gitdir: ${target}\n`)
        assert.throws(() => resolveWorkFolder(project, 'abc', 'EP-1'), WorkFolderError, target)
      }
    } finally {
      writeFileSync(join(wt, '.git'), before)
    }
  })

  it('⛔ o .git da worktree apontando para a de OUTRA worktree do mesmo repositório: recusado (o caminho de volta não bate)', () => {
    const before = original()
    try {
      writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'EP-2')}\n`)
      assert.throws(() => resolveWorkFolder(project, 'abc', 'EP-1'), WorkFolderError)
    } finally {
      writeFileSync(join(wt, '.git'), before)
    }
  })

  it('⛔ um commondir forjado não vale: o comum é o .git do repositório, e o git do gateway não lê o do atacante', async () => {
    // Uma cópia do .git com um filtro armado, e o commondir da worktree apontando para ela.
    const copy = join(secrets, 'copia.git')
    cpSync(join(repo, '.git'), copy, { recursive: true })
    const mark = join(secrets, 'filtro-rodou')
    git(repo, 'config', '--file', join(copy, 'config'), 'filter.x.clean', `sh -c 'touch ${mark}; cat'`)
    git(repo, 'config', '--file', join(copy, 'config'), 'core.fsmonitor', `sh -c 'touch ${mark}'`)
    writeFileSync(join(wt, '.gitattributes'), '* filter=x\n')
    writeFileSync(join(wt, 'a.txt'), 'mudou')
    const original = readFileSync(join(gitDir, 'commondir'), 'utf8')
    writeFileSync(join(gitDir, 'commondir'), `${copy}\n`)
    try {
      const folder = resolveWorkFolder(project, 'abc', 'EP-1')
      assert.strictEqual(folder.gitCommonDir, join(repo, '.git'))
      assert.strictEqual(folder.worktreeGitDir, gitDir)
      const changes = await changesOf(folder, 'uncommitted')
      assert.ok(changes.files.some((file) => file.path === 'a.txt'))
      assert.strictEqual(currentBranch(folder), 'epic-EP-1')
      assert.ok(!existsSync(mark), 'o git do gateway leu o commondir forjado')
    } finally {
      writeFileSync(join(gitDir, 'commondir'), original)
      rmSync(join(wt, '.gitattributes'), { force: true })
      writeFileSync(join(wt, 'a.txt'), 'a')
    }
  })

  it('⛔ no modo só repositório o .git tem de ser um diretório: arquivo gitdir: ou link, recusado', () => {
    const other = join(project, 'repositories', 'forjado')
    mkdirSync(other, { recursive: true })
    const real = join(secrets, 'outro.git')
    cpSync(join(repo, '.git'), real, { recursive: true })
    writeFileSync(join(other, '.git'), `gitdir: ${real}\n`)
    assert.throws(() => resolveWorkFolder(project, 'forjado'), /não é um repositório git/)
    rmSync(join(other, '.git'))
    symlinkSync(real, join(other, '.git'))
    assert.throws(() => resolveWorkFolder(project, 'forjado'), /não é um repositório git/)
    assert.deepStrictEqual(listWorktrees(other), [])
  })
})
