import assert from 'node:assert'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { makeLocalTools } from '../Local.Tools'
import { toZodShape } from './Claude.ToolBridge'

describe('toZodShape', () => {
  it('lista de objetos com enum vira zod de verdade (as tarefas do update_todos), e o resto continua como era', () => {
    const tool = makeLocalTools({ todos: { saveTodos: async () => {} } }).find((item) => item.name === 'update_todos')!
    const schema = z.object(toZodShape(tool))
    assert.ok(schema.safeParse({ items: [{ title: 'Ler', status: 'done' }] }).success)
    assert.ok(!schema.safeParse({ items: [{ title: 'Ler', status: 'feito' }] }).success)
    assert.ok(!schema.safeParse({ items: [{ status: 'done' }] }).success)
    assert.ok(!schema.safeParse({}).success)

    const bash = z.object(toZodShape(makeLocalTools({}).find((item) => item.name === 'run_bash')!))
    assert.ok(bash.safeParse({ command: 'ls' }).success)
  })
})
