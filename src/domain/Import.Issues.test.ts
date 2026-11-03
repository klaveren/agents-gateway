import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { TCanonicalValue } from './Catalog.Document'
import { withBody } from './Catalog.Import'
import { ILinkWorld, restoreImportLinks, withImportIssues } from './Import.Issues'

const world = (overrides: Partial<ILinkWorld> = {}): ILinkWorld => ({
  projectId: 'alfa',
  writtenDocs: new Map([['arq', 'spec']]),
  writtenResources: new Map([['revisar', 'skill']]),
  catalogDoc: (id) => ({ adr1: { kind: 'adr' }, beta: { kind: 'spec', projectId: 'beta' } })[id],
  catalogResource: () => undefined,
  pendingDoc: (id) => id === 'depois',
  otherKind: (id) => (id === 'pm' ? 'agent' : undefined),
  agentExists: (id) => id === 'pm',
  mcpExists: (id, projectId) => id === 'github' || (id === 'jira' && projectId === 'alfa'),
  ...overrides,
})

describe('Import.Issues — os vínculos que não bloqueiam', () => {
  it('o agente: contexto inicial só com spec do escopo; a skill que falta sai de `resources` e vira problema', () => {
    const agent = withBody(
      { kind: 'agent', id: 'maya', projectId: 'alfa' },
      { id: 'maya', projectId: 'alfa', initialContext: ['arq', 'adr1', 'beta', 'depois'], resources: { skills: ['revisar', 'falta'], commands: ['*'] } },
    )
    const out = withImportIssues(agent, world())
    assert.deepStrictEqual(out.body.initialContext, ['arq'])
    assert.deepStrictEqual(out.body.resources, { skills: ['revisar'], commands: ['*'] })
    assert.deepStrictEqual(
      (out.body.importIssues as Array<{ code: string; target: string }>).map((one) => [one.code, one.target]),
      [
        ['link-not-spec', 'adr1'],
        ['link-scope', 'beta'],
        ['link-pending', 'depois'],
        ['skill-missing', 'falta'],
      ],
    )
  })

  it('sem problema, o documento não ganha `importIssues` (o hash fica o mesmo)', () => {
    const doc = withBody({ kind: 'spec', id: 'guia', projectId: 'alfa' }, { id: 'guia', projectId: 'alfa', docIds: ['arq'], docRefs: ['arq'] })
    assert.strictEqual(withImportIssues(doc, world()).hash, doc.hash)
  })

  it('a volta: o vínculo no fim da lista (e em `docRefs`, se era por referência); com `*`, só o problema sai', () => {
    const issues = [
      { code: 'link-pending', message: 'x', target: 'depois', link: 'reference' },
      { code: 'link-missing', message: 'y', target: 'nada', link: 'attach' },
    ]
    const doc = withBody({ kind: 'spec', id: 'guia', projectId: 'alfa' }, { id: 'guia', projectId: 'alfa', docIds: ['arq'], importIssues: issues })
    const back = restoreImportLinks(doc, { docs: new Set(['depois']), skills: new Set(), commands: new Set(), agents: new Set(), mcps: new Set() })!
    assert.deepStrictEqual([back.body.docIds, back.body.docRefs, back.body.importIssues], [['arq', 'depois'], ['depois'], [issues[1]]])
    assert.strictEqual(restoreImportLinks(doc, { docs: new Set(['nada']), skills: new Set(), commands: new Set(), agents: new Set(), mcps: new Set() }), undefined)

    const agent = withBody(
      { kind: 'agent', id: 'maya', projectId: 'alfa' },
      { id: 'maya', resources: { skills: ['*'], commands: [] }, importIssues: [{ code: 'skill-missing', message: 'z', target: 'revisar', link: 'skill' }] },
    )
    const granted = restoreImportLinks(agent, { docs: new Set(), skills: new Set(['revisar']), commands: new Set(), agents: new Set(), mcps: new Set() })!
    assert.deepStrictEqual([granted.body.resources, granted.body.importIssues], [{ skills: ['*'], commands: [] }, undefined])
  })

  it('o alcance que cita o que não existe: a liberação exata sai e fica guardada; negar, curinga, `cap:` e arquivo ficam', () => {
    const permissions: Array<Record<string, string>> = [
      { category: 'delegate', pattern: 'agent-sre', decision: 'allow', note: 'alvo ainda não importado' },
      { category: 'delegate', pattern: 'pm', decision: 'allow' },
      { category: 'delegate', pattern: 'agent-*', decision: 'allow' },
      { category: 'delegate', pattern: 'agent-velho', decision: 'deny' },
      { category: 'mcp', pattern: 'fantasma/buscar', decision: 'allow' },
      { category: 'mcp', pattern: 'fantasma/*', decision: 'allow' },
      { category: 'mcp', pattern: 'jira/criar', decision: 'allow' },
      { category: 'mcp', pattern: '*', decision: 'allow' },
      { category: 'terminal', pattern: 'git status', decision: 'allow' },
      { category: 'read', pattern: 'src/**', decision: 'allow' },
    ]
    const allowedTools = ['cap:terminal', 'agent:pm', 'agent:sumido', 'mcp:fantasma/buscar', 'mcp:github/issues', 'mcp:jira/criar']
    const agent = withBody({ kind: 'agent', id: 'adm', projectId: 'alfa' }, { id: 'adm', projectId: 'alfa', permissions, allowedTools })
    const out = withImportIssues(agent, world())
    assert.deepStrictEqual(
      (out.body.permissions as Array<{ pattern: string }>).map((rule) => rule.pattern),
      ['pm', 'agent-*', 'agent-velho', 'jira/criar', '*', 'git status', 'src/**'],
    )
    assert.deepStrictEqual(out.body.allowedTools, ['cap:terminal', 'agent:pm', 'mcp:github/issues', 'mcp:jira/criar'])
    const issues = out.body.importIssues as unknown as Array<{ code: string; target: string; link: string; message: string; rules?: unknown[]; tools?: string[] }>
    assert.deepStrictEqual(
      issues.map((one) => [one.code, one.target, one.link, one.rules, one.tools]),
      [
        ['delegate-missing', 'agent-sre', 'reach', [permissions[0]], undefined],
        ['mcp-missing', 'fantasma', 'reach', [permissions[4], permissions[5]], ['mcp:fantasma/buscar']],
        ['delegate-missing', 'sumido', 'reach', undefined, ['agent:sumido']],
      ],
    )
    assert.match(issues[0].message, /^permite delegar a agent-sre, que ainda não existe/)
    // ⚖️ O MCP do projeto vale só para o agente do projeto: o global não o enxerga.
    const global = withImportIssues(withBody({ kind: 'agent', id: 'g' }, { id: 'g', permissions: [permissions[6]], allowedTools: [] }), world())
    assert.deepStrictEqual(
      (global.body.importIssues as unknown as Array<{ code: string; target: string }>).map((one) => [one.code, one.target]),
      [['mcp-missing', 'jira']],
    )
  })

  it('a volta do alcance: as regras exatas (sem a nota "alvo ainda não importado") e as ferramentas, só do alvo gravado', () => {
    const rule = { category: 'delegate', pattern: 'agent-sre', decision: 'allow', note: 'alvo ainda não importado' }
    const mcpRule = { category: 'mcp', pattern: 'fantasma/buscar', decision: 'allow', note: 'da origem' }
    const issues: Array<Record<string, TCanonicalValue>> = [
      { code: 'delegate-missing', message: 'a', target: 'agent-sre', link: 'reach', rules: [rule] },
      { code: 'mcp-missing', message: 'b', target: 'fantasma', link: 'reach', rules: [mcpRule], tools: ['mcp:fantasma/buscar'] },
    ]
    const agent = withBody(
      { kind: 'agent', id: 'adm', projectId: 'alfa' },
      { id: 'adm', projectId: 'alfa', permissions: [{ category: 'terminal', pattern: 'ls', decision: 'allow' }], allowedTools: ['cap:terminal'], importIssues: issues },
    )
    const none = { docs: new Set<string>(), skills: new Set<string>(), commands: new Set<string>() }
    const sre = restoreImportLinks(agent, { ...none, agents: new Set(['agent-sre']), mcps: new Set() })!
    assert.deepStrictEqual(
      [sre.body.permissions, sre.body.allowedTools, (sre.body.importIssues as unknown as Array<{ code: string }>).map((one) => one.code)],
      [
        [
          { category: 'terminal', pattern: 'ls', decision: 'allow' },
          { category: 'delegate', pattern: 'agent-sre', decision: 'allow' },
        ],
        ['cap:terminal'],
        ['mcp-missing'],
      ],
    )
    const both = restoreImportLinks(agent, { ...none, agents: new Set(['agent-sre']), mcps: new Set(['fantasma']) })!
    assert.deepStrictEqual([(both.body.permissions as unknown[]).length, both.body.allowedTools, both.body.importIssues], [3, ['cap:terminal', 'mcp:fantasma/buscar'], undefined])
    assert.deepStrictEqual((both.body.permissions as unknown[])[2], mcpRule)
    assert.strictEqual(restoreImportLinks(agent, { ...none, agents: new Set(['outro']), mcps: new Set() }), undefined)
  })
})
