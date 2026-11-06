import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentInUseError, AgentNotFoundError, InvalidAgentError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { AgentCatalog, ISaveAgentOptions } from './Agent.Catalog'

describe('AgentCatalog', () => {
  const base: IAgent = {
    id: 'pesquisa',
    name: 'Pesquisa',
    providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash'] }],
    systemPrompt: 'pesquise',
    modes: [EMode.CHAT],
    allowedTools: ['search_web'],
  }
  const custom: IAgent = { ...base, id: 'juridico', name: 'Jurídico' }

  const options = (creating: boolean): ISaveAgentOptions => ({
    rules: { knownTools: ['search_web'], providerOf: () => EProvider.GOOGLE },
    by: 'root@x.test',
    creating,
  })

  const build = () => new AgentCatalog(new NullAgentRepository())

  it('lista os agentes na ordem em que foram criados, e acha cada um por id', () => {
    const catalog = build()
    catalog.save(base, options(true))
    catalog.save(custom, options(true))

    assert.deepStrictEqual(
      catalog.entries().map((entry) => entry.agent.id),
      ['pesquisa', 'juridico'],
    )
    assert.strictEqual(catalog.get('juridico')?.name, 'Jurídico')
    assert.strictEqual(catalog.entry('juridico')?.updatedBy, 'root@x.test')
    assert.strictEqual(catalog.fallback()?.id, 'pesquisa')
  })

  it('o terminal do agente (tempo e saída) atravessa o cadastro', () => {
    const catalog = build()
    catalog.save({ ...custom, terminal: { timeoutSeconds: 600, maxOutputChars: 20_000 } }, options(true))
    assert.deepStrictEqual(catalog.get('juridico')?.terminal, { timeoutSeconds: 600, maxOutputChars: 20_000 })
  })

  it('as variáveis de ambiente do agente atravessam o cadastro; nome reservado é recusado', () => {
    const catalog = build()
    const env = { GIT_AUTHOR_NAME: 'Maya', GIT_AUTHOR_EMAIL: 'maya@x.test' }
    catalog.save({ ...custom, env }, options(true))
    assert.deepStrictEqual(catalog.get('juridico')?.env, env)
    assert.throws(() => catalog.save({ ...custom, env: { GATEWAY_AGENT_ID: 'outro' } }, options(false)), InvalidAgentError)
    // Sem variáveis, o campo some (e não fica `{}` gravado).
    catalog.save({ ...custom, env: {} }, options(false))
    assert.strictEqual(catalog.get('juridico')?.env, undefined)
  })

  it('saveTriggers: só os triggers mudam, passando pela regra; o agente de fábrica não existe para isso', () => {
    const catalog = build()
    catalog.save(custom, options(true))
    const brief = { id: 'morning-brief', when: 'a pessoa diz bom dia', body: 'Briefing.' }
    catalog.saveTriggers('juridico', [brief], 'agent:maya')
    assert.deepStrictEqual(catalog.get('juridico')?.triggers, [brief])
    assert.strictEqual(catalog.entry('juridico')?.updatedBy, 'agent:maya')
    assert.strictEqual(catalog.get('juridico')?.systemPrompt, 'pesquise')
    assert.throws(() => catalog.saveTriggers('juridico', [brief, brief], 'x'), InvalidAgentError)
    catalog.saveTriggers('juridico', [], 'agent:maya')
    assert.strictEqual(catalog.get('juridico')?.triggers, undefined)
    assert.throws(() => catalog.saveTriggers('nao-existe', [brief], 'x'), AgentNotFoundError)
  })

  it('todo agente é editável e apagável, inclusive o primeiro', () => {
    const repository = new NullAgentRepository()
    repository.save(base, 'seed')
    const catalog = new AgentCatalog(repository)

    catalog.save({ ...base, name: 'outro' }, options(false))
    assert.strictEqual(catalog.get('pesquisa')?.name, 'outro')

    catalog.remove('pesquisa', 'admin')
    assert.strictEqual(catalog.get('pesquisa'), undefined)
  })

  it('criar com id já criado é recusado; atualizar o que não existe é 404', () => {
    const catalog = build()
    catalog.save(custom, options(true))

    assert.throws(() => catalog.save(custom, options(true)), InvalidAgentError)
    assert.throws(() => catalog.save({ ...custom, id: 'nunca-criado' }, options(false)), AgentNotFoundError)
  })

  it('atualizar troca o agente; apagar tira da lista', () => {
    const catalog = build()
    catalog.save(custom, options(true))

    catalog.save({ ...custom, name: 'Jurídico 2' }, options(false))
    assert.strictEqual(catalog.get('juridico')?.name, 'Jurídico 2')

    catalog.remove('juridico', 'admin')
    assert.strictEqual(catalog.get('juridico'), undefined)
    assert.throws(() => catalog.remove('juridico', 'admin'), AgentNotFoundError)
  })

  it('o papel de subagente sobrevive à gravação; sem ele, volta a agente normal', () => {
    const catalog = build()
    catalog.save({ ...custom, role: 'subagent' }, options(true))
    assert.strictEqual(catalog.get('juridico')?.role, 'subagent')

    catalog.save(custom, options(false))
    assert.strictEqual(catalog.get('juridico')?.role, undefined)
  })

  it('⚖️ só oferece os modelos ATIVADOS no catálogo; desligar tira de todos sem reescrever o agente', () => {
    const enabled = new Set(['claude-sonnet-5'])
    const repository = new NullAgentRepository()
    repository.save({ ...custom, providers: [{ provider: 'claude', models: ['claude-sonnet-5', 'claude-opus-5'] }] }, 'x')
    const catalog = new AgentCatalog(repository, (_provider, model) => enabled.has(model))

    assert.deepStrictEqual(catalog.get('juridico')?.providers[0].models, ['claude-sonnet-5'])
    assert.deepStrictEqual(catalog.unusableModels(repository.list()[0]), { claude: ['claude-opus-5'] })

    enabled.delete('claude-sonnet-5')
    assert.deepStrictEqual(catalog.get('juridico')?.providers[0].models, [])
    assert.deepStrictEqual(repository.list()[0].providers[0].models, ['claude-sonnet-5', 'claude-opus-5'])
  })
  it('o padrão é o primeiro que pode rodar e não é subagente', () => {
    const repository = new NullAgentRepository()
    repository.save(base, 'x')
    repository.save({ ...custom, id: 'sub', role: 'subagent' }, 'x')
    repository.save({ ...custom, id: 'ok' }, 'x')
    const catalog = new AgentCatalog(repository, undefined, (agent) => agent.id !== 'pesquisa')

    assert.strictEqual(catalog.fallback()?.id, 'ok')

    const only = new NullAgentRepository()
    only.save(base, 'x')
    assert.strictEqual(new AgentCatalog(only, undefined, () => false).fallback(), undefined)
  })

  it('⛔ não apaga agente a quem outro delega, nem o padrão das configurações; diz quem referencia', () => {
    const catalog = build()
    catalog.save(custom, options(true))
    catalog.save({ ...custom, id: 'chefe', allowedTools: ['search_web', 'agent:juridico'] }, { ...options(true), rules: { ...options(true).rules, agentExists: () => true } })

    assert.throws(
      () => catalog.remove('juridico', 'admin'),
      (error: unknown) => error instanceof AgentInUseError && error.delegators.join() === 'chefe' && !error.isDefault,
    )
    assert.throws(
      () => catalog.remove('chefe', 'admin', { defaultAgentId: 'chefe' }),
      (error: unknown) => error instanceof AgentInUseError && error.isDefault,
    )

    catalog.remove('chefe', 'admin')
    catalog.remove('juridico', 'admin')
    assert.strictEqual(catalog.get('juridico'), undefined)
  })

  it('⚖️ os agentes do core: o get os acha, a lista não (nem o padrão); e o id deles não serve para agente do catálogo', () => {
    const core: IAgent = { ...base, id: 'builder-skill', name: 'Construtor de skills', adminOnly: true }
    const catalog = new AgentCatalog(new NullAgentRepository(), undefined, undefined, () => [core])
    assert.strictEqual(catalog.get('builder-skill')?.name, 'Construtor de skills')
    assert.deepStrictEqual(catalog.list(), [])
    assert.strictEqual(catalog.fallback(), undefined)
    assert.throws(() => catalog.save({ ...base, id: 'builder-skill' }, options(true)), InvalidAgentError)
  })

  it('arquivos do agente: conteúdo não enviado é recusado; a pasta acompanha o projeto e sai com o agente', () => {
    const blobs = new Set(['a'.repeat(64)])
    const dirs = new Map<string, string[]>()
    const key = (id: string, projectId?: string) => `${projectId ?? 'global'}/${id}`
    const catalog = build()
    catalog.useFiles({
      has: (sha) => blobs.has(sha),
      put: () => ({ sha256: '', bytes: 0 }),
      read: () => undefined,
      dirOf: (_kind, id, projectId) => `/dados/${key(id, projectId)}`,
      sync: () => undefined,
      remove: (_kind, id, projectId) => void dirs.delete(key(id, projectId)),
      writeAgent: (id, projectId, files, removed) =>
        void dirs.set(
          key(id, projectId),
          [...new Set([...(dirs.get(key(id, projectId)) ?? []).filter((path) => !removed.includes(path)), ...files.map((file) => file.path)])].sort(),
        ),
      restoreAgent: () => undefined,
      moveAgent: (id, from, to) => {
        const moved = dirs.get(key(id, from))
        dirs.delete(key(id, from))
        if (moved) dirs.set(key(id, to), moved)
      },
      snapshotAgent: (id, projectId) => (dirs.get(key(id, projectId)) ?? []).map((path) => ({ path, sha256: 'a'.repeat(64), bytes: 3 })),
    })
    const file = (path: string, char: string) => ({ path, sha256: char.repeat(64), bytes: 3 })
    assert.throws(() => catalog.save({ ...base, files: [file('b.sh', 'b')] }, options(true)), /content not uploaded: b\.sh/)
    catalog.save({ ...base, files: [file('a.sh', 'a')] }, options(true))
    assert.deepStrictEqual([...dirs.entries()], [['global/pesquisa', ['a.sh']]])
    assert.strictEqual(catalog.filesDir(catalog.get('pesquisa')!), '/dados/global/pesquisa')
    catalog.moveToProject('pesquisa', 'alfa', 'root')
    assert.deepStrictEqual([...dirs.keys()], ['alfa/pesquisa'])
    // Só os arquivos (a guia Arquivos): o resto do agente fica; conteúdo não enviado é recusado.
    assert.throws(() => catalog.saveFiles('pesquisa', [file('b.sh', 'b')], 'root'), /content not uploaded/)
    catalog.saveFiles('pesquisa', [], 'root')
    assert.deepStrictEqual([catalog.get('pesquisa')?.files, catalog.get('pesquisa')?.systemPrompt, dirs.get('alfa/pesquisa')], [undefined, 'pesquise', []])
    catalog.saveFiles('pesquisa', [file('a.sh', 'a')], 'root')
    catalog.save({ ...base, id: 'outro', name: 'Outro' }, options(true))
    catalog.remove('pesquisa', 'root')
    assert.deepStrictEqual(
      [...dirs.keys()].filter((name) => name.endsWith('/pesquisa')),
      [],
    )
  })

  it('⚖️ a pasta é do agente: salvar não apaga o que ele gravou; a tela apaga só o que tirou (base)', () => {
    const blobs = new Set(['a'.repeat(64), 'b'.repeat(64)])
    const disk = new Set<string>()
    const writes: Array<{ files: string[]; removed: string[] }> = []
    const catalog = build()
    catalog.useFiles({
      has: (sha) => blobs.has(sha),
      put: () => ({ sha256: '', bytes: 0 }),
      read: () => undefined,
      dirOf: (_kind, id) => `/dados/${id}`,
      sync: () => assert.fail('a pasta do agente nunca é trocada inteira'),
      remove: () => undefined,
      writeAgent: (_id, _projectId, files, removed) => {
        writes.push({ files: files.map((file) => file.path), removed: [...removed] })
        for (const path of removed) disk.delete(path)
        for (const file of files) disk.add(file.path)
      },
      restoreAgent: () => undefined,
      moveAgent: () => undefined,
      snapshotAgent: () => [...disk].sort().map((path) => ({ path, sha256: 'a'.repeat(64), bytes: 3 })),
    })
    const file = (path: string, char: string) => ({ path, sha256: char.repeat(64), bytes: 3 })
    catalog.save({ ...base, files: [file('run.sh', 'a')] }, options(true))
    disk.add('notas.md') // o agente gravou
    // O Salvar do formulário com a lista igual não mexe na pasta.
    catalog.save({ ...base, systemPrompt: 'outro', files: [file('run.sh', 'a')] }, options(false))
    assert.strictEqual(writes.length, 1)
    // A tela troca o run.sh e tira um arquivo que mostrava; o notas.md, que ela não tirou, fica.
    disk.add('velho.txt')
    catalog.saveFiles('pesquisa', [file('run.sh', 'b')], 'root', ['run.sh', 'velho.txt'])
    assert.deepStrictEqual(writes.at(-1), { files: ['run.sh'], removed: ['velho.txt'] })
    assert.deepStrictEqual([...disk].sort(), ['notas.md', 'run.sh'])
    assert.deepStrictEqual(
      catalog.liveFiles(catalog.get('pesquisa')!)?.map((item) => item.path),
      ['notas.md', 'run.sh'],
    )
  })
})
