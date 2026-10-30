import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { composeSystemPrompt } from './Prompt.Helper'

describe('composeSystemPrompt — soul', () => {
  const agent: IAgent = {
    id: 'a',
    name: 'A',
    providers: [{ provider: EProvider.CLAUDE, models: ['m'] }],
    systemPrompt: 'Responda sobre o CRM.',
    modes: [EMode.CHAT],
    allowedTools: [],
  }

  it('sem soul, o prompt de sempre', () => {
    assert.strictEqual(composeSystemPrompt(agent, {}), 'Responda sobre o CRM.')
  })

  it('com soul: quem o agente é, depois como ele trabalha — também quando a sessão troca o prompt', () => {
    const withSoul = { ...agent, soul: 'Você é a Íris, gentil e direta.' }
    assert.strictEqual(composeSystemPrompt(withSoul, {}), '## Quem você é\nVocê é a Íris, gentil e direta.\n\n## Como você trabalha\nResponda sobre o CRM.')
    assert.match(composeSystemPrompt(withSoul, { systemPrompt: 'Outra tarefa.', language: 'English' }), /^## Quem você é\nVocê é a Íris[\s\S]*Outra tarefa\.[\s\S]*English/)
  })

  it('as regras do ambiente e o índice vêm depois do que o agente faz, antes do idioma', () => {
    const prompt = composeSystemPrompt({ ...agent, soul: 'Íris.' }, { environment: '## Regras do ambiente\n1. **A** — b', language: 'English' })
    assert.match(prompt, /## Como você trabalha\nResponda sobre o CRM\.\n\n## Regras do ambiente\n1\. \*\*A\*\* — b\n\nIMPORTANT: Please reply exclusively in English\.$/)
  })

  it('o "## Ambiente" (agente, projeto, diretório) vem depois do que o agente faz e antes das regras, sem mexer nelas', () => {
    const prompt = composeSystemPrompt(agent, {
      ambient: { agentId: 'a', project: { id: 'alfa', name: 'Alfa', own: true }, directory: '/dados/projects/alfa' },
      environment: '## Regras do ambiente\n1. **A** — b',
    })
    assert.match(
      prompt,
      /^Responda sobre o CRM\.\n\n## Ambiente\n- Agente: a\.\n- Projeto: Alfa \(projectId "alfa"\)\.\n- Diretório de trabalho: \/dados\/projects\/alfa — [^\n]+\n\n## Regras do ambiente\n1\. \*\*A\*\* — b$/,
    )
    assert.strictEqual(
      composeSystemPrompt(agent, { ambient: { agentId: 'a' } }),
      'Responda sobre o CRM.\n\n## Ambiente\n- Agente: a.\n- Diretório de trabalho: uma pasta vazia, só desta conversa.',
    )
  })
})
