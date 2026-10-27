import { describe, expect, it } from 'vitest'
import { toolsTokens, toolTokens } from './toolTokens'

describe('toolTokens', () => {
  it('pesa nome, descrição e esquema; o esquema grande é o que mais pesa', () => {
    const small = { name: 'ping', description: 'Ping.' }
    const big = {
      name: 'save_agent',
      description: 'Create an agent.',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, { type: 'string', description: 'A field of the agent.' }])),
      },
    }
    expect(toolTokens(small)).toBe(Math.ceil(JSON.stringify({ name: 'ping', description: 'Ping.', input_schema: {} }).length / 4))
    expect(toolTokens(big)).toBeGreaterThan(toolTokens(small) * 10)
    expect(toolsTokens([small, big])).toBe(toolTokens(small) + toolTokens(big))
  })
})
