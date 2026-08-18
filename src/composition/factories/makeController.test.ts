import { describe, it } from 'node:test'
import assert from 'node:assert'
import { makeController } from './makeController'
import { AgentController } from '@application/Agent.Controller'

describe('makeController Factory', () => {
  it('should return an instance of AgentController', () => {
    const controller = makeController()
    assert.ok(controller instanceof AgentController)
  })
})
