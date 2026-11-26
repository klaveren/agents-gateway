import assert from 'node:assert'
import { describe, it } from 'node:test'
import { mainRepositoryNote } from './Worktree.Policy'

const place = { dir: '/p/repositories/_worktrees/logiccus/fix-x', worktree: 'fix-x', repositoryDir: '/p/repositories/logiccus' }

describe('Worktree.Policy', () => {
  it('⛔ escrita no principal (caminho na saída): diz onde trabalhar, com o caminho equivalente na worktree', () => {
    const note = mainRepositoryNote("mkdir '/p/repositories/logiccus/apps/logiccus/node_modules/.vite-temp': Read-only file system", 'npx vitest', place)
    assert.match(note, /repositório principal \(`\/p\/repositories\/logiccus`\) é só leitura/)
    assert.match(note, /`\/p\/repositories\/_worktrees\/logiccus\/fix-x\/apps\/logiccus\/node_modules\/\.vite-temp`/)
  })

  it('caminho relativo na saída: o `cd <principal>` do comando decide', () => {
    const note = mainRepositoryNote('mkdir apps/logiccus/node_modules/.vite-temp: Read-only file system', 'cd /p/repositories/logiccus && npm test', place)
    assert.match(note, /na worktree `\/p\/repositories\/_worktrees\/logiccus\/fix-x`\. Rode testes, builds e scripts lá, não no principal\./)
  })

  it('nada: sem worktree, sem EROFS, ou o caminho é da própria worktree (dentro do principal ou não)', () => {
    const out = '/p/repositories/logiccus/a: Read-only file system'
    assert.strictEqual(mainRepositoryNote(out, '', { dir: '/p/repositories/logiccus', repositoryDir: '/p/repositories/logiccus' }), '')
    assert.strictEqual(mainRepositoryNote('/p/repositories/logiccus/a: Permission denied', '', place), '')
    assert.strictEqual(mainRepositoryNote('/etc/x: Read-only file system', 'ls', place), '')
    const inside = { dir: '/p/repositories/logiccus/.wt/fix-x', worktree: 'fix-x', repositoryDir: '/p/repositories/logiccus' }
    assert.strictEqual(mainRepositoryNote('/p/repositories/logiccus/.wt/fix-x/a: Read-only file system', '', inside), '')
  })
})
