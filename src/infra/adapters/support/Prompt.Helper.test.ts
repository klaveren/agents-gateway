import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { composeSystemPrompt } from './Prompt.Helper'

describe('composeSystemPrompt — soul', () => {
  const agent: IAgent = { id: 'a', name: 'A', provider: EProvider.CLAUDE, systemPrompt: 'Responda sobre o CRM.', models: ['m'], modes: [EMode.CHAT], allowedTools: [] }

  it('sem soul, o prompt de sempre', () => {
    assert.strictEqual(composeSystemPrompt(agent, {}), 'Responda sobre o CRM.')
  })

  it('com soul: quem o agente é, depois como ele trabalha — também quando a sessão troca o prompt', () => {
    const withSoul = { ...agent, soul: 'Você é a Íris, gentil e direta.' }
    assert.strictEqual(composeSystemPrompt(withSoul, {}), '## Quem você é\nVocê é a Íris, gentil e direta.\n\n## Como você trabalha\nResponda sobre o CRM.')
    assert.match(composeSystemPrompt(withSoul, { systemPrompt: 'Outra tarefa.', language: 'English' }), /^## Quem você é\nVocê é a Íris[\s\S]*Outra tarefa\.[\s\S]*English/)
  })
})
