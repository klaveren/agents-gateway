import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { maskText } from '@domain/Secret.Mask'
import { IImportScan, IInventoryItem } from '@domain/models/ImportInventory.Model'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { catalogFinder, ImportScanUseCase } from './ImportScan.Usecase'
import { FAKE_TOKEN, gitInit, writeFixture } from '../testing/Import.Fixture'

describe('ImportScanUseCase — o inventário de um repositório (só leitura)', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-import-scan-'))
  const root = join(base, 'repo')
  const outside = join(base, 'fora')
  let scan: IImportScan
  const item = (key: string): IInventoryItem => {
    const found = scan.items.find((candidate) => candidate.key === key)
    assert.ok(found, `item ${key} não achado em ${scan.items.map((one) => one.key).join(', ')}`)
    return found
  }

  before(() => {
    mkdirSync(root, { recursive: true })
    writeFixture(root, outside)
    gitInit(root)
    writeFileSync(join(root, 'sujo.md'), 'não commitado\n')
    const usecase = new ImportScanUseCase({
      readTree: () => readRepoTree(root, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector()],
      findInCatalog: catalogFinder({
        doc: (id) => (id === 'arquitetura' ? { projectId: 'outro' } : id === 'filas' ? { projectId: 'alfa' } : undefined),
        resource: (id) => (id === 'revisar' ? {} : undefined),
        rules: (scope) => (scope === null ? [{ title: 'Regras do projeto' }] : []),
        agent: (id) => (id === 'maya' ? { projectId: 'alfa', triggers: [{ id: '01-delegar' }] } : undefined),
        mcpServer: (id) => id === 'github',
      }),
      now: () => new Date('2026-10-30T12:00:00Z'),
    })
    scan = usecase.execute('alfa', 'repo')
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  it('reconhece os dois formatos, o HEAD e a árvore suja', () => {
    assert.deepStrictEqual(scan.formats, ['agents-dir', 'opencode'])
    assert.match(scan.head ?? '', /^[0-9a-f]{40}$/)
    assert.strictEqual(scan.dirty, true)
  })

  it('classifica cada tipo do .agents/', () => {
    assert.strictEqual(item('agent:maya').kind, 'agent')
    assert.strictEqual(item('trigger:maya/01-delegar').parent, 'agent:maya')
    assert.strictEqual(item('skill:revisar').kind, 'skill')
    assert.strictEqual(item('command:deploy').kind, 'command')
    assert.strictEqual(item('spec:arquitetura').kind, 'spec')
    assert.strictEqual(item('adr:0001-usar-sqlite').kind, 'adr')
    assert.strictEqual(item('knowledge:filas').kind, 'knowledge')
    assert.strictEqual(item('rule:regras-do-projeto').title, 'Regras do projeto')
    assert.strictEqual(item('skip:README.md').notes[0].code, 'index')
    assert.strictEqual(item('unknown:misc/coisa.txt').notes.at(-1)?.code, 'unclassified')
    assert.ok(item('skip:.agents/agents/maya/memory').notes.some((note) => note.code === 'out-of-catalog'))
    assert.ok(item('skip:.agents/agents/maya/scripts').sources.every((source) => !source.path.includes('node_modules')))
  })

  it('o que não traduz é marcado: trigger de skill e agent: de command', () => {
    assert.ok(item('skill:revisar').notes.some((note) => note.level === 'untranslatable' && note.code === 'skill-triggers'))
    assert.ok(item('command:deploy').notes.some((note) => note.level === 'untranslatable' && note.code === 'command-agent'))
  })

  it('opencode: agente, command, mcp e a configuração; o {file:} liga o bloco à pasta do agente', () => {
    const maya = item('agent:maya')
    assert.deepStrictEqual(maya.detectors, ['agents-dir', 'opencode'])
    assert.ok(maya.sources.some((source) => source.path === 'opencode.json' && source.role === 'opencode'))
    assert.ok(maya.sources.some((source) => source.path === '.agents/agents/maya/bootstrap.md'))
    assert.ok(maya.notes.some((note) => note.code === 'field-conflict' && note.text.includes('modelo-a') && note.text.includes('modelo-b')))
    assert.ok(maya.notes.some((note) => note.code === 'reach'))
    // Nome diferente: o `{file:}` aponta um arquivo gerado das fontes da Lia, e o bloco entra no agente da pasta.
    const lia = item('agent:lia')
    assert.deepStrictEqual(lia.detectors, ['agents-dir', 'opencode'])
    assert.ok(lia.sources.some((source) => source.path === 'prompts/lia.md' && source.role === 'prompt'))
    assert.ok(lia.notes.some((note) => note.code === 'merged' && note.text.includes('assistente-lia')))
    assert.ok(!scan.items.some((one) => one.key === 'agent:assistente-lia'))
    assert.deepStrictEqual(item('agent:revisor').unresolved, ['./prompts/nao-existe.md'])
    assert.strictEqual(item('agent:helper').detectors[0], 'opencode')
    assert.strictEqual(item('command:build').kind, 'command')
    assert.strictEqual(item('mcp:github').catalog, 'global')
    const config = item('config:opencode')
    assert.ok(config.refs.some((ref) => ref.path === 'docs/guia.md' && !ref.item))
    assert.ok(config.notes.some((note) => note.code === 'project-permissions'))
  })

  it('link para dentro deduplica: o command aparece uma vez, com o caminho do link como alias', () => {
    const deploy = item('command:deploy')
    assert.deepStrictEqual(deploy.detectors, ['agents-dir', 'opencode'])
    assert.deepStrictEqual(
      deploy.sources.map((source) => [source.path, source.aliases]),
      [['.agents/commands/deploy.md', ['.opencode/command/deploy.md']]],
    )
    assert.strictEqual(scan.items.filter((one) => one.kind === 'command' && one.candidateId === 'deploy').length, 1)
  })

  it('⛔ link para fora é recusado e nunca lido; node_modules, .git e binário são ignorados', () => {
    assert.deepStrictEqual(
      scan.ignored.links.map((link) => [link.path, link.reason]),
      [
        ['arquivo-fora.md', 'outside'],
        ['link-fora', 'outside'],
      ],
    )
    const json = JSON.stringify(scan)
    assert.ok(!json.includes('de fora') && !json.includes('segredo.md') && !json.includes(outside), 'nada de fora aparece')
    assert.strictEqual(scan.ignored.dirs.node_modules, 2)
    assert.strictEqual(scan.ignored.dirs['.git'], 1)
    assert.deepStrictEqual(scan.ignored.binaries, ['.agents/agents/maya/avatar.png'])
    assert.ok(!scan.items.some((one) => one.sources.some((source) => source.path.includes('node_modules'))))
  })

  it('arquivo gerado é marcado, com as fontes que declara', () => {
    const bootstrap = item('agent:maya').sources.find((source) => source.path === '.agents/agents/maya/bootstrap.md')
    assert.deepStrictEqual(bootstrap?.generated, ['.agents/agents/maya/soul.md', '.agents/agents/maya/identity.md'])
    assert.ok(item('agent:maya').notes.some((note) => note.code === 'generated'))
  })

  it('⛔ segredo é marcado e o conteúdo nunca sai', () => {
    const config = item('spec:config')
    assert.strictEqual(config.sources[0].secret, true)
    assert.ok(config.notes.some((note) => note.code === 'secret'))
    assert.ok(!JSON.stringify(scan).includes(FAKE_TOKEN))
    assert.match(config.sources[0].sha256, /^[0-9a-f]{64}$/)
  })

  it('referências cruzadas: achadas viram vínculo com o item; as quebradas ficam à parte', () => {
    const maya = item('agent:maya')
    assert.ok(maya.refs.some((ref) => ref.path === '.agents/specs/arquitetura.md' && ref.item === 'spec:arquitetura'))
    assert.ok(
      maya.refs.some((ref) => ref.path === '.agents/knowledge/filas.md' && ref.item === 'knowledge:filas'),
      'a dependência do YAML',
    )
    assert.deepStrictEqual(maya.unresolved, ['.agents/specs/inexistente.md'])
    assert.ok(maya.notes.some((note) => note.code === 'broken-ref'))
    assert.deepStrictEqual(item('skill:revisar').refs, [{ path: '.agents/specs/arquitetura.md', item: 'spec:arquitetura' }])
    assert.deepStrictEqual(item('trigger:maya/01-delegar').refs, [{ path: '.agents/skills/revisar/SKILL.md', item: 'skill:revisar' }])
  })

  it('colisão de id com o catálogo: mesmo projeto, global e outro projeto (este é conflito)', () => {
    assert.strictEqual(item('agent:maya').catalog, 'same-project')
    assert.strictEqual(item('trigger:maya/01-delegar').catalog, 'same-project')
    assert.strictEqual(item('knowledge:filas').catalog, 'same-project')
    assert.strictEqual(item('skill:revisar').catalog, 'global')
    assert.strictEqual(item('rule:regras-do-projeto').catalog, 'global')
    assert.strictEqual(item('spec:arquitetura').catalog, 'other-project')
    assert.ok(item('spec:arquitetura').notes.some((note) => note.code === 'id-conflict'))
    assert.strictEqual(item('command:deploy').catalog, 'new')
    assert.strictEqual(item('unknown:misc/coisa.txt').catalog, undefined)
  })

  it('mede as fontes e soma os totais', () => {
    const spec = item('spec:arquitetura').sources[0]
    assert.deepStrictEqual([spec.bytes, spec.tokens], [14, 4])
    assert.strictEqual(scan.totals.items, scan.items.length)
    assert.ok(scan.totals.tokens > 0)
    assert.strictEqual(scan.totals.byKind.spec, 2)
  })
})

describe('ImportScanUseCase — citação que não é referência quebrada', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-import-refs-'))
  let scan: IImportScan
  const file = (path: string, body: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }

  before(() => {
    file('.agents/specs/core/anatomia.md', '# Anatomia\n')
    file('.agents/skills/a/SKILL.md', '# A\n')
    file('.agents/skills/b/SKILL.md', '# B\n')
    file('.agents/agents/maya/soul.md', 'A alma.\n')
    file(
      '.agents/agents/maya/triggers/01-ler.md',
      [
        '# Ler',
        'Siga `anatomia.md` e a `soul.md`. Não existe: `.agents/specs/sumiu.md`.',
        'Padrões: `{alias}-memory.md`, `<nome>-soul.md`, `*.gen.md`, `IMP-XXX.md`, `-02.md`.',
        'Fora: /Users/ana/notas.md. Ambíguo: SKILL.md. Código: r.json().',
        '```',
        '├── exemplo-que-nao-existe.md',
        'cat .agents/specs/core/anatomia.md',
        '```',
      ].join('\n'),
    )
    const usecase = new ImportScanUseCase({
      readTree: () => readRepoTree(root, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector()],
      findInCatalog: () => undefined,
    })
    scan = usecase.execute('alfa', 'repo')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  const trigger = () => {
    const found = scan.items.find((item) => item.key === 'trigger:maya/01-ler')
    assert.ok(found, scan.items.map((item) => item.key).join(', '))
    return found
  }

  it('citação real que não existe continua quebrada (e só ela)', () => {
    assert.deepStrictEqual(trigger().unresolved, ['.agents/specs/sumiu.md'])
    assert.ok(trigger().notes.some((note) => note.code === 'broken-ref' && note.level === 'attention'))
  })

  it('pelo nome e subindo as pastas: vira vínculo, e o "pelo nome" fica dito', () => {
    assert.ok(trigger().refs.some((ref) => ref.path === '.agents/specs/core/anatomia.md' && ref.item === 'spec:core-anatomia'))
    assert.ok(trigger().refs.some((ref) => ref.path === '.agents/agents/maya/soul.md'))
    const named = trigger().notes.find((note) => note.code === 'ref-by-name')
    assert.strictEqual(named?.level, 'info')
    assert.match(named?.text ?? '', /anatomia\.md → \.agents\/specs\/core\/anatomia\.md/)
  })

  it('o resto vira UMA nota de nível baixo, com a contagem por motivo', () => {
    const ignored = trigger().notes.filter((note) => note.code === 'ignored-ref')
    assert.strictEqual(ignored.length, 1)
    assert.strictEqual(ignored[0].level, 'info')
    const counts = Object.fromEntries([...ignored[0].text.matchAll(/(\d+) ([^(;:]+?) \(/g)].map((match) => [match[2], Number(match[1])]))
    assert.deepStrictEqual(counts, { 'em exemplo': 1, marcador: 3, 'padrão glob': 1, 'sufixo solto': 1, 'nome ambíguo': 1, 'fora do repositório': 1, código: 1 })
    assert.match(ignored[0].text, /exemplo-que-nao-existe\.md/)
    assert.match(ignored[0].text, /\/Users\/ana\/notas\.md/)
  })
})
