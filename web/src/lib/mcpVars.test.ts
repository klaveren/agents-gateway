import { describe, expect, it } from 'vitest'
import { mcpVarRows, mcpVarsOf } from './mcpVars'

describe('as variáveis do MCP na tela', () => {
  it('ida e volta: fixas com valor, do projeto e secretas só com o nome', () => {
    const model = { vars: { N8N_MODE: 'api' }, projectVars: ['N8N_URL'], env: ['N8N_API_KEY'] }
    const rows = mcpVarRows(model)
    expect(rows.map((row) => [row.name, row.kind, row.value])).toEqual([
      ['N8N_MODE', 'fixed', 'api'],
      ['N8N_URL', 'project', ''],
      ['N8N_API_KEY', 'secret', ''],
    ])
    expect(mcpVarsOf(rows)).toEqual(model)
  })

  it('a linha sem nome sai; o nome vira maiúsculas; trocar o tipo leva o nome, e a fixa sem valor fica vazia', () => {
    const rows = mcpVarsOf([
      { name: ' token ', kind: 'secret', value: 'ignorado' },
      { name: '', kind: 'fixed', value: 'x' },
      { name: 'modo', kind: 'fixed', value: '' },
    ])
    expect(rows).toEqual({ vars: { MODO: '' }, env: ['TOKEN'] })
    expect(mcpVarsOf([])).toEqual({ env: [] })
  })
})
