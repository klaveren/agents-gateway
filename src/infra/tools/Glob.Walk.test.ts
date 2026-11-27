import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globWalk } from './Glob.Walk'

const SKIP = new Set(['node_modules', '.git'])

describe('globWalk', () => {
  let dir: string
  const names = async (pattern: string, max = 1000) => (await globWalk(dir, pattern, { skip: SKIP, max })).names

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-walk-'))
    for (const sub of ['src/deep/er', '.hid/in', 'real/sub', 'node_modules/pkg', '.git']) mkdirSync(join(dir, sub), { recursive: true })
    for (const file of ['src/a.md', 'src/b.ts', 'src/deep/c.md', 'src/deep/er/x1.txt', '.env', '.dot.md', '.hid/in/y.txt', 'real/sub/z.txt', 'node_modules/pkg/i.md', '.git/HEAD'])
      writeFileSync(join(dir, file), 'x\n')
    symlinkSync('real', join(dir, 'linkdir'))
    symlinkSync('src/a.md', join(dir, 'linkfile'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('casa como o glob do Node: `**` não entra em pasta de ponto, e node_modules/.git ficam de fora', async () => {
    assert.deepEqual(await names('**/*.md'), ['src/a.md', 'src/deep/c.md'])
    assert.deepEqual(await names('src/*.md'), ['src/a.md'])
    assert.deepEqual(await names('**/x?.txt'), ['src/deep/er/x1.txt'])
    assert.deepEqual(await names('*'), ['linkdir', 'linkfile', 'real', 'src'])
  })

  it('o padrão que nomeia o ponto casa pasta e arquivo de ponto; a base de ponto é varrida', async () => {
    assert.deepEqual(await names('.*'), ['.dot.md', '.env', '.hid'])
    assert.deepEqual(await names('.hid/**'), ['.hid', '.hid/in', '.hid/in/y.txt'])
  })

  it('`x/**` inclui a própria pasta; `x/` só casa pasta (não o link)', async () => {
    assert.deepEqual(await names('src/**'), ['src', 'src/a.md', 'src/b.ts', 'src/deep', 'src/deep/c.md', 'src/deep/er', 'src/deep/er/x1.txt'])
    assert.deepEqual(await names('*/'), ['real', 'src'])
  })

  it('o link na base é seguido; dentro da varredura, o link é listado e não seguido', async () => {
    assert.deepEqual(await names('linkdir/*/*'), ['linkdir/sub/z.txt'])
    assert.deepEqual(await names('**/z.txt'), ['real/sub/z.txt'])
  })

  it('sem curinga: o próprio caminho, se existe', async () => {
    assert.deepEqual(await names('src'), ['src'])
    assert.deepEqual(await names('./src/a.md'), ['src/a.md'])
    assert.deepEqual(await names('nada'), [])
    assert.deepEqual(await names('node_modules/pkg/*'), [])
  })

  it('para no teto e avisa', async () => {
    const walked = await globWalk(dir, '**/*', { skip: SKIP, max: 3 })
    assert.equal(walked.capped, true)
    assert.ok(walked.names.length <= 3)
    assert.equal((await globWalk(dir, '**/*', { skip: SKIP, max: 1000 })).capped, false)
  })
})
