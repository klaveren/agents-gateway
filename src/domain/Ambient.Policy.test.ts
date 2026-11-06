import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ambientSection, conversationNote } from './Ambient.Policy'

describe('Ambient.Policy', () => {
  it('com o painel: um item por pedido, e as etapas do item no update_todos', () => {
    const section = ambientSection({ agentId: 'atlas', panel: true })
    assert.match(section, /\*\*Um item por pedido\.\*\*/)
    assert.match(section, /Nunca um item genérico/)
    assert.match(section, /As etapas do item vão no `update_todos`/)
  })

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

  it('o agente com arquivos sabe onde eles estão (só leitura)', () => {
    const reading = ambientSection({ agentId: 'maya', files: { dir: '/dados/global/agents/maya', write: false } })
    assert.match(reading, /- Sua pasta: \/dados\/global\/agents\/maya — privada, sua: nenhum outro agente a vê\./)
    assert.match(reading, /só leitura para você: gravar pede Escrever arquivos/)
    assert.match(ambientSection({ agentId: 'maya', files: { dir: '/dados/global/agents/maya', write: true } }), /Leia e grave nela seus scripts, notas e dados de trabalho/)
    // O terminal: a linha da pasta temporária (o /tmp dele some a cada comando); sem terminal, nada.
    assert.match(ambientSection({ agentId: 'maya', terminal: true }), /use `\$TMPDIR` \(persiste entre os comandos do terminal\)\. O `\/tmp` do terminal é apagado a cada comando/)
    assert.doesNotMatch(ambientSection({ agentId: 'maya' }), /TMPDIR/)
  })
})
