import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ambientSection, conversationNote } from './Ambient.Policy'

describe('Ambient.Policy', () => {
  it('sem projeto nem diretório: o agente e a pasta vazia da conversa', () => {
    assert.strictEqual(ambientSection({ agentId: 'atlas' }), '## Ambiente\n- Agente: atlas.\n- Diretório de trabalho: uma pasta vazia, só desta conversa.')
  })

  it('o agente do projeto: o projeto e a pasta dele', () => {
    assert.strictEqual(
      ambientSection({ agentId: 'dev', project: { id: 'alfa', name: 'Alfa', own: true }, directory: '/dados/projects/alfa' }),
      [
        '## Ambiente',
        '- Agente: dev.',
        '- Projeto: Alfa (projectId "alfa").',
        '- Diretório de trabalho: /dados/projects/alfa — persistente e compartilhado pelas conversas do projeto. Fora dele você não lê nem grava.',
      ].join('\n'),
    )
  })

  it('o global numa conversa do projeto: o que ele criar pertence ao projeto; sem nome, só o id', () => {
    assert.strictEqual(
      ambientSection({ agentId: 'atlas', project: { id: 'alfa', own: false } }),
      [
        '## Ambiente',
        '- Agente: atlas.',
        '- Projeto atual: projectId "alfa". Agentes, hooks e conversas que você criar aqui pertencem a este projeto.',
        '- Diretório de trabalho: uma pasta vazia, só desta conversa.',
      ].join('\n'),
    )
  })

  it('aberta numa worktree: o repositório, a worktree, o branch e a pasta dela', () => {
    const text = ambientSection({
      agentId: 'dev',
      project: { id: 'alfa', name: 'Alfa', own: false },
      repository: { name: 'gateway', worktree: 'wt-x', branch: 'feat/x' },
      directory: '/dados/projects/alfa/repositories/gateway/_wt/wt-x',
    })
    assert.match(text, /\n- Projeto: Alfa \(projectId "alfa"\)\.\n- Repositório: gateway, worktree wt-x \(branch feat\/x\)\.\n/)
    assert.match(text, /- Diretório de trabalho: \/dados\/projects\/alfa\/repositories\/gateway\/_wt\/wt-x\. Fora dele você não lê nem grava; o git dele funciona/)
  })

  it('o id da conversa, numa linha marcada como do sistema', () => {
    assert.strictEqual(conversationNote('gw_01ABC'), '<contexto>id desta conversa: gw_01ABC</contexto>')
  })
})
