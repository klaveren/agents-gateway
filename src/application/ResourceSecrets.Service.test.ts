import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { InvalidGuidanceError } from '@domain/errors/Domain.Error'
import type { IKnownSecret } from '@domain/Secret.Mask'
import { SqliteResourceSecretRepository } from '@infra/persistence/Sqlite.ResourceSecretRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { ResourceSecretsService } from './ResourceSecrets.Service'

describe('ResourceSecretsService', () => {
  function setup(fixed: Record<string, Record<string, string>> = {}) {
    const masked: Array<{ sessionId: string; secrets: readonly IKnownSecret[] }> = []
    const exists = new Set(['agent:theo', 'skill:gitlab', 'command:deploy'])
    const service = new ResourceSecretsService({
      store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
      exists: (scope, id) => exists.has(`${scope}:${id}`),
      resourceEnv: (kind, id) => fixed[`${kind}:${id}`],
      mask: { register: (sessionId, secrets) => masked.push({ sessionId, secrets }) },
    })
    return { service, masked }
  }

  it('grava com o valor; recusa nome inválido, recurso que não existe, valor vazio e variável nova sem valor', () => {
    const { service } = setup()
    const saved = service.save('agent', 'theo', { name: 'API_TOKEN', value: 'tok-1234567890' }, 'root')
    assert.deepStrictEqual([saved.name, 'value' in saved], ['API_TOKEN', false])
    for (const [scope, id, input] of [
      ['agent', 'theo', { name: 'minusculo', value: 'x'.repeat(10) }],
      ['skill', 'nao-existe', { name: 'TOKEN', value: 'x'.repeat(10) }],
      ['agent', 'theo', { name: 'API_TOKEN', value: '  ' }],
      ['agent', 'theo', { name: 'NOVA' }],
    ] as const)
      assert.throws(() => service.save(scope, id, input, 'root'), InvalidGuidanceError, JSON.stringify(input))
  })

  it('⚖️ a do agente vale sempre; a da skill e a do command só depois de carregados NA conversa', () => {
    const { service, masked } = setup()
    service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'do-agente-123' }, 'root')
    service.save('skill', 'gitlab', { name: 'GITLAB_TOKEN', value: 'glpat-da-skill' }, 'root')
    service.save('command', 'deploy', { name: 'GITLAB_TOKEN', value: 'glpat-do-command' }, 'root')
    assert.deepStrictEqual(service.envFor('theo', 'c1').env, { AGENTE_TOKEN: 'do-agente-123' })

    service.markLoaded('c1', 'skill', 'gitlab')
    assert.deepStrictEqual(service.envFor('theo', 'c1').env, { AGENTE_TOKEN: 'do-agente-123', GITLAB_TOKEN: 'glpat-da-skill' })
    // Outra conversa não carregou nada.
    assert.deepStrictEqual(service.envFor('theo', 'c2').env, { AGENTE_TOKEN: 'do-agente-123' })
    // O command vence a skill.
    service.markLoaded('c1', 'command', 'deploy')
    assert.strictEqual(service.envFor('theo', 'c1').env.GITLAB_TOKEN, 'glpat-do-command')

    // ⛔ O que foi entregue entra na máscara da conversa, com o nome como rótulo.
    assert.ok(masked.some((entry) => entry.sessionId === 'c1' && entry.secrets.some((secret) => secret.label === 'GITLAB_TOKEN' && secret.value === 'glpat-do-command')))
  })

  it('⚖️ as FIXAS da skill carregada entram por baixo das secretas, fora da máscara e fora dos nomes de secretas', () => {
    const { service, masked } = setup({ 'skill:gitlab': { GITLAB_URL: 'https://gitlab.interno', GITLAB_TOKEN: 'fixa-perde' } })
    service.save('skill', 'gitlab', { name: 'GITLAB_TOKEN', value: 'glpat-da-skill' }, 'root')
    assert.deepStrictEqual(service.envFor('theo', 'c1').env, {})
    service.markLoaded('c1', 'skill', 'gitlab')
    const loaded = service.envFor('theo', 'c1')
    assert.deepStrictEqual(loaded.env, { GITLAB_URL: 'https://gitlab.interno', GITLAB_TOKEN: 'glpat-da-skill' })
    assert.deepStrictEqual(
      loaded.sources.map((source) => source.name),
      ['GITLAB_TOKEN'],
    )
    assert.ok(!masked.some((entry) => entry.secrets.some((secret) => secret.value === 'https://gitlab.interno')), 'a fixa não vai para a máscara')
  })

  it('o prompt recebe só os nomes: os do agente e os dos recursos que ele pode carregar', () => {
    const { service } = setup()
    service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'do-agente-123' }, 'root')
    service.save('skill', 'gitlab', { name: 'GITLAB_TOKEN', value: 'glpat-da-skill' }, 'root')
    const ambient = service.ambientFor('theo', [
      { kind: 'skill', id: 'gitlab' },
      { kind: 'command', id: 'deploy' },
    ])
    assert.deepStrictEqual(ambient, { agent: ['AGENTE_TOKEN'], resources: [{ kind: 'skill', id: 'gitlab', names: ['GITLAB_TOKEN'] }] })
    assert.ok(!JSON.stringify(ambient).includes('glpat'))
    assert.strictEqual(setup().service.ambientFor('theo', []), undefined)
  })
  describe('por projeto', () => {
    // `deploy` é de alfa, compartilhada com beta; theo é de alfa, bea é de beta, gus é global.
    function shared() {
      const service = new ResourceSecretsService({
        store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
        exists: () => true,
        agentProject: (id) => ({ theo: 'alfa', bea: 'beta', gus: null })[id],
        resourceProject: (id) => ({ deploy: 'alfa', geral: null })[id],
      })
      service.save('skill', 'deploy', { name: 'TOKEN', description: 'deploy', value: 'valor-do-alfa' }, 'ana')
      service.save('skill', 'deploy', { name: 'TOKEN', value: 'valor-do-beta' }, 'bia', 'beta')
      return service
    }

    it('⛔ o agente do projeto que recebeu usa os valores DELE; o da origem, os da origem; o global, os da origem', () => {
      const service = shared()
      for (const agent of ['theo', 'bea', 'gus']) service.markLoaded(`c-${agent}`, 'skill', 'deploy')
      assert.strictEqual(service.envFor('theo', 'c-theo').env.TOKEN, 'valor-do-alfa')
      assert.strictEqual(service.envFor('bea', 'c-bea').env.TOKEN, 'valor-do-beta')
      assert.strictEqual(service.envFor('gus', 'c-gus').env.TOKEN, 'valor-do-alfa')
    })

    it('⛔ o projeto que recebeu e não configurou NÃO herda o valor da origem', () => {
      const service = shared()
      service.remove('skill', 'deploy', 'TOKEN', 'beta')
      service.markLoaded('c1', 'skill', 'deploy')
      assert.deepStrictEqual(service.envFor('bea', 'c1').env, {})
      assert.deepStrictEqual(service.ambientFor('bea', [{ kind: 'skill', id: 'deploy' }]), undefined)
    })

    it('o prompt do agente que recebeu traz só os nomes que ele configurou', () => {
      const service = shared()
      assert.deepStrictEqual(service.ambientFor('bea', [{ kind: 'skill', id: 'deploy' }]), { agent: [], resources: [{ kind: 'skill', id: 'deploy', names: ['TOKEN'] }] })
    })

    it('a lista do projeto que recebeu traz os nomes da origem que faltam (sem valor); a da origem, só os seus', () => {
      const service = shared()
      service.save('skill', 'deploy', { name: 'OUTRO', description: 'outra', value: 'x'.repeat(10) }, 'ana')
      const beta = service.list('skill', 'deploy', 'beta')
      assert.deepStrictEqual(
        beta.map((item) => [item.name, item.configured, item.updatedAt !== undefined]),
        [
          ['OUTRO', false, false],
          ['TOKEN', true, true],
        ],
      )
      assert.strictEqual(beta[0]!.description, 'outra')
      assert.deepStrictEqual(
        service.list('skill', 'deploy').map((item) => [item.name, item.configured]),
        [
          ['OUTRO', true],
          ['TOKEN', true],
        ],
      )
      assert.ok(!JSON.stringify([...beta, ...service.list('skill', 'deploy')]).includes('valor-do'))
    })

    it('⛔ AGENTE compartilhado: na conversa do projeto que recebe vale o valor DELE; o segredo da origem não chega', () => {
      const service = shared()
      // theo (do alfa) é compartilhado com o beta: o alfa e o beta configuram os seus, com os mesmos nomes.
      service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'agente-do-alfa' }, 'ana')
      service.save('agent', 'theo', { name: 'SO_DO_ALFA', value: 'so-na-origem' }, 'ana')
      service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'agente-do-beta' }, 'bia', 'beta')
      service.markLoaded('c-alfa', 'skill', 'deploy')
      service.markLoaded('c-beta', 'skill', 'deploy')
      // Na origem (e sem projeto de conversa): os valores da origem.
      assert.deepStrictEqual(service.envFor('theo', 'c-alfa', 'alfa').env, { AGENTE_TOKEN: 'agente-do-alfa', SO_DO_ALFA: 'so-na-origem', TOKEN: 'valor-do-alfa' })
      assert.strictEqual(service.envFor('theo', 'c-alfa').env.AGENTE_TOKEN, 'agente-do-alfa')
      // No beta: os do beta — o que o beta não configurou não vem (a skill do alfa também usa o valor do beta).
      assert.deepStrictEqual(service.envFor('theo', 'c-beta', 'beta').env, { AGENTE_TOKEN: 'agente-do-beta', TOKEN: 'valor-do-beta' })
      // O prompt do beta: só os nomes que o beta configurou.
      assert.deepStrictEqual(service.ambientFor('theo', [], 'beta'), { agent: ['AGENTE_TOKEN'], resources: [] })
      // A lista do beta mostra o nome que a origem usa e ele ainda não configurou.
      assert.deepStrictEqual(
        service.list('agent', 'theo', 'beta').map((item) => [item.name, item.configured]),
        [
          ['AGENTE_TOKEN', true],
          ['SO_DO_ALFA', false],
        ],
      )
      // O agente global numa conversa de projeto segue na origem (não é de projeto nenhum).
      assert.deepStrictEqual(service.envFor('gus', 'c-gus', 'beta').env, {})
    })

    it('⛔ parar de compartilhar o agente apaga os valores de quem saiu', () => {
      const service = shared()
      service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'agente-do-alfa' }, 'ana')
      service.save('agent', 'theo', { name: 'AGENTE_TOKEN', value: 'agente-do-beta' }, 'bia', 'beta')
      service.keepAgentProjects('theo', [])
      assert.deepStrictEqual(service.envFor('theo', 'c1', 'beta').env, {})
      assert.deepStrictEqual(
        service.list('agent', 'theo', 'beta').map((item) => item.configured),
        [false],
      )
      assert.strictEqual(service.envFor('theo', 'c1', 'alfa').env.AGENTE_TOKEN, 'agente-do-alfa')
    })

    it('⛔ deixar de compartilhar apaga os valores de quem saiu', () => {
      const service = shared()
      service.keepProjects('deploy', [])
      assert.deepStrictEqual(
        service.list('skill', 'deploy', 'beta').map((item) => item.configured),
        [false],
      )
      service.markLoaded('c1', 'skill', 'deploy')
      assert.deepStrictEqual(service.envFor('bea', 'c1').env, {})
      // A origem não perde nada.
      assert.strictEqual(service.envFor('theo', 'c1').env.TOKEN, 'valor-do-alfa')
    })
  })
  it('⚖️ a secreta do PROJETO vale para todo agente nas conversas dele, por baixo da do agente; o prompt lista os nomes', () => {
    const masked: Array<{ sessionId: string; secrets: readonly IKnownSecret[] }> = []
    const service = new ResourceSecretsService({
      store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
      exists: (scope, id) => ['agent:theo', 'project:alfa', 'project:beta', 'mcp:n8n'].includes(`${scope}:${id}`),
      agentProject: () => null,
      mask: { register: (sessionId, secrets) => masked.push({ sessionId, secrets }) },
    })
    service.save('project', 'alfa', { name: 'DB_URL', value: 'postgres://do-projeto' }, 'root')
    service.save('project', 'alfa', { name: 'API_TOKEN', value: 'do-projeto-123' }, 'root')
    service.save('agent', 'theo', { name: 'API_TOKEN', value: 'do-agente-456' }, 'root')
    assert.deepStrictEqual(service.envFor('theo', 'c1', 'alfa').env, { API_TOKEN: 'do-agente-456', DB_URL: 'postgres://do-projeto' })
    // Em outro projeto, não.
    assert.deepStrictEqual(service.envFor('theo', 'c2', 'beta').env, { API_TOKEN: 'do-agente-456' })
    assert.deepStrictEqual(service.ambientFor('theo', [], 'alfa'), { agent: ['API_TOKEN'], resources: [], project: ['API_TOKEN', 'DB_URL'] })
    assert.ok(masked.some((entry) => entry.sessionId === 'c1' && entry.secrets.some((secret) => secret.value === 'postgres://do-projeto')))

    // ⛔ O valor do MCP nunca entra no terminal do agente; sai só por `mcpEnv`, e a conversa o mascara.
    service.save('mcp', 'n8n', { name: 'N8N_API_KEY', value: 'chave-de-alfa' }, 'root', 'alfa')
    assert.strictEqual(service.envFor('theo', 'c1', 'alfa').env.N8N_API_KEY, undefined)
    assert.deepStrictEqual(service.mcpEnv('n8n', 'alfa', 'c9'), { N8N_API_KEY: 'chave-de-alfa' })
    assert.deepStrictEqual(service.mcpEnv('n8n', 'beta'), {})
    assert.ok(masked.some((entry) => entry.sessionId === 'c9' && entry.secrets[0].value === 'chave-de-alfa'))

    // O MCP trocou de chave: o valor vai junto (cifrado de novo), a chave velha some.
    service.moveScope('mcp', 'n8n', 'alfa.n8n', 'root')
    assert.deepStrictEqual([service.mcpEnv('n8n', 'alfa'), service.mcpEnv('alfa.n8n', 'alfa')], [{}, { N8N_API_KEY: 'chave-de-alfa' }])

    // O projeto saiu: as secretas dele e os valores que deu aos MCPs vão junto.
    service.removeProject('alfa')
    assert.deepStrictEqual([service.envFor('theo', 'c3', 'alfa').env, service.mcpEnv('alfa.n8n', 'alfa')], [{ API_TOKEN: 'do-agente-456' }, {}])
  })
  it('⚖️ o agente GLOBAL num projeto: os valores do projeto por cima, os da base onde o projeto não definiu; outro projeto, só a base', () => {
    const service = new ResourceSecretsService({
      store: new SqliteResourceSecretRepository(new SecretBox(randomBytes(32))),
      exists: () => true,
      agentProject: (id) => (id === 'atlas' ? null : 'bh'),
    })
    service.save('agent', 'atlas', { name: 'GL_TOKEN', value: 'da-base' }, 'root')
    service.save('agent', 'atlas', { name: 'LOG', value: 'da-base-log' }, 'root')
    service.save('agent', 'atlas', { name: 'GL_TOKEN', value: 'do-bh' }, 'ana', 'bh')
    assert.deepStrictEqual(service.envFor('atlas', 'c1', 'bh').env, { GL_TOKEN: 'do-bh', LOG: 'da-base-log' })
    assert.deepStrictEqual(service.envFor('atlas', 'c2', 'xpto').env, { GL_TOKEN: 'da-base', LOG: 'da-base-log' })
    assert.deepStrictEqual(service.envFor('atlas', 'c3').env, { GL_TOKEN: 'da-base', LOG: 'da-base-log' })
    assert.deepStrictEqual(service.ambientFor('atlas', [], 'bh')?.agent, ['GL_TOKEN', 'LOG'])
  })
})
