import assert from 'node:assert'
import { describe, it } from 'node:test'
import { parseEnvFile } from './Env.File'
import { cercoPlan } from './Cerco.Plan'
import { decide } from './Permission.Policy'

describe('Env.File — os valores de um .env', () => {
  it('lê NOME=valor, com export, aspas e comentário no fim; ignora vazias, comentários e valor vazio', () => {
    assert.deepStrictEqual(parseEnvFile('# topo\nexport API_KEY="abc 123"\nDB_URL=postgres://x # o banco\nVAZIO=\nlixo\nTOKEN=\'t-1\'\n'), [
      { name: 'API_KEY', value: 'abc 123' },
      { name: 'DB_URL', value: 'postgres://x' },
      { name: 'TOKEN', value: 't-1' },
    ])
  })
})

describe('Permission.Policy — a leitura dos .env liberada pelo projeto', () => {
  const read = (value: string, envFiles?: boolean) =>
    decide({ category: 'read', value }, { project: [{ category: 'read', pattern: '**', decision: 'allow' }], ...(envFiles ? { envFiles } : {}) })
  const write = (value: string, envFiles?: boolean) =>
    decide({ category: 'write', value }, { project: [{ category: 'write', pattern: '**', decision: 'allow' }], ...(envFiles ? { envFiles } : {}) })

  it('⛔ sem a liberação, nem uma regra `**` abre o .env; com ela, a leitura abre', () => {
    assert.strictEqual(read('apps/logiccus/@core/.env').allowed, false)
    assert.strictEqual(read('apps/api/.env.development').allowed, false)
    assert.strictEqual(read('apps/logiccus/@core/.env', true).allowed, true)
    assert.strictEqual(read('apps/api/.env.development', true).allowed, true)
  })

  it('⛔ continua fechado com a liberação: gravar .env, as credenciais do gateway, chaves e secrets.*', () => {
    assert.strictEqual(write('apps/api/.env', true).allowed, false)
    assert.strictEqual(read('repositories/logiccus/.credentials/automation/agents-gateway.env', true).allowed, false)
    assert.strictEqual(read('certs/server.pem', true).allowed, false)
    assert.strictEqual(read('config/secrets.json', true).allowed, false)
  })

  it('o cerco do terminal só deixa de negar o .env quando o projeto libera', () => {
    const base = { root: '/p', scratch: [], alwaysRead: [], alwaysDeny: [] }
    const closed = cercoPlan({ project: [{ category: 'read', pattern: '**', decision: 'allow' }] }, base)
    const open = cercoPlan({ project: [{ category: 'read', pattern: '**', decision: 'allow' }], envFiles: true }, base)
    assert.ok(closed.readDeny.some((path) => path.includes('.env')))
    assert.ok(!open.readDeny.some((path) => /\/\.env($|\.)/.test(path)), 'o **/.env e o **/.env.* saem; o secrets.env fica')
    assert.ok(
      open.writeDeny.some((path) => path.includes('.env')),
      'gravar segue negado',
    )
  })
})
