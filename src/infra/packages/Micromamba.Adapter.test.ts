import assert from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { PackagesController } from '@infra/http/Packages.Controller'
import { addToolsToPath, MicromambaAdapter, PackageBusyError, parseInstalled, parseSearch, rankHits } from './Micromamba.Adapter'

/**
 * Um `micromamba` falso: anota os argumentos e responde como o de verdade (formato da 2.9). ⚠️ O caminho do
 * log e o atraso vêm de arquivos ao lado dele — o adapter não repassa o ambiente do processo (é o que se testa).
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const here = require('path').dirname(__filename)
fs.appendFileSync(here + '/calls.log', JSON.stringify(args) + '\\n')
const delay = fs.existsSync(here + '/delay') ? Number(fs.readFileSync(here + '/delay', 'utf8')) : 0
const out = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === '--version') out('2.9.0')
else if (args[0] === 'search') out({ result: { pkgs: [
  { name: 'libcurl', version: '8.1', timestamp: 1 },
  { name: 'curl', version: '8.0', timestamp: 1 },
  { name: 'curl', version: '8.9', timestamp: 9, license: 'curl' },
  { name: 'pycurl', version: '7.4', timestamp: 2 },
] } })
else if (args[0] === 'list') out({ log_history: [], packages: [{ name: 'oniguruma', version: '6.9' }, { name: 'jq', version: '1.8.2' }] })
else if (args[0] === 'env') out({ dependencies: ['jq=1.8'] })
else if (args[0] === 'install' || args[0] === 'create') {
  const prefix = args[args.indexOf('-p') + 1]
  fs.mkdirSync(prefix + '/conda-meta', { recursive: true })
  setTimeout(() => process.stdout.write('Transaction finished'), delay)
}
else if (args[0] === 'remove') { process.stderr.write('critical libmamba No package named nada'); process.exit(1) }
`

describe('MicromambaAdapter', () => {
  let root: string
  let bin: string
  let log: string

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-mamba-test-'))
    bin = join(root, 'micromamba')
    log = join(root, 'calls.log')
    writeFileSync(bin, FAKE)
    chmodSync(bin, 0o755)
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
  const adapter = (prefix = join(root, 'tools')) => new MicromambaAdapter(bin, prefix, join(root, 'mamba'))

  it('busca: um por nome (o mais novo), o nome exato primeiro, só no conda-forge', async () => {
    const hits = await adapter().search('Curl')
    assert.deepStrictEqual(hits, [
      { name: 'curl', version: '8.9', license: 'curl' },
      { name: 'libcurl', version: '8.1' },
      { name: 'pycurl', version: '7.4' },
    ])
    assert.deepStrictEqual(calls().at(-1), ['search', '-c', 'conda-forge', '--override-channels', '--json', '*curl*'])
    assert.deepStrictEqual(await adapter().search('a b; rm -rf /'), [], 'termo que não é nome de pacote nem chega a rodar')
  })

  it('instala: cria o ambiente na primeira vez, instala nele depois; versão opcional', async () => {
    const prefix = join(root, 'tools-a')
    const mamba = adapter(prefix)
    assert.strictEqual((await mamba.install('jq')).ok, true)
    assert.deepStrictEqual(calls().at(-1), ['create', '-y', '-p', prefix, '-c', 'conda-forge', '--override-channels', 'jq'])
    await mamba.install('git', '2.45')
    assert.deepStrictEqual(calls().at(-1), ['install', '-y', '-p', prefix, '-c', 'conda-forge', '--override-channels', 'git=2.45'])
    await assert.rejects(() => mamba.install('git;ls'), /not a package name/)
    await assert.rejects(() => mamba.install('git', '1 && ls'), /not a version/)
  })

  it('lista: tudo, com o que foi pedido marcado; ambiente que não existe = vazio', async () => {
    assert.deepStrictEqual(await adapter(join(root, 'nunca')).list(), [])
    const prefix = join(root, 'tools-b')
    mkdirSync(join(prefix, 'conda-meta'), { recursive: true })
    assert.deepStrictEqual(await adapter(prefix).list(), [
      { name: 'jq', version: '1.8.2', explicit: true },
      { name: 'oniguruma', version: '6.9', explicit: false },
    ])
  })

  it('⛔ uma operação por vez; falha volta com o log, sem lançar', async () => {
    writeFileSync(join(root, 'delay'), '300')
    const mamba = adapter(join(root, 'tools-c'))
    const first = mamba.install('jq')
    await assert.rejects(() => mamba.remove('jq'), PackageBusyError)
    await first
    rmSync(join(root, 'delay'))
    const failed = await mamba.remove('nada')
    assert.strictEqual(failed.ok, false)
    assert.match(failed.log, /No package named nada/)
  })

  it('o bin das ferramentas entra no PATH uma vez só', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', CONVERSATIONS_DB: join(root, 'gateway.db') }
    addToolsToPath(env)
    addToolsToPath(env)
    assert.deepStrictEqual(env.PATH?.split(delimiter), [join(root, 'tools', 'bin'), '/usr/bin'])
  })

  it('parsers: versão mais nova pelo timestamp, ranking e specs do histórico', () => {
    assert.deepStrictEqual(
      parseSearch(
        JSON.stringify({
          result: {
            pkgs: [
              { name: 'x', version: '2', timestamp: 5 },
              { name: 'x', version: '1', timestamp: 3 },
            ],
          },
        }),
      ),
      [{ name: 'x', version: '2' }],
    )
    assert.deepStrictEqual(
      rankHits(
        [
          { name: 'zjq', version: '1' },
          { name: 'jq', version: '1' },
          { name: 'jqp', version: '1' },
        ],
        'jq',
      ).map((hit) => hit.name),
      ['jq', 'jqp', 'zjq'],
    )
    assert.deepStrictEqual(parseInstalled(JSON.stringify([{ name: 'git', version: '2' }]), JSON.stringify({ dependencies: ['git>=2.40'] })), [
      { name: 'git', version: '2', explicit: true },
    ])
  })

  it('⛔ a guia é só de administrador: sem prova, 404', async () => {
    const controller = new PackagesController({ packages: adapter() })
    let status = 0
    let body: unknown
    const res = { status: (code: number) => ((status = code), res), json: (value: unknown) => ((body = value), res) }
    await controller.list({} as never, res as never)
    assert.deepStrictEqual([status, (body as { code?: string }).code], [404, 'not_found'])
  })
})
