import assert from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { expandReadDenyGlobs } from './ReadDeny.Globs'

/** Uma worktree de mentira: segredos na raiz, num app, num pacote (`node_modules`) e atrás de um link. */
function tree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deny-globs-')))
  const file = (path: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), 'x')
  }
  file('.env')
  file('apps/a/.env')
  file('apps/a/.env.local')
  file('apps/a/src/main.ts')
  file('node_modules/pkg/.env')
  file('node_modules/.pnpm/dep@1/node_modules/dep/.env')
  file('.credentials/token')
  file('infra/ssl/server.pem')
  file('.git/config')
  symlinkSync(join(root, 'apps', 'a'), join(root, 'linked'))
  return root
}

describe('expandReadDenyGlobs (as negações de leitura com curinga, expandidas pelo gateway)', () => {
  it('⚡ o padrão vira os caminhos que existem e casam, onde moram; node_modules e .git não são atravessados', async () => {
    const root = tree()
    const out = await expandReadDenyGlobs([`${root}/**/.env`, `${root}/**/.env.*`, `${root}/**/*.pem`])
    assert.deepStrictEqual(out.sort(), [join(root, '.env'), join(root, 'apps/a/.env'), join(root, 'apps/a/.env.local'), join(root, 'infra/ssl/server.pem')].sort())
    assert.ok(!out.some((path) => path.includes('node_modules')))
    assert.ok(!out.some((path) => path.includes('*')))
  })

  it('o que casa atrás de um link sai pelo caminho REAL (a montagem esconde o arquivo dos dois caminhos)', async () => {
    const root = tree()
    const out = await expandReadDenyGlobs([`${root}/linked/.env`, `${root}/linked/*.local`])
    // O primeiro é literal (segue para o runtime); o segundo é expandido para onde o arquivo mora.
    assert.deepStrictEqual(out, [`${root}/linked/.env`, join(root, 'apps/a/.env.local')])
  })

  it('`x/**` vale também para a pasta x; `<pasta>/**` sem outro curinga é a própria pasta', async () => {
    const root = tree()
    assert.deepStrictEqual(await expandReadDenyGlobs([`${root}/**/.credentials/**`]), [join(root, '.credentials')])
    assert.deepStrictEqual(await expandReadDenyGlobs([`${root}/apps/**`]), [join(root, 'apps')])
  })

  it('⛔ falha fechada: fica com o runtime o padrão que nomeia node_modules, o que usa chaves, o da raiz do disco e o que passa do teto', async () => {
    const root = tree()
    const kept = [`${root}/node_modules/**/.env`, `${root}/**/{a,b}.env`, '/**/.env']
    assert.deepStrictEqual(await expandReadDenyGlobs(kept), kept)
    assert.deepStrictEqual(await expandReadDenyGlobs([`${root}/**/.env`], undefined, { walk: 3 }), [`${root}/**/.env`])
    assert.deepStrictEqual(await expandReadDenyGlobs([`${root}/**/.env`], undefined, { matches: 1 }), [`${root}/**/.env`])
  })

  it('a pasta que não se lista no meio da árvore devolve o padrão ao runtime (que a nega inteira)', async () => {
    const root = tree()
    const fs = {
      read: async (dir: string) => {
        if (dir.endsWith('/apps')) throw new Error('EACCES')
        const { readdir } = await import('node:fs/promises')
        return readdir(dir, { withFileTypes: true })
      },
      stat: async (path: string) => (await import('node:fs/promises')).stat(path),
      realpath: async (path: string) => (await import('node:fs/promises')).realpath(path),
    }
    assert.deepStrictEqual(await expandReadDenyGlobs([`${root}/**/.env`], fs), [`${root}/**/.env`])
  })

  it('os literais seguem como vieram; uma varredura por base serve a todos os padrões dela', async () => {
    const root = tree()
    let listed = 0
    const { readdir, stat, realpath } = await import('node:fs/promises')
    const fs = { read: (dir: string) => ((listed += 1), readdir(dir, { withFileTypes: true })), stat: (p: string) => stat(p), realpath: (p: string) => realpath(p) }
    const out = await expandReadDenyGlobs(['/', `${root}/**/.env`, `${root}/**/*.pem`, `${root}/apps/a/**/.env`], fs)
    assert.strictEqual(out[0], '/')
    assert.ok(out.includes(join(root, 'infra/ssl/server.pem')))
    // A árvore (sem node_modules e .git) tem 8 pastas; a base `apps/a` reaproveita as listagens.
    assert.ok(listed <= 8, `listou ${listed} pastas`)
  })
})
