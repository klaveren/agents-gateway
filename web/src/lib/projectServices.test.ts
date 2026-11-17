import { describe, expect, it } from 'vitest'
import { isServiceRule, serviceIssue, serviceOf, withServices } from './projectServices'
import type { IPermissionRule } from './types'

const net = (pattern: string, decision: 'allow' | 'deny' = 'allow', note?: string): IPermissionRule => ({ category: 'network', pattern, decision, ...(note ? { note } : {}) })

describe('os serviços do projeto', () => {
  it('serviço é a regra de rede exata host:porta: nem 80/443, nem localhost, nem curinga, nem negar', () => {
    expect(isServiceRule(net('10.10.0.3:6379'))).toBe(true)
    expect(isServiceRule(net('mongo.interno:27018'))).toBe(true)
    expect(isServiceRule(net('api.github.com:443'))).toBe(false)
    expect(isServiceRule(net('localhost:3000'))).toBe(false)
    expect(isServiceRule(net('*.interno:6379'))).toBe(false)
    expect(isServiceRule(net('10.10.0.3:6379', 'deny'))).toBe(false)
    expect(isServiceRule({ category: 'terminal', pattern: 'a:1', decision: 'allow' })).toBe(false)
  })

  it('a nota é o nome', () => {
    expect(serviceOf(net('10.10.0.3:9092', 'allow', 'Kafka'))).toEqual({ name: 'Kafka', host: '10.10.0.3', port: '9092' })
  })

  it('diz o que está errado na linha', () => {
    expect(serviceIssue({ name: '', host: '10.10.0.3', port: '6379' })).toBeUndefined()
    expect(serviceIssue({ name: '', host: '', port: '' })).toBeUndefined()
    expect(serviceIssue({ name: '', host: '', port: '1' })).toBe('Falta o host.')
    expect(serviceIssue({ name: '', host: 'a', port: '70000' })).toContain('1 a 65535')
    expect(serviceIssue({ name: '', host: 'a', port: '443' })).toContain('HTTP')
    expect(serviceIssue({ name: '', host: 'localhost', port: '5432' })).toContain('porta local')
    expect(serviceIssue({ name: '', host: 'a b', port: '1' })).toContain('sem espaço')
  })

  it('troca só os serviços e mantém as outras regras; repetido entra uma vez; a linha vazia some', () => {
    const rules = [net('github.com'), net('10.10.0.3:6379', 'allow', 'Redis velho'), { category: 'terminal' as const, pattern: 'npm *', decision: 'allow' as const }]
    expect(
      withServices(rules, [
        { name: 'Redis', host: '10.10.0.3', port: '6379' },
        { name: 'Redis de novo', host: '10.10.0.3', port: '6379' },
        { name: '', host: '', port: '' },
        { name: 'Kafka', host: '10.10.0.3', port: '9092' },
      ]),
    ).toEqual([rules[0], rules[2], net('10.10.0.3:6379', 'allow', 'Redis'), net('10.10.0.3:9092', 'allow', 'Kafka')])
  })
})
