import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InvalidGuidanceError } from '@domain/errors/Domain.Error'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { GuidanceService } from './Guidance.Service'

// O projeto beta USA o que o alfa compartilha, só para leitura: skill, command, spec e conhecimento (nunca ADR).
describe('GuidanceService — o agente do projeto que recebe usa o item compartilhado', () => {
  const agents: Record<string, { id: string; projectId?: string }> = {
    'dev-beta': { id: 'dev-beta', projectId: 'beta' },
    'dev-gama': { id: 'dev-gama', projectId: 'gama' },
    'dev-alfa': { id: 'dev-alfa', projectId: 'alfa' },
    atlas: { id: 'atlas' },
  }
  const seeded = () => {
    const service = new GuidanceService(
      new SqliteGuidanceRepository(':memory:'),
      (id) => ['alfa', 'beta', 'gama'].includes(id),
      (id) => agents[id],
    )
    const doc = (id: string, kind: 'spec' | 'knowledge' | 'adr') =>
      service.createDoc({ id, kind, title: `T ${id}`, summary: `resumo ${id}`, body: `corpo de ${id} cobalto`, projectId: 'alfa' }, 'root')
    doc('spec-alfa', 'spec')
    doc('saber-alfa', 'knowledge')
    doc('adr-alfa', 'adr')
    doc('anexo-privado', 'spec')
    service.createResource({ id: 'skill-alfa', kind: 'skill', projectId: 'alfa', description: 'Skill do alfa', body: 'Passos da skill.', docIds: ['anexo-privado'] }, 'root')
    service.createResource({ id: 'cmd-alfa', kind: 'command', projectId: 'alfa', description: 'Command do alfa', body: 'Faça $ARGUMENTS.' }, 'root')
    return service
  }
  const share = (service: GuidanceService, projects = ['beta']) => {
    for (const id of ['spec-alfa', 'saber-alfa']) service.shareDoc(id, projects, 'root')
    for (const id of ['skill-alfa', 'cmd-alfa']) service.shareResource(id, projects, 'root')
  }
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort()

  it('compartilhado com beta: skill e command aparecem para o agente de beta (uso, busca, índice, carga e /command)', () => {
    const service = seeded()
    share(service)
    assert.deepStrictEqual(ids(service.usableResources('skill', 'dev-beta')), ['skill-alfa'])
    assert.deepStrictEqual(ids(service.usableResources('command', 'dev-beta')), ['cmd-alfa'])
    assert.strictEqual(service.hasResources('dev-beta'), true)
    assert.deepStrictEqual(ids(service.searchResources('alfa', undefined, 'dev-beta')), ['cmd-alfa', 'skill-alfa'])
    assert.match(service.loadResource('skill', 'skill-alfa', 'dev-beta')!, /Passos da skill/)
    assert.match(service.environmentFor('beta', 'dev-beta')!, /skill-alfa/)
    assert.match(service.expandCommand('/cmd-alfa limpar', 'dev-beta', 'beta')!.text, /Faça limpar/)
  })

  it('⛔ sem compartilhar não aparece; compartilhado com beta não chega ao gama nem ao agente global', () => {
    const service = seeded()
    assert.deepStrictEqual(service.usableResources('skill', 'dev-beta'), [])
    assert.throws(() => service.expandCommand('/cmd-alfa', 'dev-beta', 'beta'), /not enabled for this agent/)
    assert.strictEqual(service.loadResource('skill', 'skill-alfa', 'dev-beta'), undefined)
    share(service)
    assert.deepStrictEqual(service.usableResources('skill', 'dev-gama'), [])
    assert.deepStrictEqual(service.usableResources('skill', 'atlas'), [])
    assert.strictEqual(service.readDoc('spec-alfa', 'gama'), undefined)
    assert.deepStrictEqual(service.searchDocs('cobalto', 'gama'), [])
  })

  it('⛔ o anexo PRIVADO da skill compartilhada não vaza para beta; o dono continua vendo', () => {
    const service = seeded()
    share(service)
    assert.doesNotMatch(service.loadResource('skill', 'skill-alfa', 'dev-beta')!, /corpo de anexo-privado/)
    assert.strictEqual(service.attachedDoc('anexo-privado', 'dev-beta', 'beta'), undefined)
    assert.match(service.loadResource('skill', 'skill-alfa', 'dev-alfa')!, /corpo de anexo-privado/)
    // Compartilhado o anexo também, ele chega.
    service.shareDoc('anexo-privado', ['beta'], 'root')
    assert.match(service.loadResource('skill', 'skill-alfa', 'dev-beta')!, /corpo de anexo-privado/)
  })

  it('spec e conhecimento compartilhados: read_doc, busca, índice; ADR do alfa nunca', () => {
    const service = seeded()
    assert.strictEqual(service.readDoc('spec-alfa', 'beta'), undefined)
    share(service)
    assert.strictEqual(service.readDoc('spec-alfa', 'beta')?.id, 'spec-alfa')
    assert.strictEqual(service.readDoc('saber-alfa', 'beta')?.id, 'saber-alfa')
    assert.strictEqual(service.readDoc('adr-alfa', 'beta'), undefined)
    assert.deepStrictEqual(ids(service.searchDocs('cobalto', 'beta')), ['saber-alfa', 'spec-alfa'])
    assert.deepStrictEqual(ids(service.searchDocs('cobalto', 'beta', 'knowledge')), ['saber-alfa'])
    assert.strictEqual(service.hasDocs('beta', 'dev-beta'), true)
    const environment = service.environmentFor('beta', 'dev-beta')!
    assert.match(environment, /spec-alfa/)
    assert.doesNotMatch(environment, /adr-alfa/)
    assert.match(service.expandCommand('/spec:spec-alfa pedido', 'dev-beta', 'beta')!.text, /corpo de spec-alfa/)
  })

  it('⛔ nem um sharedWith forjado num ADR faz o ADR entrar em beta', () => {
    const repository = new SqliteGuidanceRepository(':memory:')
    const service = new GuidanceService(repository, (id) => ['alfa', 'beta'].includes(id))
    service.createDoc({ id: 'adr-forjado', kind: 'adr', title: 'x', summary: 'x', body: 'cobalto', projectId: 'alfa' }, 'root')
    repository.updateDoc('adr-forjado', { sharedWith: ['beta'] })
    assert.strictEqual(service.readDoc('adr-forjado', 'beta'), undefined)
    assert.deepStrictEqual(ids(service.searchDocs('cobalto', 'beta')), [])
  })

  it('contexto inicial do projeto e do agente aceitam a spec compartilhada; a de quem não compartilhou, não', () => {
    const service = seeded()
    assert.throws(() => service.setInitialContext('beta', ['spec-alfa'], 'root'), InvalidGuidanceError)
    share(service)
    assert.deepStrictEqual(
      service.setInitialContext('beta', ['spec-alfa'], 'root').docs.map((item) => item.id),
      ['spec-alfa'],
    )
    assert.deepStrictEqual(ids(service.initialContext('beta')), ['spec-alfa'])
    assert.match(service.environmentFor('beta', 'dev-beta')!, /Specs do projeto/)
    assert.deepStrictEqual(service.contextIssues('beta', ['spec-alfa']), [])
    // Só spec vai inteira no prompt; ADR do alfa, nunca; o gama não recebeu.
    assert.throws(() => service.setInitialContext('beta', ['saber-alfa'], 'root'), InvalidGuidanceError)
    assert.throws(() => service.setInitialContext('beta', ['adr-alfa'], 'root'), InvalidGuidanceError)
    assert.throws(() => service.setInitialContext('gama', ['spec-alfa'], 'root'), InvalidGuidanceError)
    assert.deepStrictEqual(
      service.setAgentContext('dev-beta', ['spec-alfa'], 'root').docs.map((item) => item.id),
      ['spec-alfa'],
    )
    assert.throws(() => service.setAgentContext('dev-gama', ['spec-alfa'], 'root'), InvalidGuidanceError)
    assert.throws(() => service.setAgentContext('atlas', ['spec-alfa'], 'root'), InvalidGuidanceError)
  })

  it('liberar ao agente de beta a skill/command compartilhada vale; a de quem não compartilhou e o agente global, não', () => {
    const service = seeded()
    assert.throws(() => service.setAgentResources('dev-beta', { skills: ['skill-alfa'] }, 'root'), /belongs to another project/)
    share(service)
    assert.deepStrictEqual(service.setAgentResources('dev-beta', { skills: ['skill-alfa'], commands: ['cmd-alfa'] }, 'root'), { skills: ['skill-alfa'], commands: ['cmd-alfa'] })
    assert.deepStrictEqual(service.agentLinkIssues('beta', { resources: { skills: ['skill-alfa'], commands: [] }, initialContext: ['spec-alfa'] }), [])
    assert.throws(() => service.setAgentResources('dev-gama', { skills: ['skill-alfa'] }, 'root'), /belongs to another project/)
    assert.throws(() => service.setAgentResources('atlas', { skills: ['skill-alfa'] }, 'root'), /global agent uses only global resources/)
  })

  it('um doc de beta anexa a spec compartilhada; o do gama e o ADR do alfa, não', () => {
    const service = seeded()
    share(service)
    service.createDoc({ id: 'doc-beta', kind: 'spec', title: 'B', summary: 'b', body: 'b', projectId: 'beta', docIds: ['spec-alfa'] }, 'root')
    assert.match(service.docText(service.doc('doc-beta'), 'beta'), /corpo de spec-alfa/)
    assert.throws(
      () => service.createDoc({ id: 'doc-gama', kind: 'spec', title: 'G', summary: 'g', body: 'g', projectId: 'gama', docIds: ['spec-alfa'] }, 'root'),
      InvalidGuidanceError,
    )
    assert.throws(
      () => service.createDoc({ id: 'doc-adr', kind: 'spec', title: 'G', summary: 'g', body: 'g', projectId: 'beta', docIds: ['adr-alfa'] }, 'root'),
      InvalidGuidanceError,
    )
  })

  it('⛔ parar de compartilhar (ou apagar) tira do agente; a referência gravada fica e é ignorada, e volta se voltar a compartilhar', () => {
    const service = seeded()
    share(service)
    service.setAgentResources('dev-beta', { skills: ['skill-alfa'], commands: ['cmd-alfa'] }, 'root')
    service.setInitialContext('beta', ['spec-alfa'], 'root')
    share(service, [])
    assert.deepStrictEqual(service.usableResources('skill', 'dev-beta'), [])
    assert.strictEqual(service.loadResource('skill', 'skill-alfa', 'dev-beta'), undefined)
    assert.throws(() => service.expandCommand('/cmd-alfa', 'dev-beta', 'beta'), /not enabled for this agent/)
    assert.strictEqual(service.readDoc('spec-alfa', 'beta'), undefined)
    assert.deepStrictEqual(service.searchDocs('cobalto', 'beta'), [])
    assert.deepStrictEqual(service.initialContext('beta'), [])
    assert.doesNotMatch(service.environmentFor('beta', 'dev-beta') ?? '', /alfa/)
    // A marca continua gravada.
    assert.deepStrictEqual(service.agentResources('dev-beta'), { skills: ['skill-alfa'], commands: ['cmd-alfa'] })
    share(service)
    assert.deepStrictEqual(ids(service.usableResources('skill', 'dev-beta')), ['skill-alfa'])
    assert.deepStrictEqual(ids(service.initialContext('beta')), ['spec-alfa'])
    service.deleteResource('skill-alfa', 'root')
    assert.deepStrictEqual(service.usableResources('skill', 'dev-beta'), [])
  })
})
