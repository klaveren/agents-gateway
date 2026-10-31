import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runCatalogCli } from './Catalog.Cli'
import { writeCatalogDirectory } from './Catalog.Directory'
import { tarGz, untarGz } from './Tar.Archive'

const work = mkdtempSync(join(tmpdir(), 'catalog-export-'))
after(() => rmSync(work, { recursive: true, force: true }))

const LONG = `catalog/projects/${'p'.repeat(30)}/skills/${'s'.repeat(47)}/${'d'.repeat(60)}/${'x'.repeat(120)}.md`

describe('Tar.Archive — tar.gz sem dependência', () => {
  const entries = [
    { path: 'catalog/catalog.json', content: '{}\n' },
    { path: 'catalog/global/skills/revisao/SKILL.md', content: '---\nname: revisao\n---\nAção ✓\n' },
    { path: `catalog/global/${'a'.repeat(90)}/${'b'.repeat(40)}.md`, content: 'prefixo' },
    { path: LONG, content: 'pax' },
    { path: 'catalog/vazio.md', content: '' },
  ]
  const archive = tarGz(entries, new Date('2026-10-30T12:00:00Z'))

  it('ida e volta: caminhos (curtos, com prefixo e por PAX) e conteúdo byte a byte', () => {
    const back = untarGz(archive)
    assert.deepStrictEqual(
      back.map((entry) => [entry.path, entry.content.toString('utf8')]),
      entries.map((entry) => [entry.path, entry.content]),
    )
  })

  it('determinístico: o mesmo conteúdo dá o mesmo tar', () => {
    assert.deepStrictEqual(untarGz(tarGz(entries, new Date('2026-10-30T12:00:00Z'))), untarGz(archive))
  })

  it('o `tar` do sistema abre', { skip: spawnSync('tar', ['--version']).status !== 0 }, () => {
    const file = join(work, 'pacote.tar.gz')
    writeFileSync(file, archive)
    const out = join(work, 'extraido')
    mkdirSync(out)
    const result = spawnSync('tar', ['-xzf', file, '-C', out], { encoding: 'utf8' })
    assert.strictEqual(result.status, 0, result.stderr)
    for (const entry of entries) assert.strictEqual(readFileSync(join(out, entry.path), 'utf8'), entry.content, entry.path)
  })
})

describe('Catalog.Directory — o pacote numa pasta', () => {
  it('escreve, e no export seguinte apaga só o que o manifesto anterior listava', () => {
    const dir = join(work, 'repo')
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'meu')
    const first = {
      'catalog.json': JSON.stringify({ files: { 'global/specs/a.md': 'h', 'global/specs/b.md': 'h', 'projects/x/project.json': 'h' } }),
      'global/specs/a.md': 'A',
      'global/specs/b.md': 'B',
      'projects/x/project.json': '{}',
    }
    assert.deepStrictEqual(writeCatalogDirectory(dir, first), { written: 4, removed: [] })
    const second = { 'catalog.json': JSON.stringify({ files: { 'global/specs/a.md': 'h' } }), 'global/specs/a.md': 'A2' }
    assert.deepStrictEqual(writeCatalogDirectory(dir, second), { written: 2, removed: ['global/specs/b.md', 'projects/x/project.json'] })
    assert.strictEqual(readFileSync(join(dir, 'global/specs/a.md'), 'utf8'), 'A2')
    assert.ok(!existsSync(join(dir, 'projects')), 'a pasta que ficou vazia sai')
    assert.ok(existsSync(join(dir, 'README.md')) && existsSync(join(dir, '.git')))
  })

  it('⛔ caminho que sairia da pasta é recusado antes de escrever qualquer coisa', () => {
    const dir = join(work, 'fuga')
    assert.throws(() => writeCatalogDirectory(dir, { 'global/ok.md': 'x', '../fora.md': 'x' }), /fora da pasta/)
    assert.throws(() => writeCatalogDirectory(dir, { '/etc/x': 'x' }), /fora da pasta/)
    assert.ok(!existsSync(dir))
  })

  it('⛔ um manifesto anterior adulterado não apaga fora da pasta', () => {
    const dir = join(work, 'adulterado')
    writeFileSync(join(work, 'vitima.txt'), 'fica')
    mkdirSync(dir)
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ files: { '../vitima.txt': 'h' } }))
    writeCatalogDirectory(dir, { 'catalog.json': '{}' })
    assert.ok(existsSync(join(work, 'vitima.txt')))
  })
})

describe('Catalog.Cli — pnpm catalog export', () => {
  const manifest = {
    format: 1,
    scope: 'project:alfa',
    exportedAt: '2026-10-30T12:00:00.000Z',
    files: { 'projects/alfa/project.json': 'h' },
    masked: [{ path: 'p', field: 'body', layer: 'format', label: 'JWT' }],
  }
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response

  it('pede o pacote em JSON com o escopo e o token no header da conta, e escreve a pasta', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const lines: string[] = []
    const dir = join(work, 'cli')
    const code = await runCatalogCli(['export', dir, '--project', 'alfa'], {
      env: { GATEWAY_URL: 'https://gw.test/', GATEWAY_TOKEN: 'agw_abc' },
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers })
        return reply(200, { ok: true, result: { manifest, files: { 'catalog.json': '{}', 'projects/alfa/project.json': '{"id":"alfa"}\n' } } })
      }) as unknown as typeof fetch,
      log: (line) => lines.push(line),
    })
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, [{ url: 'https://gw.test/v1/catalog/export?format=json&scope=project&project=alfa', headers: { 'X-Tool-Authorization': 'Bearer agw_abc' } }])
    assert.strictEqual(readFileSync(join(dir, 'projects/alfa/project.json'), 'utf8'), '{"id":"alfa"}\n')
    assert.match(lines.join('\n'), /2 arquivo\(s\) escrito\(s\)[\s\S]*mascarado: p · body \(format: JWT\)/)
  })

  it('falha da API: código 1 e a dica; uso errado: código 2', async () => {
    const lines: string[] = []
    const io = { env: {}, fetch: (async () => reply(404, { ok: false, message: 'Not found' })) as unknown as typeof fetch, log: (line: string) => lines.push(line) }
    assert.strictEqual(await runCatalogCli(['export', join(work, 'nada')], io), 1)
    assert.match(lines[0], /HTTP 404 — Not found \(só admin/)
    assert.strictEqual(await runCatalogCli([], io), 2)
    assert.strictEqual(await runCatalogCli(['import', 'x'], io), 2)
    assert.strictEqual(await runCatalogCli(['export'], io), 2)
    assert.strictEqual(await runCatalogCli(['export', 'x', '--project', 'a', '--global'], io), 2)
  })
})
