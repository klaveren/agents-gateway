import { describe, it } from 'node:test'
import assert from 'node:assert'
import { makeUsecases } from './makeUsecases'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'

describe('makeUsecases Factory', () => {
  it('should create and return all use cases', () => {
    const usecases = makeUsecases()
    assert.ok(usecases.createSessionUseCase instanceof CreateSessionUseCase)
    assert.ok(usecases.sendMessageUseCase instanceof SendMessageUseCase)
    assert.ok(usecases.cancelSessionUseCase instanceof CancelSessionUseCase)
  })
})
