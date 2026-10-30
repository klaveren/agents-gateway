import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AgentNotFoundError, GuidanceNotFoundError, InvalidGuidanceError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
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
      assert.deepStrictEqual(service.loadedIn('seguranca'), { projects: ['xpto'], agents: [] })
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

  describe('contexto inicial do agente', () => {
    const agents: Record<string, { id: string; projectId?: string }> = {
      dev: { id: 'dev', projectId: 'xpto' },
      resumo: { id: 'resumo', projectId: 'xpto' },
      atlas: { id: 'atlas' },
    }
    const seeded = () => {
      const service = new GuidanceService(
        new SqliteGuidanceRepository(':memory:'),
        (id) => ['xpto', 'crm'].includes(id),
        (id) => agents[id],
      )
      service.createDoc({ ...doc('seguranca'), title: 'Segurança', body: 'Nunca exponha segredos.' }, 'root')
      service.createDoc({ ...doc('arquitetura', 'xpto'), title: 'Arquitetura', body: 'Hexagonal.' }, 'root')
      service.createDoc({ ...doc('do-crm', 'crm') }, 'root')
      service.createDoc({ ...doc('decisao'), kind: 'adr' }, 'root')
      return service
    }

    it('⛔ agente de projeto: globais e do projeto dele; agente global: só globais; agente que não existe é 404', () => {
      const service = seeded()
      assert.throws(
        () => service.setAgentContext('dev', ['decisao', 'do-crm'], 'root'),
        (error: unknown) => error instanceof InvalidGuidanceError && error.issues.length === 2,
      )
      assert.throws(
        () => service.setAgentContext('atlas', ['arquitetura'], 'root'),
        (error: unknown) => error instanceof InvalidGuidanceError && /global agent loads only global specs/.test(error.issues[0].message),
      )
      assert.strictEqual(service.setAgentContext('atlas', ['seguranca'], 'root').docs.length, 1)
      assert.throws(() => service.agentContextView('nada'), AgentNotFoundError)
    })

    it('depois das specs do projeto, só para o agente marcado; a que está nas duas entra uma vez', () => {
      const service = seeded()
      service.setInitialContext('xpto', ['seguranca'], 'root')
      service.setAgentContext('dev', ['arquitetura', 'seguranca'], 'root')

      const dev = service.environmentFor('xpto', 'dev')!
      assert.match(dev, /## Specs do projeto[\s\S]*### Segurança[\s\S]*## Specs do agente\n\nCarregadas[^\n]*\n\n### Arquitetura\nHexagonal\.$/m)
      assert.strictEqual(dev.match(/### Segurança/g)?.length, 1)
      assert.doesNotMatch(dev, /\[spec\] arquitetura/)

      const resumo = service.environmentFor('xpto', 'resumo')!
      assert.doesNotMatch(resumo, /## Specs do agente/)
      assert.match(resumo, /- \[spec\] arquitetura — Arquitetura/)
      assert.deepStrictEqual(service.loadedIn('arquitetura'), { projects: [], agents: ['dev'] })
    })

    it('apagar o agente ou a spec limpa a lista', () => {
      const service = seeded()
      service.setAgentContext('dev', ['arquitetura', 'seguranca'], 'root')
      service.deleteDoc('seguranca')
      assert.deepStrictEqual(
        service.agentContext('dev').map((item) => item.id),
        ['arquitetura'],
      )
      service.removeAgent('dev')
      assert.deepStrictEqual(service.agentContext('dev'), [])
    })
  })

  it('environmentParts: cada seção separada; environmentFor é a junção delas', () => {
    const service = build()
    service.createRule(rule('Idioma'), 'root')
    service.createDoc(doc('global-doc'), 'root')
    const parts = service.environmentParts('xpto')
    assert.deepStrictEqual(Object.keys(parts), ['rules', 'index'])
    assert.strictEqual(service.environmentFor('xpto'), `${parts.rules}\n\n${parts.index}`)
  })

  describe('skills e commands', () => {
    const agents: Record<string, { id: string; projectId?: string; triggers?: Array<{ id: string; when: string; body: string }> }> = {
      dev: { id: 'dev', projectId: 'xpto' },
      maya: { id: 'maya', projectId: 'xpto', triggers: [{ id: 'morning-brief', when: 'a pessoa diz bom dia', body: 'Devolva o briefing em bullets.' }] },
      resumo: { id: 'resumo', projectId: 'xpto' },
      atlas: { id: 'atlas' },
    }
    const seeded = () => {
      const service = new GuidanceService(
        new SqliteGuidanceRepository(':memory:'),
        (id) => ['xpto', 'crm'].includes(id),
        (id) => agents[id],
      )
      service.createDoc({ ...doc('padrao'), title: 'Padrão', body: 'Use tabelas.' }, 'root')
      service.createResource({ id: 'tabela', kind: 'skill', description: 'Montar tabelas em markdown', body: 'Sempre com cabeçalho.', docIds: ['padrao'] }, 'root')
      service.createResource({ id: 'resumir', kind: 'command', projectId: 'xpto', description: 'Resume um arquivo', body: 'Resuma $ARGUMENTS em 3 linhas.' }, 'root')
      service.createResource({ id: 'do-crm', kind: 'command', projectId: 'crm', description: 'Do CRM', body: 'x' }, 'root')
      // O XPTO Resumo é o que não usa nenhum, de propósito (sem marcação seriam todos).
      service.setAgentResources('resumo', { skills: [], commands: [] }, 'root')
      return service
    }

    it('⛔ valida: descrição obrigatória, id único, doc de outro projeto; agente global só libera os globais', () => {
      const service = seeded()
      assert.throws(
        () => service.createResource({ id: 'tabela', kind: 'skill', description: '', body: '' }, 'root'),
        (error: unknown) => error instanceof InvalidGuidanceError && error.issues.map((issue) => issue.field).join() === 'id,description,body',
      )
      assert.throws(() => service.setAgentResources('dev', { commands: ['do-crm'] }, 'root'), InvalidGuidanceError)
      assert.throws(() => service.setAgentResources('atlas', { commands: ['resumir'] }, 'root'), /global agent uses only global resources/)
      assert.throws(() => service.setAgentResources('dev', { skills: ['*', 'tabela'] }, 'root'), /goes alone/)
    })

    it('⚖️ sem marcação, todos (os globais e os do projeto); "nenhum" é escolha explícita; o índice entra no prompt', () => {
      const service = seeded()
      assert.deepStrictEqual(service.agentResources('dev'), { skills: ['*'], commands: ['*'] })
      assert.deepStrictEqual(
        service.usableResources('command', 'dev').map((item) => item.id),
        ['resumir'],
      )
      assert.deepStrictEqual(service.agentResources('resumo'), { skills: [], commands: [] })
      assert.deepStrictEqual(service.usableResources('skill', 'resumo'), [])
      // O agente global vê os globais; o construtor do core, nenhum (ele os escreve).
      assert.deepStrictEqual(
        service.usableResources('skill', 'atlas').map((item) => item.id),
        ['tabela'],
      )

      service.setAgentResources('dev', { skills: ['tabela'], commands: ['*'] }, 'root')
      assert.deepStrictEqual(
        service.usableResources('command', 'dev').map((item) => item.id),
        ['resumir'],
      )
      const prompt = service.environmentFor('xpto', 'dev')!
      assert.match(prompt, /## Skills[\s\S]*- tabela — Montar tabelas em markdown/)
      assert.match(prompt, /## Commands[\s\S]*- \/resumir — Resume um arquivo/)
      assert.doesNotMatch(service.environmentFor('xpto', 'resumo') ?? '', /## Skills|## Commands/)
      assert.deepStrictEqual([service.hasResources('dev'), service.hasResources('resumo')], [true, false])
    })

    it('use_resource: a skill inteira com os docs anexados, só para o agente liberado; o command como está', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: ['tabela'], commands: ['resumir'] }, 'root')
      assert.match(service.loadResource('skill', 'tabela', 'dev')!, /# Skill: tabela\n\nSempre com cabeçalho\.\n\n## Documentos anexados\n\n### Padrão \[spec\]\nUse tabelas\./)
      assert.strictEqual(service.loadResource('skill', 'tabela', 'resumo'), undefined)
      assert.match(service.loadResource('command', 'resumir', 'dev')!, /# Command: resumir\n\nResuma \$ARGUMENTS em 3 linhas\./)
    })

    it('anexo inteiro: sem docRefs, o use_resource sai exatamente como antes', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: ['tabela'], commands: [] }, 'root')
      assert.strictEqual(service.resource('tabela').docRefs, undefined)
      assert.strictEqual(service.loadResource('skill', 'tabela', 'dev'), '# Skill: tabela\n\nSempre com cabeçalho.\n\n## Documentos anexados\n\n### Padrão [spec]\nUse tabelas.')
    })

    it('anexo por referência: lista id, título e tamanho, sem o conteúdo; o inteiro continua inteiro', () => {
      const service = seeded()
      service.createDoc({ ...doc('grande', 'xpto'), title: 'Spec grande', summary: 'O contrato todo', body: `SEGREDO-DO-CORPO ${'x'.repeat(40_000)}` }, 'root')
      service.updateResource('tabela', { projectId: 'xpto', docIds: ['padrao', 'grande'], docRefs: ['grande'] }, 'root')
      service.setAgentResources('dev', { skills: ['tabela'], commands: [] }, 'root')
      const loaded = service.loadResource('skill', 'tabela', 'dev')!
      assert.match(loaded, /## Documentos anexados\n\n### Padrão \[spec\]\nUse tabelas\./)
      assert.match(
        loaded,
        /## Documentos anexados por referência\n\nNão vieram inteiros\. Leia com read_doc \(pelo id\)[\s\S]*- grande — Spec grande \[spec\] · ≈ 10\.005 tokens: O contrato todo$/,
      )
      assert.ok(!loaded.includes('SEGREDO-DO-CORPO'), 'o corpo do anexo por referência não vai')
      // Só referência: a seção dos inteiros nem aparece.
      service.updateResource('tabela', { docRefs: ['padrao', 'grande'] }, 'root')
      assert.doesNotMatch(service.loadResource('skill', 'tabela', 'dev')!, /## Documentos anexados\n|Use tabelas/)
    })

    it('⛔ docRefs só entre os anexados, sem repetir; tirar o anexo tira a referência; apagar o doc também', () => {
      const service = seeded()
      assert.throws(
        () => service.updateResource('tabela', { docRefs: ['outro', 'padrao', 'padrao'] }, 'root'),
        (error: unknown) =>
          error instanceof InvalidGuidanceError &&
          error.issues.map((issue) => issue.message).join('|') === 'not attached: outro (by reference only goes one of docIds)|repeated: padrao',
      )
      service.updateResource('tabela', { docRefs: ['padrao'] }, 'root')
      assert.deepStrictEqual(service.updateResource('tabela', { description: 'outra' }, 'root').docRefs, ['padrao'], 'sem docRefs na edição, ficam')
      assert.strictEqual(service.updateResource('tabela', { docIds: [] }, 'root').docRefs, undefined)
      service.updateResource('tabela', { docIds: ['padrao'], docRefs: ['padrao'] }, 'root')
      service.deleteDoc('padrao')
      assert.deepStrictEqual([service.resource('tabela').docIds, service.resource('tabela').docRefs], [[], undefined])
    })

    it('⛔ attachedDoc: o anexo é legível por quem pode carregar o recurso, e só por ele; liga o read_doc', () => {
      const service = seeded()
      service.createDoc({ ...doc('grande', 'xpto'), title: 'Spec grande' }, 'root')
      service.createResource(
        { id: 'contrato', kind: 'skill', projectId: 'xpto', description: 'Aplica o contrato', body: 'Passos.', docIds: ['grande'], docRefs: ['grande'] },
        'root',
      )
      service.setAgentResources('dev', { skills: ['contrato'], commands: [] }, 'root')
      assert.deepStrictEqual(service.attachedDoc('grande', 'dev')?.via, [{ kind: 'skill', id: 'contrato' }])
      assert.strictEqual(service.attachedDoc('grande', 'dev')?.doc.id, 'grande')
      assert.strictEqual(service.attachedDoc('grande', 'resumo'), undefined, 'agente sem a skill')
      assert.strictEqual(service.attachedDoc('grande', 'atlas'), undefined, 'agente global não vê a skill do projeto')
      assert.strictEqual(service.attachedDoc('padrao', 'dev'), undefined, 'não anexado a nada que ele usa')
      assert.strictEqual(service.attachedDoc('grande'), undefined, 'sem agente, nada')
      // A regra da conversa não abre o doc do projeto numa conversa sem projeto; o anexo abre (e liga o read_doc).
      assert.strictEqual(service.readDoc('grande'), undefined)
      // Tudo no contexto inicial do projeto: o índice da conversa fica vazio.
      service.setInitialContext('xpto', ['grande', 'padrao'], 'root')
      assert.ok(!service.hasDocs('xpto', 'resumo'), 'o índice está vazio para quem não tem a skill')
      assert.ok(service.hasDocs('xpto', 'dev'), 'a referência liga o read_doc mesmo com o índice vazio')
    })

    it('triggers: o índice "## Triggers" no prompt, o corpo só pelo use_resource, e só do próprio agente', () => {
      const service = seeded()
      service.setAgentResources('maya', { skills: [], commands: [] }, 'root')
      const prompt = service.environmentFor('xpto', 'maya')!
      assert.match(prompt, /## Triggers — ações sob demanda[\s\S]*- morning-brief — a pessoa diz bom dia/)
      assert.ok(!prompt.includes('Devolva o briefing'), 'o corpo não vai no prompt')
      assert.ok(service.hasResources('maya'), 'só com trigger, as ferramentas ligam')
      assert.match(service.loadResource('trigger', 'morning-brief', 'maya')!, /^# Trigger: morning-brief\n\nQuando: a pessoa diz bom dia\n\nDevolva o briefing em bullets\.$/)
      assert.strictEqual(service.loadResource('trigger', 'morning-brief', 'dev'), undefined, 'trigger de outro agente não existe para ele')
      assert.deepStrictEqual(service.searchResources('bom dia', undefined, 'maya'), [{ kind: 'trigger', id: 'morning-brief', description: 'a pessoa diz bom dia' }])
      assert.deepStrictEqual(service.searchResources('bom dia', 'skill', 'maya'), [])
    })

    it('/command: $ARGUMENTS e os docs; desconhecido segue como texto; ⛔ não liberado é recusado', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: [], commands: ['resumir'] }, 'root')
      assert.deepStrictEqual(service.expandCommand('/resumir o relatório.md', 'dev'), {
        text: 'Resuma o relatório.md em 3 linhas.',
        label: '/resumir o relatório.md',
        command: 'resumir',
      })
      assert.strictEqual(service.expandCommand('/nao-existe x', 'dev'), undefined)
      assert.strictEqual(service.expandCommand('oi /resumir', 'dev'), undefined)
      assert.throws(() => service.expandCommand('/resumir x', 'resumo'), /not enabled for this agent/)
    })

    it('/spec:<id>: o documento escolhido vai inteiro, com o pedido; ⛔ o de outro projeto, ou de outro tipo, segue como texto', () => {
      const service = seeded()
      service.createDoc({ ...doc('so-crm', 'crm'), title: 'Só CRM' }, 'root')
      const expanded = service.expandCommand('/spec:padrao monte a tabela', 'dev', 'xpto')!
      assert.match(expanded.text, /anexou o documento padrao \(spec\)[\s\S]*# Padrão \[spec\]\n\nUse tabelas\.\n\n# Pedido\n\nmonte a tabela$/)
      assert.deepStrictEqual([expanded.label, expanded.command], ['/spec:padrao monte a tabela', 'spec:padrao'])
      assert.strictEqual(service.expandCommand('/spec:so-crm x', 'dev', 'xpto'), undefined)
      assert.strictEqual(service.expandCommand('/adr:padrao x', 'dev', 'xpto'), undefined)
    })

    it('/skill: a skill escolhida vai inteira, já carregada, com o pedido depois; ⛔ não liberada é recusada', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: ['tabela'], commands: [] }, 'root')
      const expanded = service.expandCommand('/tabela frutas e cores', 'dev')!
      assert.match(expanded.text, /pediu a skill tabela[\s\S]*# Skill: tabela\n\nSempre com cabeçalho\.[\s\S]*### Padrão \[spec\][\s\S]*# Pedido\n\nfrutas e cores$/)
      assert.strictEqual(expanded.label, '/tabela frutas e cores')
      assert.throws(() => service.expandCommand('/tabela x', 'resumo'), /skill \/tabela is not enabled for this agent/)
    })

    it('apagar o doc tira ele dos recursos; apagar o agente ou o projeto limpa', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: ['tabela'], commands: ['resumir'] }, 'root')
      service.deleteDoc('padrao')
      assert.deepStrictEqual(service.resource('tabela').docIds, [])
      service.removeProject('xpto')
      assert.throws(() => service.resource('resumir'), GuidanceNotFoundError)
      service.removeAgent('dev')
      assert.deepStrictEqual(service.agentResources('dev'), { skills: ['*'], commands: ['*'] })
    })

    it('⛔ apagar o único recurso liberado a um agente não o abre para todos: ele fica com nenhum', () => {
      const service = seeded()
      service.setAgentResources('dev', { skills: ['tabela'], commands: ['resumir'] }, 'root')
      service.deleteResource('tabela')
      assert.deepStrictEqual(service.agentResources('dev'), { skills: [], commands: ['resumir'] })
    })
  })

  describe('protocolos e o construtor', () => {
    const seeded = () => {
      const service = new GuidanceService(
        new SqliteGuidanceRepository(':memory:'),
        (id) => ['xpto', 'crm'].includes(id),
        (id) => (id === 'builder-skill' || id === 'dev' ? { id } : undefined),
      )
      service.createDoc({ ...doc('padrao'), title: 'Padrão' }, 'root')
      service.createDoc({ ...doc('so-crm', 'crm'), title: 'Só CRM' }, 'root')
      service.createResource({ id: 'tabela', kind: 'skill', description: 'Montar tabelas', body: 'x' }, 'root')
      service.createResource({ id: 'xpto-revisar', kind: 'skill', projectId: 'xpto', description: 'Revisar no XPTO', body: 'x' }, 'root')
      service.createResource({ id: 'do-crm', kind: 'skill', projectId: 'crm', description: 'Do CRM', body: 'x' }, 'root')
      service.createResource({ id: 'resumir', kind: 'command', description: 'Resume', body: 'Resuma $ARGUMENTS' }, 'root')
      return service
    }

    it('o do core vem com a versão; o complemento é por escopo, soma ao core, e corpo vazio apaga', () => {
      const service = seeded()
      const empty = service.protocol('skill', 'xpto')
      assert.match(empty.core.body, /# Protocolo de construção de skill/)
      assert.match(empty.core.version, /^\d+\.\d+\.\d+$/)
      assert.deepStrictEqual(empty.addenda, {})

      service.setProtocolAddendum('skill', null, 'Descrição em português.', 'root')
      const view = service.setProtocolAddendum('skill', 'xpto', '  O id começa com xpto-.  ', 'root')
      assert.deepStrictEqual(
        [view.addenda.global?.body, view.addenda.project?.body, view.addenda.project?.projectId],
        ['Descrição em português.', 'O id começa com xpto-.', 'xpto'],
      )
      assert.strictEqual(service.protocol('skill', 'crm').addenda.project, undefined)
      assert.strictEqual(service.protocol('command').addenda.global, undefined)

      service.setProtocolAddendum('skill', 'xpto', '  ', 'root')
      assert.strictEqual(service.protocol('skill', 'xpto').addenda.project, undefined)
      service.setProtocolAddendum('skill', 'xpto', 'de novo', 'root')
      service.removeProject('xpto')
      assert.strictEqual(service.protocol('skill', 'xpto').addenda.project, undefined)
      assert.strictEqual(service.protocol('skill').addenda.global?.body, 'Descrição em português.')
      assert.throws(() => service.protocol('skill', 'nada'), ProjectNotFoundError)
    })

    it('⛔ complemento: tipo que não existe e projeto que não existe são recusados', () => {
      const service = seeded()
      assert.throws(() => service.setProtocolAddendum('agente' as 'skill', null, 'x', 'root'), InvalidGuidanceError)
      assert.throws(() => service.setProtocolAddendum('skill', 'nada', 'x', 'root'), /no such project/)
    })

    it('o construtor recebe o complemento e o que já existe do tipo, no escopo da conversa; outro agente não', () => {
      const service = seeded()
      service.setProtocolAddendum('skill', null, 'Regra global.', 'root')
      service.setProtocolAddendum('skill', 'xpto', 'Regra do XPTO.', 'root')
      const parts = service.environmentParts('xpto', 'builder-skill')
      assert.match(parts.protocol!, /## Complemento do protocolo[\s\S]*### Global\nRegra global\.[\s\S]*### Do projeto xpto\nRegra do XPTO\./)
      assert.match(parts.existing!, /## O que já existe \(skills\)\n- tabela \[global\] — Montar tabelas\n- xpto-revisar \[xpto\] — Revisar no XPTO$/)
      assert.match(service.environmentFor('xpto', 'builder-skill')!, /## Documentos de referência[\s\S]*## Complemento do protocolo[\s\S]*## O que já existe/)
      const plain = service.environmentParts('xpto', 'dev')
      assert.deepStrictEqual([plain.protocol, plain.existing], [undefined, undefined])
    })

    it('draftIssues: as regras do cadastro sem gravar; id do mesmo tipo é ajuste, de outro tipo é recusado', () => {
      const service = seeded()
      const ok = service.draftIssues({ kind: 'skill', id: 'nova-skill', description: 'Faz algo', body: 'Passos', docIds: ['padrao'] }, 'xpto')
      assert.deepStrictEqual([ok.issues, ok.updates, ok.projectId], [[], false, 'xpto'])
      assert.throws(() => service.resource('nova-skill'), GuidanceNotFoundError)

      assert.strictEqual(service.draftIssues({ kind: 'skill', id: 'tabela', description: 'd', body: 'b', global: true }).updates, true)
      assert.deepStrictEqual(
        service.draftIssues({ kind: 'skill', id: 'resumir', description: '', body: '', docIds: ['so-crm'] }, 'xpto').issues.map((issue) => issue.field),
        ['id', 'description', 'body', 'docIds'],
      )
      assert.match(service.draftIssues({ kind: 'skill', id: 'Ruim!', description: 'd', body: 'b' }).issues[0].message, /lowercase/)
    })

    it('draftIssues de rule, spec e ADR: as regras de cada cadastro; doc com id de outro tipo é recusado, do mesmo é ajuste', () => {
      const service = seeded()
      service.createDoc({ ...doc('decisao'), kind: 'adr', title: 'Decisão' }, 'root')
      assert.deepStrictEqual(
        service.draftIssues({ kind: 'rule', title: '', body: '' }).issues.map((issue) => issue.field),
        ['title', 'body'],
      )
      const rule = service.draftIssues({ kind: 'rule', title: 'Dados', body: 'Nunca apague sem backup.' }, 'xpto')
      assert.deepStrictEqual([rule.issues, rule.id, rule.projectId], [[], undefined, 'xpto'])

      const spec = service.draftIssues({ kind: 'spec', id: 'api-rest', title: 'API', summary: 'Padrões', body: '# API' }, 'xpto')
      assert.deepStrictEqual([spec.issues, spec.updates, spec.id], [[], false, 'api-rest'])
      assert.strictEqual(service.draftIssues({ kind: 'spec', id: 'padrao', title: 'P', summary: '', body: 'x' }).updates, true)
      assert.match(service.draftIssues({ kind: 'spec', id: 'decisao', title: 'T', summary: '', body: 'x' }).issues[0].message, /already taken by an adr/)
      assert.deepStrictEqual(
        service.draftIssues({ kind: 'adr', id: 'X', title: '', summary: '', body: '' }).issues.map((issue) => issue.field),
        ['id', 'title', 'body'],
      )
    })

    it('o construtor de rule e o de spec veem o que já existe do tipo deles; protocol aceita os cinco tipos', () => {
      const service = seeded()
      service.createRule({ title: 'Dados', body: 'Nunca apague sem backup.' }, 'root')
      service.createRule({ title: 'Do XPTO', body: 'Responda em português.', projectId: 'xpto' }, 'root')
      const agentOf = (id: string) => ({ id })
      const builder = new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => id === 'xpto', agentOf)
      builder.createRule({ title: 'Dados', body: 'Nunca apague sem backup.' }, 'root')
      builder.createRule({ title: 'Do XPTO', body: 'Responda em português.', projectId: 'xpto' }, 'root')
      builder.createDoc({ ...doc('padrao'), title: 'Padrão' }, 'root')
      assert.match(
        builder.environmentParts('xpto', 'builder-rule').existing!,
        /## O que já existe \(rules\)\n- Rule 1 \[global\] — Dados: Nunca apague sem backup\.\n- Rule 1 \[xpto\] — Do XPTO: Responda em português\.$/,
      )
      assert.match(builder.environmentParts('xpto', 'builder-spec').existing!, /## O que já existe \(specs\)\n- padrao \[global\] — Padrão: resumo padrao$/)
      assert.match(builder.environmentParts(undefined, 'builder-adr').existing!, /\(ADRs\)\nNada ainda/)
      for (const kind of ['skill', 'command', 'rule', 'spec', 'adr'] as const) assert.strictEqual(service.protocol(kind).core.kind, kind)
    })
  })

  describe('rascunho de agente', () => {
    const seeded = () => {
      const service = new GuidanceService(new SqliteGuidanceRepository(':memory:'), (id) => ['xpto', 'crm'].includes(id))
      service.createDoc({ ...doc('padrao'), title: 'Padrão' }, 'root')
      service.createDoc({ ...doc('so-crm', 'crm'), title: 'Só CRM' }, 'root')
      service.createDoc({ ...doc('decisao'), kind: 'adr', title: 'Decisão' }, 'root')
      service.createResource({ id: 'tabela', kind: 'skill', description: 'Tabelas', body: 'x' }, 'root')
      service.createResource({ id: 'do-crm', kind: 'command', projectId: 'crm', description: 'CRM', body: 'x' }, 'root')
      return service
    }

    it('⛔ sem o conferente do cadastro, ou sem o registro, é recusado', async () => {
      const service = seeded()
      assert.match((await service.agentDraftIssues({ kind: 'agent', agent: { id: 'x' } })).issues[0].message, /cannot be checked/)
      service.useAgentChecker(async () => ({ issues: [], exists: false }))
      assert.deepStrictEqual(
        (await service.agentDraftIssues({ kind: 'agent' })).issues.map((issue) => issue.field),
        ['agent'],
      )
    })

    it('junta os problemas do registro, do contexto inicial e dos recursos, no escopo do projeto do agente', async () => {
      const service = seeded()
      const seen: unknown[] = []
      service.useAgentChecker(async (agent) => (seen.push(agent), { issues: [{ field: 'name', message: 'required' }], exists: true }))
      const result = await service.agentDraftIssues({
        kind: 'agent',
        agent: { id: 'revisor', projectId: 'xpto' },
        initialContext: ['padrao', 'so-crm', 'decisao'],
        resources: { skills: ['tabela'], commands: ['do-crm'] },
      })
      assert.deepStrictEqual(seen, [{ id: 'revisor', projectId: 'xpto' }])
      assert.deepStrictEqual(
        result.issues.map((issue) => issue.field),
        ['agent.name', 'initialContext', 'initialContext', 'resources.commands'],
      )
      assert.deepStrictEqual([result.updates, result.id, result.projectId], [true, 'revisor', 'xpto'])
    })
  })

  describe('busca nos documentos (search_docs)', () => {
    const seeded = () => {
      const service = build()
      service.createDoc(
        { id: 'feature-flags', kind: 'knowledge', title: 'Feature flags', summary: 'Tipos e ciclo de vida', body: 'Liberação gradual com toggles de experimento e de operação.' },
        'root',
      )
      service.createDoc({ id: 'api-rest', kind: 'spec', title: 'API REST', summary: 'Padrões de rota', body: 'Erros com código e mensagem; paginação por page.' }, 'root')
      service.createDoc({ id: 'do-xpto', kind: 'spec', title: 'Toggles do XPTO', summary: 'Só do projeto', body: 'Flags de cliente.', projectId: 'xpto' }, 'root')
      service.createDoc({ id: 'do-crm', kind: 'spec', title: 'Toggles do CRM', summary: 'Outro projeto', body: 'Flags do CRM.', projectId: 'crm' }, 'root')
      return service
    }
    const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id).sort()

    it('acha pelo texto, sem acento e por prefixo; só os globais e os do projeto da conversa', () => {
      const service = seeded()
      assert.deepStrictEqual(ids(service.searchDocs('liberacao toggle', 'xpto')), ['do-xpto', 'feature-flags'])
      assert.deepStrictEqual(ids(service.searchDocs('flag')), ['feature-flags'])
      assert.match(service.searchDocs('paginação')[0].excerpt, /«paginação»/)
      assert.deepStrictEqual(ids(service.searchDocs('toggles', 'xpto', 'spec')), ['do-xpto'])
    })

    it('⛔ o texto do modelo não vira operador do FTS; sem termo, nada', () => {
      const service = seeded()
      assert.deepStrictEqual(service.searchDocs('title: NEAR(flags) AND "', undefined), service.searchDocs('title near flags and'))
      assert.deepStrictEqual(service.searchDocs('  ?! '), [])
    })

    it('o índice acompanha o cadastro: editar e apagar valem na hora', () => {
      const service = seeded()
      service.updateDoc('api-rest', { body: 'Versionamento por cabeçalho.' }, 'root')
      assert.deepStrictEqual(ids(service.searchDocs('paginação')), [])
      assert.deepStrictEqual(ids(service.searchDocs('versionamento')), ['api-rest'])
      service.deleteDoc('feature-flags')
      assert.deepStrictEqual(ids(service.searchDocs('liberação')), [])
      service.removeProject('xpto')
      assert.deepStrictEqual(ids(service.searchDocs('toggles', 'xpto')), [])
    })

    it('⚖️ com muitos documentos, o índice do prompt lista os recentes e manda buscar o resto', () => {
      const service = build()
      for (let index = 0; index < 33; index += 1) service.createDoc({ ...doc(`doc-${String(index).padStart(2, '0')}`) }, 'root')
      const index = service.environmentParts().index!
      assert.strictEqual(index.split('\n').filter((line) => line.startsWith('- [spec]')).length, 30)
      assert.match(index, /- … e mais 3 documento\(s\): ache com search_docs\.$/)
      assert.match(index, /use search_docs/)
    })
  })
})
