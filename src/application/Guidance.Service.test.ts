import assert from 'node:assert'
import { describe, it } from 'node:test'
import { GuidanceNotFoundError, InvalidGuidanceError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { GuidanceService } from './Guidance.Service'

describe('GuidanceService', () => {
  const build = () => new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => ['xpto', 'crm'].includes(id))
  const rule = (title: string, projectId?: string | null) => ({ title, body: `corpo de ${title}`, projectId })
  const doc = (id: string, projectId?: string | null) => ({ id, kind: 'spec' as const, title: `T ${id}`, summary: `resumo ${id}`, body: `# ${id}\n\ntexto`, projectId })

  it('numera as rules por escopo (Rule 1, 2…) e renumera depois de apagar', () => {
    const service = build()
    const a = service.createRule(rule('a'), 'root')
    service.createRule(rule('b'), 'root')
    const c = service.createRule(rule('c'), 'root')
    const local = service.createRule(rule('x', 'xpto'), 'root')
    assert.deepStrictEqual([a.position, c.position, local.position], [1, 3, 1])

    service.deleteRule(a.id)
    assert.deepStrictEqual(
      service.rules(null).map((item) => [item.title, item.position]),
      [
        ['b', 1],
        ['c', 2],
      ],
    )
  })

  it('sobe e desce trocando com a vizinha; na ponta fica onde está', () => {
    const service = build()
    service.createRule(rule('a'), 'root')
    const b = service.createRule(rule('b'), 'root')
    assert.deepStrictEqual(
      service.moveRule(b.id, 'up', 'root').map((item) => item.title),
      ['b', 'a'],
    )
    assert.deepStrictEqual(
      service.moveRule(b.id, 'up', 'root').map((item) => item.title),
      ['b', 'a'],
    )
  })

  it('trocar o escopo leva a rule para o fim do novo e renumera o antigo', () => {
    const service = build()
    const a = service.createRule(rule('a'), 'root')
    service.createRule(rule('b'), 'root')
    service.createRule(rule('x', 'xpto'), 'root')
    const moved = service.updateRule(a.id, { projectId: 'xpto' }, 'root')
    assert.deepStrictEqual([moved.projectId, moved.position], ['xpto', 2])
    assert.deepStrictEqual(
      service.rules(null).map((item) => [item.title, item.position]),
      [['b', 1]],
    )
  })

  it('⛔ recusa rule sem título ou corpo e projeto que não existe, tudo de uma vez', () => {
    const service = build()
    assert.throws(
      () => service.createRule({ title: '', body: ' ', projectId: 'nada' }, 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues.map((issue) => issue.field).join() === 'title,body,projectId',
    )
    assert.throws(() => service.updateRule('nao-existe', { title: 'x' }, 'root'), GuidanceNotFoundError)
  })

  it('o documento: id em slug e único; o corpo é obrigatório', () => {
    const service = build()
    service.createDoc(doc('api-v2'), 'root')
    assert.throws(
      () => service.createDoc(doc('api-v2'), 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues[0].message.startsWith('already exists'),
    )
    assert.throws(
      () => service.createDoc({ ...doc('Com Espaço'), body: '' }, 'root'),
      (error: unknown) => error instanceof InvalidGuidanceError && error.issues.length === 2,
    )
  })

  it('o prompt: rules ligadas (globais e depois as do projeto) e o índice de documentos; nada cadastrado, nada', () => {
    const service = build()
    assert.strictEqual(service.environmentFor('xpto'), undefined)

    service.createRule(rule('Português'), 'root')
    service.createRule({ ...rule('Desligada'), enabled: false }, 'root')
    service.createRule(rule('Só no XPTO', 'xpto'), 'root')
    service.createRule(rule('Só no CRM', 'crm'), 'root')
    service.createDoc(doc('global-doc'), 'root')
    service.createDoc({ ...doc('adr-1', 'xpto'), kind: 'adr' }, 'root')

    const text = service.environmentFor('xpto')!
    assert.match(text, /## Regras do ambiente[\s\S]*1\. \*\*Português\*\* — corpo de Português\n2\. \*\*Só no XPTO\*\*/)
    assert.doesNotMatch(text, /Desligada|Só no CRM/)
    assert.match(text, /## Documentos de referência[\s\S]*- \[spec\] global-doc — T global-doc: resumo global-doc\n- \[adr\] adr-1 — T adr-1/)
    assert.doesNotMatch(service.environmentFor()!, /XPTO|adr-1/)
  })

  it('⛔ read_doc: o global e o do projeto da conversa; o de outro projeto é como se não existisse', () => {
    const service = build()
    service.createDoc(doc('global-doc'), 'root')
    service.createDoc(doc('do-crm', 'crm'), 'root')
    assert.strictEqual(service.readDoc('global-doc', 'xpto')?.id, 'global-doc')
    assert.strictEqual(service.readDoc('do-crm', 'crm')?.id, 'do-crm')
    assert.strictEqual(service.readDoc('do-crm', 'xpto'), undefined)
    assert.strictEqual(service.readDoc('do-crm'), undefined)
    assert.deepStrictEqual([service.hasDocs('xpto'), build().hasDocs('xpto')], [true, false])
  })

  it('apagar o projeto leva as rules e os documentos dele', () => {
    const service = build()
    service.createRule(rule('g'), 'root')
    service.createRule(rule('x', 'xpto'), 'root')
    service.createDoc(doc('do-xpto', 'xpto'), 'root')
    service.removeProject('xpto')
    assert.deepStrictEqual([service.rules('xpto').length, service.docs('xpto').length, service.rules(null).length], [0, 0, 1])
  })

  describe('contexto inicial', () => {
    const seeded = () => {
      const service = build()
      service.createDoc({ ...doc('seguranca'), title: 'Segurança', body: 'Nunca exponha segredos.' }, 'root')
      service.createDoc({ ...doc('comunicacao', 'xpto'), title: 'Comunicação', body: 'Tom formal.' }, 'root')
      service.createDoc({ ...doc('do-crm', 'crm') }, 'root')
      service.createDoc({ ...doc('decisao'), kind: 'adr' }, 'root')
      return service
    }

    it('⛔ só spec, e só a global ou a do próprio projeto; sem repetir; projeto que não existe é 404', () => {
      const service = seeded()
      assert.throws(
        () => service.setInitialContext('xpto', ['decisao', 'do-crm', 'nada', 'seguranca', 'seguranca'], 'root'),
        (error: unknown) =>
          error instanceof InvalidGuidanceError &&
          error.issues.map((issue) => issue.message.split(':')[0]).join('|') === 'only specs load in full|do-crm belongs to another project (crm)|no such document|repeated',
      )
      assert.throws(() => service.setInitialContext('nada', [], 'root'), ProjectNotFoundError)
    })

    it('as marcadas vão inteiras, na ordem, depois das rules — e saem do índice; no outro projeto, a global fica no índice', () => {
      const service = seeded()
      service.createRule(rule('Idioma'), 'root')
      const view = service.setInitialContext('xpto', ['comunicacao', 'seguranca'], 'root')
      assert.deepStrictEqual(
        view.docs.map((item) => [item.id, item.tokens]),
        [
          ['comunicacao', 3],
          ['seguranca', 6],
        ],
      )
      assert.strictEqual(view.totalTokens, 9)

      const xpto = service.environmentFor('xpto')!
      assert.match(xpto, /## Regras do ambiente[\s\S]*## Specs do projeto[\s\S]*### Comunicação\nTom formal\.\n\n### Segurança\nNunca exponha segredos\./)
      assert.doesNotMatch(xpto.slice(xpto.indexOf('## Documentos')), /seguranca|comunicacao/)
      assert.match(service.environmentFor('crm')!, /- \[spec\] seguranca — Segurança/)
      assert.doesNotMatch(service.environmentFor('crm')!, /## Specs do projeto/)
      assert.deepStrictEqual(service.loadedIn('seguranca'), ['xpto'])
    })

    it('o que deixa de valer sai sem apagar a marca; apagar o doc ou o projeto limpa', () => {
      const service = seeded()
      service.setInitialContext('xpto', ['seguranca', 'comunicacao'], 'root')
      service.updateDoc('comunicacao', { kind: 'adr' }, 'root')
      assert.deepStrictEqual(
        service.initialContext('xpto').map((item) => item.id),
        ['seguranca'],
      )
      service.updateDoc('comunicacao', { kind: 'spec' }, 'root')
      assert.strictEqual(service.initialContext('xpto').length, 2)

      service.deleteDoc('seguranca')
      assert.deepStrictEqual(
        service.initialContext('xpto').map((item) => item.id),
        ['comunicacao'],
      )
      service.removeProject('xpto')
      assert.deepStrictEqual(service.initialContext('xpto'), [])
    })
  })
})
