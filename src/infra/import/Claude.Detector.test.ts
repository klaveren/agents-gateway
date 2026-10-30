import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { maskText } from '@domain/Secret.Mask'
import { IImportScan, IInventoryItem } from '@domain/models/ImportInventory.Model'
import { FAKE_TOKEN, writeClaudeFixture } from '../../testing/Import.Fixture'
import { AgentsDirDetector } from './AgentsDir.Detector'
import { AgentsMdDetector } from './AgentsMd.Detector'
import { claudeImports, ClaudeDetector, memoryTitle } from './Claude.Detector'
import { OpencodeDetector } from './Opencode.Detector'
import { readRepoTree } from './Repo.Tree'

describe('Detectores claude e agents-md — o inventário do formato do Claude Code e do AGENTS.md', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-import-claude-'))
  const root = join(base, 'repo')
  const scanWith = (projectIgnore: string[] = [], ignore?: string[]) =>
    new ImportScanUseCase({
      readTree: () => readRepoTree(root, { mask: (text) => maskText(text, []) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector(), new AgentsMdDetector(), new ClaudeDetector()],
      findInCatalog: () => undefined,
      projectIgnore: () => projectIgnore,
    }).execute('alfa', 'repo', ignore ? { ignore } : {})
  let scan: IImportScan
  const item = (key: string, from = scan): IInventoryItem => {
    const found = from.items.find((candidate) => candidate.key === key)
    assert.ok(found, `item ${key} não achado em ${from.items.map((one) => one.key).join(', ')}`)
    return found
  }
  const codes = (key: string) => item(key).notes.map((note) => note.code)

  before(() => {
    mkdirSync(root, { recursive: true })
    writeClaudeFixture(root)
    scan = scanWith()
  })
  after(() => rmSync(base, { recursive: true, force: true }))

  it('reconhece os formatos', () => {
    assert.deepStrictEqual(scan.formats, ['agents-dir', 'agents-md', 'claude'])
  })

  it('.claude/agents: agente pelo name do frontmatter, com o modelo e o alcance pendente', () => {
    const agent = item('agent:revisor-codigo')
    assert.deepStrictEqual(agent.detectors, ['claude'])
    assert.deepStrictEqual(
      agent.sources.map((source) => [source.path, source.role]),
      [['.claude/agents/revisor.md', 'prompt']],
    )
    assert.ok(codes('agent:revisor-codigo').includes('reach-pending'))
  })

  it('.claude/commands: a pasta vira prefixo; allowed-tools não traduz', () => {
    assert.strictEqual(item('command:git-commit').kind, 'command')
    assert.ok(item('command:git-commit').notes.some((note) => note.level === 'untranslatable' && note.code === 'command-allowed-tools'))
  })

  it('.claude/skills → .agents/skills: o item aparece UMA vez, com os dois detectores e o caminho do link como alias', () => {
    assert.strictEqual(scan.items.filter((one) => one.kind === 'skill').length, 1)
    const skill = item('skill:revisar')
    assert.deepStrictEqual(skill.detectors, ['agents-dir', 'claude'])
    const main = skill.sources.find((source) => source.role === 'skill')
    assert.deepStrictEqual([main?.path, main?.aliases], ['.agents/skills/revisar/SKILL.md', ['.claude/skills/revisar/SKILL.md']])
    assert.ok(skill.sources.some((source) => source.path === '.agents/skills/revisar/checklist.md'))
  })

  it('CLAUDE.md da raiz: rule candidata; o que importa de .claude/ é fonte, o resto é citação', () => {
    const rule = item('rule:claude-md')
    assert.deepStrictEqual(rule.detectors, ['claude'])
    assert.strictEqual(rule.title, 'Boot do projeto')
    assert.deepStrictEqual(
      rule.sources.map((source) => [source.path, source.role]),
      [
        ['CLAUDE.md', 'memory'],
        ['.claude/boot.md', 'import'],
      ],
    )
    assert.ok(rule.refs.some((ref) => ref.path === 'AGENTS.md' && ref.item === 'rule:agents-md'))
    assert.ok(codes('rule:claude-md').includes('protocol-complement'))
    assert.ok(codes('rule:claude-md').includes('imports-only'))
    assert.ok(!scan.items.some((one) => one.key === 'unknown:.claude/boot.md'), 'o importado não fica desconhecido')
  })

  it('CLAUDE.md de subpasta: diz a pasta, avisa que não cabe numa rule e não confunde `@` em código com importação', () => {
    const rule = item('rule:pacotes-api-claude-md')
    assert.strictEqual(rule.title, 'Regras da API')
    assert.ok(rule.notes.some((note) => note.code === 'scoped' && note.text.includes('pacotes/api/')))
    assert.ok(codes('rule:pacotes-api-claude-md').includes('over-rule-limit'))
    assert.deepStrictEqual(
      rule.sources.map((source) => source.role),
      ['memory'],
    )
  })

  it('AGENTS.md: rule candidata na raiz e em .agents/ (o desconhecido do agents-dir sai); título fora de comentário', () => {
    const rootRule = item('rule:agents-md')
    assert.deepStrictEqual([rootRule.detectors, rootRule.title], [['agents-md'], 'Instruções do projeto'])
    assert.ok(codes('rule:agents-md').includes('protocol-complement'))
    assert.ok(!codes('rule:agents-md').includes('scoped'))
    const inner = item('rule:agents-agents-md')
    assert.deepStrictEqual(inner.detectors, ['agents-md'])
    assert.ok(!scan.items.some((one) => one.kind === 'unknown' && one.sources.some((source) => source.path === '.agents/AGENTS.md')))
  })

  it('cópia de trabalho do Claude Code fica fora: nem CLAUDE.md nem AGENTS.md de lá viram item', () => {
    assert.ok(!scan.items.some((one) => one.sources.some((source) => source.path.startsWith('.claude/worktrees/'))))
    assert.ok(codes('skip:.claude/worktrees').includes('worktree-copies'))
  })

  it('scripts ficam fora do catálogo; o resto de .claude/ é desconhecido', () => {
    assert.ok(codes('skip:.claude/scripts').includes('out-of-catalog'))
    assert.ok(codes('unknown:.claude/coisa.txt').includes('unclassified'))
  })

  it('settings: permissões, hooks e env viram notas; o MCP do .mcp.json vira item', () => {
    const config = item('config:claude')
    assert.deepStrictEqual(
      config.sources.map((source) => source.path),
      ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'],
    )
    const permissions = config.notes.find((note) => note.code === 'project-permissions-pending')
    assert.match(permissions?.text ?? '', /allow 3, ask 0, deny 1; ferramentas: Bash, Read, WebFetch\)/)
    assert.ok(config.notes.some((note) => note.level === 'untranslatable' && note.code === 'claude-hooks' && note.text.includes('PreToolUse')))
    assert.ok(config.notes.some((note) => note.code === 'settings-env' && note.text.includes('API_URL, GITHUB_TOKEN')))
    assert.ok(codes('config:claude').includes('local-settings'))
    assert.deepStrictEqual([config.refs, config.unresolved], [[], []], 'o argumento da regra não é citação')
    assert.strictEqual(item('mcp:github').detectors[0], 'claude')
  })

  it('⛔ o segredo nunca sai: nem o valor, nem o argumento das regras de permissão', () => {
    const json = JSON.stringify(scan)
    assert.ok(!json.includes(FAKE_TOKEN))
    assert.ok(!json.includes('Authorization') && !json.includes('npm run') && !json.includes('api.x.test'))
    assert.ok(item('config:claude').sources.find((source) => source.path === '.claude/settings.json')?.secret)
  })

  it('ignorar do projeto e da chamada: some do inventário, conta por padrão e o citado não vira referência quebrada', () => {
    assert.ok(scan.items.some((one) => one.sources.some((source) => source.path.startsWith('.agents/benchmark/results/'))))
    const ignored = scanWith(['.agents/benchmark/results/'], ['results', '.agents/benchmark/results'])
    assert.deepStrictEqual(ignored.ignored.patterns, [
      { pattern: '.agents/benchmark/results', origin: 'project', files: 2 },
      { pattern: 'results', origin: 'request', files: 1 },
    ])
    assert.ok(!ignored.items.some((one) => one.sources.some((source) => /(^|\/)results\//.test(source.path))))
    assert.strictEqual(ignored.totals.files, scan.totals.files - 3)
    const rule = item('rule:claude-md', ignored)
    assert.ok(rule.refs.some((ref) => ref.path === '.agents/benchmark/results/run-1.md' && !ref.item))
    assert.deepStrictEqual(rule.unresolved, [])
  })

  it('ignorar o caminho do link tira o alias e o detector, não o arquivo', () => {
    const ignored = scanWith(['.claude/skills/**'])
    const skill = item('skill:revisar', ignored)
    assert.deepStrictEqual(skill.detectors, ['agents-dir'])
    assert.ok(skill.sources.every((source) => source.aliases.length === 0))
    assert.deepStrictEqual(ignored.ignored.patterns, [{ pattern: '.claude/skills/**', origin: 'project', files: 0 }])
  })

  it('importação do Claude Code: só o que tem cara de arquivo, fora de código', () => {
    assert.deepStrictEqual(claudeImports('@AGENTS.md e @docs/x.md.\n`@nao.md`\n```\n@tambem-nao.md\n```\n@fulano @types/node a@b.com'), ['AGENTS.md', 'docs/x.md'])
    assert.strictEqual(memoryTitle('<!--\n# carimbo\n-->\n# Título'), 'Título')
  })
})
