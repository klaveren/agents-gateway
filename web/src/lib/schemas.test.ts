import { describe, expect, it } from 'vitest'
import { offline } from './schemas'

describe('schemas — SchemaStore embutido', () => {
  it('referência a schema na internet vira "qualquer coisa"; a local fica', () => {
    const schema = {
      properties: {
        prettier: { $ref: 'https://www.schemastore.org/prettierrc.json', description: 'config' },
        name: { $ref: '#/definitions/name' },
        list: [{ $ref: 'http://x/y.json' }],
        relative: { $ref: 'eslintrc.json' },
      },
    }
    expect(offline(schema)).toEqual({ properties: { prettier: { description: 'config' }, name: { $ref: '#/definitions/name' }, list: [{}], relative: {} } })
  })
})
