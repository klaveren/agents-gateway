import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { IAgenticScope } from '@domain/Import.Scope'
import { maskText } from '@domain/Secret.Mask'
import { IImportScan, IInventoryItem } from '@domain/models/ImportInventory.Model'
import { AgenticToolsDetector } from '@infra/import/AgenticTools.Detector'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { AgentsMdDetector } from '@infra/import/AgentsMd.Detector'
import { ClaudeDetector } from '@infra/import/Claude.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { ImportScanUseCase } from './ImportScan.Usecase'

describe('ImportScanUseCase — só o AMBIENTE AGÊNTICO do repositório', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-import-scope-'))
  const file = (path: string, body: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  const scanWith = (scope?: IAgenticScope, ignore: string[] = []): IImportScan =>
    new ImportScanUseCase({
      readTree: () => readRepoTree(root, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector(), new AgentsMdDetector(), new ClaudeDetector(), new AgenticToolsDetector()],
      findInCatalog: () => undefined,
      projectIgnore: () => ignore,
      ...(scope ? { projectScope: () => scope } : {}),
    }).execute('alfa', 'repo')
  let scan: IImportScan
  const item = (key: string, from = scan): IInventoryItem => {
    const found = from.items.find((candidate) => candidate.key === key)
    assert.ok(found, `item ${key} não achado em ${from.items.map((one) => one.key).join(', ')}`)
    return found
  }
  const paths = (from: IImportScan) => from.items.flatMap((one) => one.sources.map((source) => source.path))

  before(() => {
    file('.agents/specs/deploy.md', '# Deploy\nVer `packages/framework/nodemon.json` e `scripts/release.yaml`. Não existe: `.agents/specs/sumiu.md`.\n')
    file('.agents/_worktrees/copia/x.md', '# cópia\n')
    file('.claude/agents/revisor.md', '---\nname: revisor\n---\nRevisa.\n')
    file('CLAUDE.md', '# Projeto\n')
    file('AGENTS.md', '# Agentes\n')
    file('GEMINI.md', '# Gemini\n')
    file('.cursorrules', 'Responda em português.\n')
    file('.windsurfrules', 'Seja direto.\n')
    file('.clinerules', 'Teste antes.\n')
    file('.github/copilot-instructions.md', '# Copilot\n')
    file('.github/workflows/ci.yml', 'on: push\n')
    file('.cursor/rules/estilo.mdc', '# Estilo\n')
    file('packages/api/AGENTS.md', '# API\n')
    file('packages/api/GEMINI.md', '# API Gemini\n')
    file('packages/api/src/index.ts', 'export {}\n')
    file('packages/framework/nodemon.json', '{}\n')
    file('packages/framework/specs/interna.md', '# Interna\n')
    file('scripts/release.yaml', 'etapas: []\n')
    file('src/app.ts', 'export {}\n')
    file('docs/extra/guia.md', '# Guia\n')
    scan = scanWith()
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('padrão: só os lugares conhecidos das ferramentas e as entradas nas subpastas; o código do projeto nunca entra', () => {
    const seen = paths(scan)
    for (const path of [
      '.agents/specs/deploy.md',
      '.claude/agents/revisor.md',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.cursor/rules/estilo.mdc',
      'packages/api/AGENTS.md',
      'packages/api/GEMINI.md',
    ])
      assert.ok(seen.includes(path), path)
    for (const path of [
      'packages/api/src/index.ts',
      'packages/framework/nodemon.json',
      'packages/framework/specs/interna.md',
      'scripts/release.yaml',
      'src/app.ts',
      'docs/extra/guia.md',
      '.github/workflows/ci.yml',
    ])
      assert.ok(!seen.includes(path), path)
    assert.ok(!JSON.stringify(scan.items).includes('interna'), 'a subpasta inteira não entra: só a entrada')
    assert.strictEqual(scan.scope?.outside, 7)
    assert.strictEqual(scan.totals.files, 13)
  })

  it('o relatório diz, por lugar padrão, se foi encontrado no repositório', () => {
    const found = scan.scope!.places.filter((place) => place.found).map((place) => place.place)
    assert.deepStrictEqual(found, [
      '.agents/',
      '.claude/',
      'CLAUDE.md',
      'AGENTS.md',
      '.cursor/',
      '.cursorrules',
      '.github/copilot-instructions.md',
      'GEMINI.md',
      '.windsurfrules',
      '.clinerules',
      '**/AGENTS.md',
      '**/GEMINI.md',
    ])
    const opencode = scan.scope!.places.find((place) => place.place === '.opencode/')
    assert.deepStrictEqual(opencode, { place: '.opencode/', enabled: true, found: false, files: 0 })
    assert.ok(scan.scope!.places.every((place) => place.enabled))
    assert.strictEqual(scan.scope!.places.find((place) => place.place === '.agents/')?.files, 2)
  })

  it('a citação para fora do ambiente é só REFERÊNCIA: guarda o caminho, não é quebrada e não vira item', () => {
    const spec = item('spec:deploy')
    assert.deepStrictEqual(
      spec.refs.map((ref) => [ref.path, ref.item]),
      [
        ['packages/framework/nodemon.json', undefined],
        ['scripts/release.yaml', undefined],
      ],
    )
    assert.deepStrictEqual(spec.unresolved, ['.agents/specs/sumiu.md'])
    const note = spec.notes.find((one) => one.code === 'outside-scope')
    assert.strictEqual(note?.level, 'info')
    assert.match(note?.text ?? '', /packages\/framework\/nodemon\.json, scripts\/release\.yaml/)
    assert.ok(!scan.items.some((one) => one.sources.some((source) => source.path === 'scripts/release.yaml')))
  })

  it('as entradas das ferramentas novas saem como a do CLAUDE.md: desconhecido com o motivo cli-entry; o resto da pasta, desconhecido', () => {
    for (const key of [
      'unknown:GEMINI.md',
      'unknown:.cursorrules',
      'unknown:.windsurfrules',
      'unknown:.clinerules',
      'unknown:.github/copilot-instructions.md',
      'unknown:packages/api/GEMINI.md',
    ]) {
      const entry = item(key)
      assert.ok(
        entry.notes.some((note) => note.code === 'cli-entry'),
        key,
      )
      assert.ok(!entry.notes.some((note) => note.code === 'unclassified'), key)
    }
    assert.strictEqual(item('unknown:GEMINI.md').title, 'Gemini')
    assert.ok(item('unknown:packages/api/GEMINI.md').notes.some((note) => note.code === 'scoped'))
    assert.ok(item('unknown:.cursor/rules/estilo.mdc').notes.some((note) => note.code === 'unclassified'))
    assert.ok(scan.formats.includes('agentic-tools'))
  })

  it('desligar um lugar tira o que é dele; o caminho a mais traz o que estava fora', () => {
    const narrowed = scanWith({ disabled: ['.cursor/', '.cursorrules', '**/GEMINI.md'], extra: ['scripts', 'docs/extra/*.md'] })
    const seen = paths(narrowed)
    for (const path of ['.cursor/rules/estilo.mdc', '.cursorrules', 'packages/api/GEMINI.md']) assert.ok(!seen.includes(path), path)
    assert.ok(seen.includes('GEMINI.md'), 'o GEMINI.md da raiz é de outro lugar (Gemini), ainda ligado')
    assert.ok(seen.includes('packages/api/AGENTS.md'))
    const cursor = narrowed.scope!.places.find((place) => place.place === '.cursor/')
    assert.deepStrictEqual(cursor, { place: '.cursor/', enabled: false, found: true, files: 1 }, 'desligado e encontrado')
    assert.deepStrictEqual(narrowed.scope!.extra, [
      { pattern: 'scripts', files: 1 },
      { pattern: 'docs/extra/*.md', files: 1 },
    ])
    // O citado que entrou no ambiente continua referência (sem detector, não tem item), e não é mais "fora".
    const spec = item('spec:deploy', narrowed)
    assert.ok(spec.notes.find((one) => one.code === 'outside-scope')?.text.includes('nodemon.json'))
    assert.ok(!spec.notes.find((one) => one.code === 'outside-scope')?.text.includes('release.yaml'))
  })

  it('o ignorar vale DENTRO do ambiente (o _worktrees, por exemplo)', () => {
    assert.ok(paths(scan).includes('.agents/_worktrees/copia/x.md'))
    const ignored = scanWith(undefined, ['_worktrees'])
    assert.ok(!paths(ignored).includes('.agents/_worktrees/copia/x.md'))
    assert.deepStrictEqual(ignored.ignored.patterns, [{ pattern: '_worktrees', origin: 'project', files: 1 }])
  })
})
