import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { HttpError } from './Http.Error'
import { parseBody } from './Request.Parser'
import { createSessionSchema, sendMessageSchema } from './Request.Schema'

describe('request validation', () => {
  const reject = (schema: Parameters<typeof parseBody>[0], body: unknown) => {
    try {
      parseBody(schema, body)
      assert.fail('esperava recusa')
    } catch (error: unknown) {
      assert.ok(error instanceof HttpError)
      assert.strictEqual(error.status, 422)
      assert.strictEqual(error.code, 'validation_error')
      return error
    }
  }

  it('accepts a minimal session body and keeps the optional fields optional', () => {
    assert.deepStrictEqual(parseBody(createSessionSchema, { agentId: 'researcher-agent' }), {
      agentId: 'researcher-agent',
    })
  })

  it('accepts a full session body', () => {
    const body = {
      agentId: 'sysops-agent',
      mode: EMode.AGENT,
      model: 'claude-opus-5',
      reasoning: 'high',
      language: 'Portuguese',
      metadata: { origin: 'cli' },
    }

    assert.deepStrictEqual(parseBody(createSessionSchema, body), body)
  })

  it('names the missing field', () => {
    const error = reject(createSessionSchema, {})
    assert.deepStrictEqual(error.details, [{ field: 'agentId', message: 'agentId is required' }])
  })

  it('refuses a lane that is not a lane', () => {
    reject(createSessionSchema, { agentId: 'researcher-agent', mode: 'telepathy' })
  })

  it('defaults the message to empty but demands text or attachment', () => {
    reject(sendMessageSchema, {})
    reject(sendMessageSchema, { message: '   ' })

    assert.strictEqual(parseBody(sendMessageSchema, { message: 'oi' }).message, 'oi')
  })

  it('accepts an attachment with no text at all', () => {
    const body = { message: '', files: [{ name: 'a.png', mimeType: 'image/png', data: 'aaa' }] }
    assert.strictEqual(parseBody(sendMessageSchema, body).files?.length, 1)
  })

  it('refuses a malformed attachment and an oversized one', () => {
    reject(sendMessageSchema, { message: 'oi', files: [{ name: 'a.png' }] })
    reject(sendMessageSchema, {
      message: 'oi',
      files: [{ name: 'a.png', mimeType: 'image/png', data: 'a'.repeat(9 * 1024 * 1024) }],
    })
  })
})
