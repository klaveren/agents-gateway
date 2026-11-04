import assert from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { NpmAdapter, parseNpmList, parseNpmSearch } from './Npm.Adapter'

describe('NpmAdapter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-npm-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const prefix = join(dir, 'tools', 'npm')
  const calls = join(dir, 'calls.log')
  // Um npm de mentira: grava os argumentos e o prefixo; `ls` responde a lista.
  const fake = join(dir, 'npm')
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$NPM_CONFIG_PREFIX $*" >> ${calls}\nif [ "$1" = "ls" ]; then echo '{"dependencies":{"mongosh":{"version":"2.14.1"},"npm":{"version":"11.0.0"}}}'; fi\nif [ "$1" = "--version" ]; then echo 11.6.2; fi\n`,
  )
  chmodSync(fake, 0o755)
  const npm = new NpmAdapter(fake, prefix)

  it('⛔ instala com versão EXATA, sem os scripts de instalação, no prefixo da guia', async () => {
    assert.deepStrictEqual(await npm.available(), { available: true, version: '11.6.2' })
    assert.strictEqual((await npm.install('mongosh', '2.14.1')).ok, true)
    assert.match(readFileSync(calls, 'utf8'), new RegExp(`${prefix} install -g --ignore-scripts --no-fund --no-audit mongosh@2.14.1`))
    await assert.rejects(() => npm.install('mongosh', 'latest'), /not an exact version/)
    await assert.rejects(() => npm.install('Mongo Sh', '1.0.0'), /not an npm package name/)
  })

  it('lista o que foi instalado (sem o próprio npm) e remove', async () => {
    mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true })
    assert.deepStrictEqual(await npm.list(), [{ name: 'mongosh', version: '2.14.1', explicit: true }])
    assert.strictEqual((await npm.remove('@mongosh/cli')).ok, true)
    assert.match(readFileSync(calls, 'utf8'), /uninstall -g @mongosh\/cli/)
  })

  it('a busca põe o nome exato primeiro; saída quebrada vira lista vazia', () => {
    assert.deepStrictEqual(
      parseNpmSearch(
        JSON.stringify([
          { name: 'mongosh-foo', version: '1.0.0' },
          { name: 'mongosh', version: '2.14.1', license: 'Apache-2.0' },
        ]),
        'mongosh',
      ).map((hit) => hit.name),
      ['mongosh', 'mongosh-foo'],
    )
    assert.deepStrictEqual(parseNpmSearch('não é json', 'x'), [])
    assert.deepStrictEqual(parseNpmList('{'), [])
  })
})
