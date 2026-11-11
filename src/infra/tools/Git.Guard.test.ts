import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { analyzeShell } from '@infra/permissions/Shell.Parse'
import { gitGuard, IGitGuardOptions } from './Git.Guard'

describe('Git.Guard (as travas de git da instalação)', () => {
  let base: string
  let main: string
  let worktree: string
  const options = (over: Partial<IGitGuardOptions> = {}): IGitGuardOptions => ({
    lockMainCheckout: true,
    protectedBranches: ['automation', 'main'],
    branchPrefix: 'henrique/',
    ...over,
  })
  const guard = async (command: string, root: string, over: Partial<IGitGuardOptions> = {}, branch = 'henrique/tarefa') =>
    gitGuard((await analyzeShell(command)).commands, root, options(over), () => branch)

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'git-guard-'))
    main = join(base, 'repositories', 'logiccus')
    mkdirSync(main, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'automation')
    writeFileSync(join(main, 'a.txt'), 'a')
    git('add', '.')
    git('-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'x')
    worktree = join(base, '_worktrees', 'ep-1')
    git('worktree', 'add', '-q', '-b', 'henrique/ep-1', worktree)
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  it('⛔ trocar de branch na pasta principal é recusado (direto, com cd e com -C); na worktree, livre', async () => {
    assert.match((await guard('git checkout outra', main)).refusal!, /worktree/)
    assert.ok((await guard('git switch -c henrique/x', main)).refusal)
    assert.ok((await guard('cd repositories/logiccus && git checkout -b henrique/x', base)).refusal)
    assert.ok((await guard('git -C repositories/logiccus switch outra', base)).refusal)
    assert.equal((await guard('git checkout outra', worktree)).refusal, undefined)
    assert.equal((await guard('git checkout outra', main, { lockMainCheckout: false })).refusal, undefined)
  })

  it('restaurar arquivo na pasta principal segue livre', async () => {
    assert.equal((await guard('git checkout -- a.txt', main)).refusal, undefined)
    assert.equal((await guard('git checkout a.txt', main)).refusal, undefined)
    assert.equal((await guard('git status && git pull', main)).refusal, undefined)
  })

  it('⛔ push direto em branch protegida: pelo refspec, pela branch atual, e --all; a do trabalho passa', async () => {
    assert.match((await guard('git push origin automation', worktree)).refusal!, /automation.*PR/)
    assert.ok((await guard('git push origin HEAD:refs/heads/main', worktree)).refusal)
    assert.ok((await guard('git push origin +HEAD:automation', worktree)).refusal)
    assert.ok((await guard('git push', worktree, {}, 'automation')).refusal)
    assert.ok((await guard('git push --all origin', worktree)).refusal)
    assert.equal((await guard('git push -u origin henrique/ep-1', worktree)).refusal, undefined)
    assert.equal((await guard('git push origin automation', worktree, { protectedBranches: [] })).refusal, undefined)
  })

  it('branch nova fora do prefixo: só aviso', async () => {
    const result = await guard('git worktree add ../x -b tarefa', main)
    assert.equal(result.refusal, undefined)
    assert.match(result.notes[0]!, /henrique\/tarefa/)
    assert.deepEqual((await guard('git branch henrique/ok', worktree)).notes, [])
  })
})
