import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentDocument, docDocument, ICatalogDocument, mcpDocument, projectDocument, resourceDocument } from '@domain/Catalog.Document'
import { withBody } from '@domain/Catalog.Import'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import {
  CatalogImportBlockedError,
  CatalogPlanChangedError,
  CatalogPrivilegedMcpError,
  CatalogShareForbiddenError,
  CatalogWideningConfirmationError,
  CatalogWideningForbiddenError,
} from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { buildCatalogStack } from '../testing/Catalog.Fixture'
import { IRestoreCaller } from './CatalogRestore.Usecase'

const at = new Date('2026-10-30T12:00:00.000Z')
const ADMIN: IRestoreCaller = { by: 'root@x.test', viaAccessToken: false }
const CI: IRestoreCaller = { by: 'ci@x.test', viaAccessToken: true }

const spec = (id: string, body = 'Corpo', projectId?: string) =>
  docDocument({ id, kind: 'spec', ...(projectId ? { projectId } : {}), title: id.toUpperCase(), summary: 'S', body, docIds: [], createdAt: at, updatedAt: at })
const skill = (id: string, docIds: string[] = [], projectId?: string) =>
  resourceDocument({ id, kind: 'skill', ...(projectId ? { projectId } : {}), description: 'D', body: 'Corpo', docIds, createdAt: at, updatedAt: at })
const agent = (patch: Partial<IAgent> & { id: string }, links = { resources: { skills: ['*'], commands: ['*'] }, initialContext: [] as string[] }) =>
  agentDocument(
    {
      name: patch.id.toUpperCase(),
      providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
      systemPrompt: `Prompt de ${patch.id}`,
      modes: [EMode.CHAT],
      allowedTools: [],
      ...patch,
    },
    links,
  )

/** Espera a recusa do tipo dado e a devolve. */
async function refused<T extends Error>(work: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await work
  } catch (error: unknown) {
    assert.ok(error instanceof type, `esperava ${type.name}, veio ${String(error)}`)
    return error as T
  }
  throw new assert.AssertionError({ message: `esperava ${type.name}, mas aplicou` })
}

describe('CatalogImportApplier — aplicar o import', () => {
  it('create e update na ordem do plano, cada escrita com revisão import/import dentro de UM lote applied', async () => {
    const stack = buildCatalogStack()
    stack.guidance.createDoc({ id: 'guia', kind: 'spec', title: 'GUIA', summary: 'S', body: 'v1' }, 'ana')
    const documents = [skill('tabela', ['guia', 'novo']), spec('novo'), withBody(stack.reader.read('spec', 'guia')!, { ...stack.reader.read('spec', 'guia')!.body, body: 'v2' })]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => step.ref),
      ['spec/guia', 'spec/novo', 'skill/tabela'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)

    assert.strictEqual(stack.guidance.doc('guia').body, 'v2')
    assert.deepStrictEqual(stack.guidance.resource('tabela').docIds, ['guia', 'novo'])
    assert.strictEqual(result.batch?.status, 'applied')
    assert.strictEqual(result.batch?.kind, 'import')
    assert.strictEqual(result.failed, undefined)
    assert.deepStrictEqual(
      result.applied.map((step) => [step.ref, step.op, step.revision]),
      [
        ['spec/guia', 'update', 2],
        ['spec/novo', 'create', 1],
        ['skill/tabela', 'create', 1],
      ],
    )
    const revisions = stack.repository.batchRevisions(result.batch!.id)
    assert.deepStrictEqual(
      revisions.map((revision) => [`${revision.kind}/${revision.itemId}`, revision.op, revision.source, revision.by]),
      [
        ['spec/guia', 'import', 'import', 'root@x.test'],
        ['spec/novo', 'import', 'import', 'root@x.test'],
        ['skill/tabela', 'import', 'import', 'root@x.test'],
      ],
    )
    assert.deepStrictEqual((result.batch!.summary as { applied: string[] }).applied, ['spec/guia', 'spec/novo', 'skill/tabela'])

    // De novo, o mesmo: tudo unchanged, nada a gravar, nenhum lote.
    const again = await stack.applier.plan({ documents })
    const noop = await stack.applier.apply({ documents, planHash: again.plan.planHash }, ADMIN)
    assert.strictEqual(noop.batch, undefined)
    assert.deepStrictEqual(noop.applied, [])
  })

  it('⚖️ docs que se anexam em ciclo gravam: primeiro sem os anexos, depois com eles; e quem cita o ciclo também', async () => {
    const stack = buildCatalogStack()
    const withDocs = (document: ICatalogDocument, docIds: string[]) => withBody(document, { ...document.body, docIds })
    const documents = [withDocs(spec('alfa'), ['beta']), withDocs(spec('beta'), ['alfa']), withDocs(spec('gama'), ['alfa', 'beta'])]
    const { plan } = await stack.applier.plan({ documents })
    assert.ok(plan.items.every((item) => item.op === 'create'))
    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.failed, undefined)
    assert.strictEqual(result.batch?.status, 'applied')
    assert.deepStrictEqual(
      ['alfa', 'beta', 'gama'].map((id) => stack.guidance.doc(id).docIds),
      [['beta'], ['alfa'], ['alfa', 'beta']],
    )
  })

  it('⚖️ o ciclo também pelo `supersedes`: A substitui B e B anexa A — os dois gravam', async () => {
    const stack = buildCatalogStack()
    const documents = [withBody(spec('anatomia'), { ...spec('anatomia').body, supersedes: ['ledger'] }), withBody(spec('ledger'), { ...spec('ledger').body, docIds: ['anatomia'] })]
    const { plan } = await stack.applier.plan({ documents })
    assert.ok(plan.items.every((item) => item.op === 'create'))
    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.failed, undefined)
    assert.deepStrictEqual(stack.guidance.doc('anatomia').supersedes, ['ledger'])
    assert.deepStrictEqual(stack.guidance.doc('ledger').docIds, ['anatomia'])
  })

  it('planHash velho: 409 com o plano novo, nada gravado', async () => {
    const stack = buildCatalogStack()
    const documents = [spec('novo')]
    const { plan } = await stack.applier.plan({ documents })
    stack.guidance.createDoc({ id: 'novo', kind: 'spec', title: 'X', summary: 'S', body: 'outro' }, 'bia')

    const error = await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogPlanChangedError)
    const fresh = error.plan as typeof plan
    assert.notStrictEqual(fresh.planHash, plan.planHash)
    assert.strictEqual(fresh.items[0].op, 'update')
    assert.strictEqual(stack.guidance.doc('novo').body, 'outro')
    assert.deepStrictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)
  })

  it('item com error ou conflict bloqueia o apply inteiro: nada é gravado, nem o que estava certo', async () => {
    const stack = buildCatalogStack()
    stack.guidance.createResource({ id: 'ocupado', kind: 'command', description: 'D', body: 'B' }, 'ana')
    // `fantasma` cita um doc que não existe (error); `ocupado` é command e o pacote diz skill (conflict).
    const documents = [spec('ok'), skill('fantasma', ['nao-existe']), skill('ocupado')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.items.map((item) => `${item.ref}:${item.op}`),
      ['spec/ok:create', 'skill/fantasma:error', 'skill/ocupado:conflict'],
    )

    const error = await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogImportBlockedError)
    assert.deepStrictEqual(
      error.blockers.map((item) => `${item.ref}:${item.op}`),
      ['skill/fantasma:error', 'skill/ocupado:conflict'],
    )
    assert.strictEqual(stack.reader.read('spec', 'ok'), undefined)
    assert.strictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)
  })

  it('ampliação: sem confirm e com confirm errado = 409; por token = 403 mesmo com confirm; confirm certo grava e registra quem aceitou', async () => {
    const stack = buildCatalogStack()
    const documents = [agent({ id: 'theo', allowedTools: ['alpha_tool'] })]
    const { plan } = await stack.applier.plan({ documents })
    const keys = plan.widenings.map((widening) => widening.key)
    assert.ok(keys.includes('agent/theo#allowedTools+alpha_tool'), keys.join(', '))

    await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogWideningConfirmationError)
    await refused(stack.applier.apply({ documents, planHash: plan.planHash, confirm: ['agent/theo#allowedTools+beta_tool'] }, ADMIN), CatalogWideningConfirmationError)
    await refused(stack.applier.apply({ documents, planHash: plan.planHash, confirm: keys }, CI), CatalogWideningForbiddenError)
    assert.strictEqual(stack.agents.entry('theo'), undefined)

    // Por token, o plano marca o item: a ampliação não se aplica assim.
    const viaToken = await stack.applier.plan({ documents }, { viaAccessToken: true })
    assert.strictEqual(viaToken.plan.items[0].blockedByToken, true)
    assert.strictEqual(viaToken.plan.planHash, plan.planHash)

    const result = await stack.applier.apply({ documents, planHash: plan.planHash, confirm: keys }, ADMIN)
    assert.deepStrictEqual(stack.agents.entry('theo')?.agent.allowedTools, ['alpha_tool'])
    assert.deepStrictEqual(
      result.batch!.widenings.map((widening) => [widening.kind, widening.itemId, widening.key]),
      keys.map((key) => ['agent', 'theo', key]),
    )
    const revision = stack.repository.latest('agent', 'theo')!
    assert.deepStrictEqual([revision.op, revision.by, revision.batchId, revision.widenings], ['import', 'root@x.test', result.batch!.id, keys])

    // Sem ampliação, confirm a mais também é recusado: a pessoa viu outra coisa.
    const quiet = [spec('so-texto')]
    const quietPlan = await stack.applier.plan({ documents: quiet })
    await refused(stack.applier.apply({ documents: quiet, planHash: quietPlan.plan.planHash, confirm: keys }, ADMIN), CatalogWideningConfirmationError)
    // E por token, o que não amplia passa.
    const viaCi = await stack.applier.apply({ documents: quiet, planHash: quietPlan.plan.planHash }, CI)
    assert.strictEqual(viaCi.batch?.status, 'applied')
  })

  it('falha no meio: o lote fica partial, a resposta aponta a reversão, e reverter desfaz o que entrou', async () => {
    const stack = buildCatalogStack({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.id === 'quebra') throw new Error('o disco encheu')
          return writer.prepare(target, current)
        },
      }),
    })
    const documents = [spec('primeiro'), spec('segundo'), skill('quebra', ['primeiro']), skill('depois')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => step.ref),
      ['spec/primeiro', 'spec/segundo', 'skill/depois', 'skill/quebra'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)

    assert.strictEqual(result.batch?.status, 'partial')
    assert.deepStrictEqual(result.failed, { ref: 'skill/quebra', message: 'o disco encheu' })
    assert.deepStrictEqual(result.pending, [])
    assert.deepStrictEqual(result.revert, { batchId: result.batch!.id, method: 'POST', path: `/v1/catalog/batches/${result.batch!.id}/revert` })
    const summary = stack.repository.batch(result.batch!.id)!.summary as { applied: string[]; failed: { ref: string } }
    assert.deepStrictEqual(summary.applied, ['spec/primeiro', 'spec/segundo', 'skill/depois'])
    assert.strictEqual(summary.failed.ref, 'skill/quebra')
    assert.ok(stack.reader.read('spec', 'primeiro'))
    assert.strictEqual(stack.reader.read('skill', 'quebra'), undefined)

    const revert = await stack.restore.revert({ batchId: result.batch!.id }, ADMIN)
    assert.strictEqual(revert.batch.status, 'applied')
    assert.strictEqual(stack.repository.batch(result.batch!.id)!.status, 'reverted')
    assert.strictEqual(stack.reader.read('spec', 'primeiro'), undefined)
    assert.strictEqual(stack.reader.read('spec', 'segundo'), undefined)
    assert.strictEqual(stack.reader.read('skill', 'depois'), undefined)
  })

  it('para no primeiro erro: os passos seguintes ficam pendentes e intactos', async () => {
    const stack = buildCatalogStack({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.id === 'aaa') throw new Error('falhou')
          return writer.prepare(target, current)
        },
      }),
    })
    const documents = [spec('aaa'), spec('bbb'), skill('ccc')]
    const { plan } = await stack.applier.plan({ documents })
    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.deepStrictEqual(result.applied, [])
    assert.deepStrictEqual(result.pending, [{ ref: 'spec/bbb' }, { ref: 'skill/ccc' }])
    assert.strictEqual(stack.reader.read('spec', 'bbb'), undefined)
    assert.strictEqual(result.batch?.status, 'partial')
  })

  it('agente com alcance: entra FECHADO (fase agents) e o alcance vem por último (fase reach); parar no alcance deixa o agente fechado', async () => {
    const stack = buildCatalogStack({
      wrapWriter: (writer) => ({
        prepare: async (target, current) => {
          if (target?.kind === 'agent' && (target.body.allowedTools as string[]).length) throw new Error('caiu no alcance')
          return writer.prepare(target, current)
        },
      }),
    })
    const documents = [agent({ id: 'theo', allowedTools: ['alpha_tool'], permissions: [{ category: 'terminal', pattern: 'git status', decision: 'allow' }] }), spec('depois')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => `${step.ref}${step.part ? `#${step.part}` : ''}:${step.phase}`),
      ['spec/depois:docs', 'agent/theo#record:agents', 'agent/theo#reach:reach'],
    )
    const keys = plan.widenings.map((widening) => widening.key)
    const result = await stack.applier.apply({ documents, planHash: plan.planHash, confirm: keys }, ADMIN)
    assert.strictEqual(result.batch?.status, 'partial')
    assert.deepStrictEqual(result.failed && [result.failed.ref, result.failed.part], ['agent/theo', 'reach'])
    const theo = stack.agents.entry('theo')!.agent
    assert.deepStrictEqual([theo.allowedTools, theo.permissions ?? []], [[], []])
    const revision = stack.repository.latest('agent', 'theo')!
    assert.strictEqual(revision.note, `import do lote ${result.batch!.id} (o agente fechado, sem o alcance novo)`)
    // A aceitação vai na revisão que completa o item (o alcance), que não chegou a ser gravada.
    assert.strictEqual(revision.widenings, undefined)
  })

  it('MCP que pede segredo que o cofre não tem entra DESLIGADO, e a resposta diz o que falta', async () => {
    const stack = buildCatalogStack()
    const documents = [
      mcpDocument({
        id: 'crm',
        name: 'CRM',
        url: 'https://crm.example.com/mcp',
        transport: 'auto',
        auth: 'header',
        headerName: 'X-Key',
        enabled: true,
        createdAt: at,
        updatedAt: at,
      }),
    ]
    const { plan } = await stack.applier.plan({ documents })
    assert.strictEqual(plan.items[0].entersDisabled, true)
    assert.deepStrictEqual(plan.items[0].missingSecrets, ['header'])

    const result = await stack.applier.apply({ documents, planHash: plan.planHash, confirm: plan.widenings.map((widening) => widening.key) }, ADMIN)
    assert.strictEqual(stack.mcps.list().find((server) => server.id === 'crm')?.enabled, false)
    assert.deepStrictEqual(result.entersDisabled, ['mcp/crm'])
    assert.deepStrictEqual(result.missingSecrets, [{ ref: 'mcp/crm', secrets: ['header'] }])
    assert.deepStrictEqual((result.batch!.summary as { entersDisabled: string[] }).entersDisabled, ['mcp/crm'])
  })

  it('⛔ MCP que roda no host (ou recebe a credencial de quem chama): só o admin do gateway importa; o igual ao que já existe não trava', async () => {
    const stack = buildCatalogStack()
    const ROOT: IRestoreCaller = { ...ADMIN, gatewayAdmin: true }
    const shell = mcpDocument({
      id: 'shell',
      name: 'Shell',
      kind: 'process',
      url: '',
      transport: 'auto',
      auth: 'none',
      process: { command: 'bash', args: ['-c', 'id'], env: [], scope: 'conversation' },
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    const pass = mcpDocument({ id: 'pass', name: 'Pass', url: 'https://pass.example.com/mcp', transport: 'auto', auth: 'caller', enabled: true, createdAt: at, updatedAt: at })
    const documents = [shell, pass, spec('guia')]
    const { plan } = await stack.applier.plan({ documents })
    const request = { documents, planHash: plan.planHash, confirm: plan.widenings.map((widening) => widening.key) }

    const denied = await refused(stack.applier.apply(request, ADMIN), CatalogPrivilegedMcpError)
    assert.deepStrictEqual([...denied.servers].sort(), ['pass', 'shell'])
    assert.strictEqual(stack.mcps.list().length, 0)
    assert.strictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)

    await stack.applier.apply(request, ROOT)
    assert.strictEqual(stack.mcps.list().find((server) => server.id === 'shell')?.kind, 'process')

    // O que já está igual não é escrita: quem não é admin do gateway reaplica o pacote com outra coisa mudada.
    const current = stack.reader.list({ kind: 'all' }).filter((document) => document.kind === 'mcp')
    const again = [...current, spec('guia', 'Corpo novo')]
    const second = await stack.applier.plan({ documents: again })
    await stack.applier.apply({ documents: again, planHash: second.plan.planHash, confirm: second.plan.widenings.map((widening) => widening.key) }, ADMIN)
    assert.strictEqual(stack.guidance.doc('guia').body, 'Corpo novo')
  })

  it('projeto em duas partes: o registro sem o contexto inicial, os docs, e depois o contexto (links)', async () => {
    const stack = buildCatalogStack()
    const documents: ICatalogDocument[] = [projectDocument({ id: 'beta', name: 'Beta', createdAt: at, updatedAt: at }, ['sb']), spec('sb', 'Corpo', 'beta')]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.order.map((step) => `${step.ref}${step.part ? `#${step.part}` : ''}`),
      ['project/beta#record', 'spec/sb', 'project/beta#links'],
    )

    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    assert.deepStrictEqual(stack.reader.read('project', 'beta')?.body.initialContext, ['sb'])
    const project = stack.repository.revisions('project', 'beta')
    assert.strictEqual(project.length, 2)
    assert.deepStrictEqual(
      project.map((revision) => [revision.op, revision.batchId, revision.note]),
      [
        ['import', result.batch!.id, `import do lote ${result.batch!.id} (o registro, sem o contexto inicial)`],
        ['import', result.batch!.id, `import do lote ${result.batch!.id} (o contexto inicial)`],
      ],
    )
    assert.deepStrictEqual(stack.reader.read('project', 'beta')?.hash, documents[0].hash)
  })

  it('a ida e volta: o pacote do export de um gateway aplicado num banco limpo dá o mesmo hash item a item', async () => {
    const source = buildCatalogStack()
    source.projects.create({ id: 'alfa', name: 'Alfa', description: 'Projeto' }, 'ana')
    source.guidance.createDoc({ id: 'arq', kind: 'spec', projectId: 'alfa', title: 'Arq', summary: 'S', body: 'B' }, 'ana')
    source.guidance.createResource({ id: 'revisar', kind: 'skill', projectId: 'alfa', description: 'D', body: 'B', docIds: ['arq'] }, 'ana')
    source.guidance.setInitialContext('alfa', ['arq'], 'ana')
    const documents = source.reader.list({ kind: 'all' })

    const target = buildCatalogStack()
    const { plan } = await target.applier.plan({ documents })
    const result = await target.applier.apply({ documents, planHash: plan.planHash }, ADMIN)
    assert.strictEqual(result.batch?.status, 'applied')
    assert.deepStrictEqual(
      target.reader.list({ kind: 'all' }).map((document) => [document.kind, document.id, document.hash]),
      documents.map((document) => [document.kind, document.id, document.hash]),
    )
  })

  it('lista de lotes: do mais novo ao mais velho, com o estado e quantos itens; filtro por projeto e por tipo', async () => {
    const stack = buildCatalogStack()
    stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    const global = [spec('g1')]
    const local = [spec('a1', 'B', 'alfa'), spec('a2', 'B', 'alfa')]
    const one = await stack.applier.apply({ documents: global, planHash: (await stack.applier.plan({ documents: global })).plan.planHash }, ADMIN)
    const two = await stack.applier.apply(
      {
        documents: local,
        scope: { kind: 'project', projectId: 'alfa' },
        planHash: (await stack.applier.plan({ documents: local, scope: { kind: 'project', projectId: 'alfa' } })).plan.planHash,
      },
      ADMIN,
    )
    const all = stack.repository.batches({}, { offset: 0, limit: 10 })
    assert.strictEqual(all.total, 2)
    assert.deepStrictEqual(
      all.batches.map((batch) => [batch.id, batch.scope, batch.status, batch.items]),
      [
        [two.batch!.id, 'project:alfa', 'applied', 2],
        [one.batch!.id, 'all', 'applied', 1],
      ],
    )
    assert.deepStrictEqual(
      stack.repository.batches({ projectId: 'alfa' }, { offset: 0, limit: 10 }).batches.map((batch) => batch.id),
      [two.batch!.id],
    )
    // O lote de escopo `all` que gravou no global aparece no global.
    assert.deepStrictEqual(
      stack.repository.batches({ projectId: '' }, { offset: 0, limit: 10 }).batches.map((batch) => batch.id),
      [one.batch!.id],
    )
    assert.strictEqual(stack.repository.batches({ kind: 'revert' }, { offset: 0, limit: 10 }).total, 0)
  })
})

describe('CatalogImportApplier — compartilhamento (sharedWith)', () => {
  const owner = (...projects: string[]): IRestoreCaller => ({ by: 'root@x.test', viaAccessToken: false, administers: (project) => projects.includes(project) })
  const shares = (document: ICatalogDocument, sharedWith: string[]) => withBody(document, { ...document.body, sharedWith })

  function stackWithProjects() {
    const stack = buildCatalogStack()
    stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    stack.projects.create({ id: 'beta', name: 'Beta' }, 'ana')
    return stack
  }

  it('projeto que não existe aqui sai do sharedWith e vira problema da importação (link-missing) no item; o que existe fica', async () => {
    const stack = stackWithProjects()
    const documents = [shares(skill('tabela', [], 'alfa'), ['beta', 'fantasma'])]
    const { plan, targets } = await stack.applier.plan({ documents })
    assert.strictEqual(plan.items[0].op, 'create')
    assert.deepStrictEqual(targets.get('skill/tabela')!.body.sharedWith, ['beta'])

    await stack.applier.apply({ documents, planHash: plan.planHash }, owner('alfa', 'beta'))

    const saved = stack.guidance.resource('tabela')
    assert.deepStrictEqual(saved.sharedWith, ['beta'])
    assert.deepStrictEqual(
      saved.importIssues?.map((issue) => [issue.code, issue.target]),
      [['link-missing', 'fantasma']],
    )
  })

  it('o projeto que vem no mesmo pacote conta como existente', async () => {
    const stack = buildCatalogStack()
    stack.projects.create({ id: 'alfa', name: 'Alfa' }, 'ana')
    const documents = [projectDocument({ id: 'beta', name: 'Beta', createdAt: at, updatedAt: at }, []), shares(spec('guia', 'B', 'alfa'), ['beta'])]
    const { plan } = await stack.applier.plan({ documents })
    assert.deepStrictEqual(
      plan.items.map((item) => `${item.ref}:${item.op}`),
      ['project/beta:create', 'spec/guia:create'],
    )
    const result = await stack.applier.apply({ documents, planHash: plan.planHash }, owner('alfa', 'beta'))
    assert.strictEqual(result.failed, undefined)
    assert.deepStrictEqual(stack.guidance.doc('guia').sharedWith, ['beta'])
  })

  it('item global com sharedWith: a lista é limpa (o global já vale para todos), sem problema', async () => {
    const stack = stackWithProjects()
    const documents = [shares(skill('geral'), ['alfa'])]
    const { plan } = await stack.applier.plan({ documents })
    await stack.applier.apply({ documents, planHash: plan.planHash }, owner())

    const saved = stack.guidance.resource('geral')
    assert.strictEqual(saved.sharedWith, undefined)
    assert.strictEqual(saved.importIssues, undefined)
  })

  it('ADR não se compartilha: o plano marca o erro e nada é gravado', async () => {
    const stack = stackWithProjects()
    const adr = docDocument({ id: 'decisao', kind: 'adr', projectId: 'alfa', title: 'D', summary: 'S', body: 'B', docIds: [], createdAt: at, updatedAt: at })
    const { plan } = await stack.applier.plan({ documents: [shares(adr, ['beta'])] })
    assert.strictEqual(plan.items[0].op, 'error')
    assert.ok(plan.items[0].issues.some((issue) => issue.field === 'sharedWith'))
  })

  it('⛔ ACRESCENTAR projeto ao sharedWith pelo import exige o admin dele (nada é gravado sem); tirar não exige', async () => {
    const stack = stackWithProjects()
    stack.guidance.createResource({ id: 'tabela', kind: 'skill', projectId: 'alfa', description: 'D', body: 'Corpo' }, 'ana')
    const documents = [shares(stack.reader.read('skill', 'tabela')!, ['beta'])]
    const { plan } = await stack.applier.plan({ documents })

    const denied = await refused(stack.applier.apply({ documents, planHash: plan.planHash }, owner('alfa')), CatalogShareForbiddenError)
    assert.deepStrictEqual(denied.projects, ['beta'])
    await refused(stack.applier.apply({ documents, planHash: plan.planHash }, ADMIN), CatalogShareForbiddenError)
    assert.strictEqual(stack.guidance.resource('tabela').sharedWith, undefined)
    assert.strictEqual(stack.repository.batches({}, { offset: 0, limit: 10 }).total, 0)

    await stack.applier.apply({ documents, planHash: plan.planHash }, owner('alfa', 'beta'))
    assert.deepStrictEqual(stack.guidance.resource('tabela').sharedWith, ['beta'])

    // Tirar: só o escopo do item (o gate do controller), nenhum admin extra aqui.
    const without = [shares(stack.reader.read('skill', 'tabela')!, [])]
    const again = await stack.applier.plan({ documents: without })
    await stack.applier.apply({ documents: without, planHash: again.plan.planHash }, owner('alfa'))
    assert.strictEqual(stack.guidance.resource('tabela').sharedWith, undefined)
  })

  it('mantém o que já estava compartilhado: o mesmo projeto não conta como acrescentado', async () => {
    const stack = stackWithProjects()
    stack.guidance.createResource({ id: 'tabela', kind: 'skill', projectId: 'alfa', description: 'D', body: 'v1' }, 'ana')
    stack.guidance.shareResource('tabela', ['beta'], 'ana')
    const documents = [withBody(stack.reader.read('skill', 'tabela')!, { ...stack.reader.read('skill', 'tabela')!.body, body: 'v2' })]
    const { plan } = await stack.applier.plan({ documents })

    await stack.applier.apply({ documents, planHash: plan.planHash }, owner('alfa'))

    assert.deepStrictEqual([stack.guidance.resource('tabela').body, stack.guidance.resource('tabela').sharedWith], ['v2', ['beta']])
  })
})
