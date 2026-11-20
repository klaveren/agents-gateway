import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parseStatusV2, scmBlame, scmCommit, scmDiff, scmStage, scmState, scmUnstage } from './Repository.Scm'
import { IWorkFolder } from './Work.Folder'

const author = { name: 'Pessoa Teste', email: 'pessoa@teste.local' }

describe('Repository.Scm — o controle de versão da conversa', () => {
  let root: string
  let folder: IWorkFolder
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' },
    })

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-scm-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(root, 'a.txt'), 'um\n')
    git('add', '.')
    git('commit', '-q', '-m', 'início')
    folder = { dir: root, gitCommonDir: join(root, '.git') }
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('lê o porcelain v2: branch, à frente/atrás, preparado e não preparado', () => {
    const state = parseStatusV2(
      [
        '# branch.oid abc',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -13',
        '1 M. N... 100644 100644 100644 h1 h2 src/a b.ts',
        '1 .M N... 100644 100644 100644 h1 h2 b.ts',
        '? novo.ts',
        '? .env',
        '',
      ].join('\0'),
    )
    assert.equal(state.branch, 'main')
    assert.equal(state.upstream, 'origin/main')
    assert.equal(state.ahead, 2)
    assert.equal(state.behind, 13)
    assert.deepEqual(state.staged, [{ path: 'src/a b.ts', status: 'M' }])
    assert.deepEqual(state.changes, [
      { path: 'b.ts', status: 'M' },
      { path: 'novo.ts', status: 'U' },
    ])
  })

  it('prepara, despreparara, mostra o diff e commita com o autor da tela, sem hook', async () => {
    writeFileSync(join(root, 'a.txt'), 'dois\n')
    writeFileSync(join(root, 'b.txt'), 'b\n')
    writeFileSync(join(root, '.env'), 'SEGREDO=1\n')
    // Um hook que falharia o commit: não pode rodar.
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    let state = await scmState(folder)
    assert.equal(state.branch, 'main')
    assert.deepEqual(state.changes.map((entry) => entry.path).sort(), ['a.txt', 'b.txt'])
    assert.deepEqual(await scmDiff(folder, 'a.txt', false), { path: 'a.txt', original: 'um\n', modified: 'dois\n' })
    await scmStage(folder, ['a.txt'])
    state = await scmState(folder)
    assert.deepEqual(state.staged, [{ path: 'a.txt', status: 'M' }])
    await scmUnstage(folder, ['a.txt'])
    assert.equal((await scmState(folder)).staged.length, 0)
    await assert.rejects(scmStage(folder, ['.env']))
    // Sem nada preparado, leva tudo (menos o segredo).
    const { commit } = await scmCommit(folder, 'mudanças da tela', author)
    assert.match(commit, /^[0-9a-f]{40}$/)
    assert.equal(git('log', '-1', '--format=%an <%ae>|%s').trim(), 'Pessoa Teste <pessoa@teste.local>|mudanças da tela')
    assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort().join(','), 'a.txt,b.txt')
  })

  it('diz quem mudou a linha por último', async () => {
    const blame = await scmBlame(folder, 'a.txt', 1)
    assert.equal(blame?.author, 'Pessoa Teste')
    assert.equal(blame?.summary, 'mudanças da tela')
    writeFileSync(join(root, 'a.txt'), 'três\n')
    assert.deepEqual(await scmBlame(folder, 'a.txt', 1), { uncommitted: true })
  })

  it('recusa commitar segredo que o agente preparou sozinho', async () => {
    git('add', '-f', '.env')
    await assert.rejects(scmCommit(folder, 'x', author), /secret/)
    git('reset', '-q', 'HEAD', '--', '.env')
  })
})
