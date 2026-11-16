import assert from 'node:assert'
import { describe, it } from 'node:test'
import { envSecrets, parseEnvFile } from './Env.File'
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

describe('Env.File — só o segredo do .env vai para a máscara', () => {
  const env = [
    'MINIO_BUCKET=logiccus',
    'KAFKA_CLIENT_ID=logiccus-api',
    'MONGO_PROVIDER_DATABASE=logiccus',
    'AGENTS_GATEWAY_BASE_URL=http://localhost:3210',
    'AUTH_URL=http://localhost:4000/auth',
    'PORT=4000',
    'JWT_SECRET=um-segredo-qualquer-123',
    'GITHUB_TOKEN=abc12345678',
    'MINIO_SECRET_KEY=minio-secret-999',
    'ENCRYPTION_KEY=0011223344556677',
    'DB_PASSWORD=senha-do-banco',
    'MONGO_URI=mongodb://app:S3nha%40forte@db:27017/logiccus',
    'PAY_SK=Zx98Yw76Vu54Ts32Rq10Po98Nm',
    'REQUEST_ID_HEADER=x-request-id',
  ].join('\n')

  it('⚖️ bucket, client id, banco, URL e porta NÃO entram (mascarar tudo deixava o board ilegível); token, senha, chave, sim', () => {
    const labels = envSecrets(env).map((item) => item.label.replace(' (.env)', ''))
    for (const name of ['MINIO_BUCKET', 'KAFKA_CLIENT_ID', 'MONGO_PROVIDER_DATABASE', 'AGENTS_GATEWAY_BASE_URL', 'AUTH_URL', 'PORT', 'REQUEST_ID_HEADER'])
      assert.ok(!labels.includes(name), name)
    for (const name of ['JWT_SECRET', 'GITHUB_TOKEN', 'MINIO_SECRET_KEY', 'ENCRYPTION_KEY', 'DB_PASSWORD', 'PAY_SK']) assert.ok(labels.includes(name), name)
  })

  it('a URL com senha entra só pela senha (decodificada): o resto da URL segue legível', () => {
    assert.deepStrictEqual(envSecrets('MONGO_URI=mongodb://app:S3nha%40forte@db:27017/logiccus'), [{ value: 'S3nha@forte', label: 'MONGO_URI (.env)' }])
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
