import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SqliteProjectAccountRepository } from '@infra/persistence/Sqlite.ProjectAccountRepository'
import { AccountValidationError, IAccountTokens, ProjectAccountsService } from './ProjectAccounts.Service'

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'

function service(tokens: Partial<IAccountTokens> = {}) {
  const minted: string[] = []
  const all: IAccountTokens = {
    githubApp: async (key) => (minted.push(key), { token: 'ghs_de_1h', expiresAt: new Date(Date.now() + 3_600_000) }),
    describeGitHub: async () => 'ok',
    ...tokens,
  }
  return { accounts: new ProjectAccountsService(new SqliteProjectAccountRepository(new SecretBox(randomBytes(32))), all), minted }
}

describe('ProjectAccountsService', () => {
  it('⛔ o comando recebe só as contas que as permissões liberam, e do App só o token de 1h', async () => {
    const { accounts } = service()
    accounts.save('p1', 'gh-app', { kind: 'github-app', label: 'App', public: { appId: '1', installationId: '2', owner: 'empresa1' }, secret: PEM }, 'admin')
    accounts.save('p1', 'gitlab', { kind: 'secret-env', label: 'GitLab', public: { envName: 'GITLAB_TOKEN' }, secret: 'glpat-x' }, 'admin')

    const { env, problems } = await accounts.commandEnv('p1', (id) => id === 'gh-app')
    assert.deepStrictEqual(problems, [])
    assert.strictEqual(env.GH_TOKEN, 'ghs_de_1h')
    assert.strictEqual(env.GITLAB_TOKEN, undefined)
    assert.ok(!JSON.stringify(env).includes('PRIVATE KEY'))
    // O credential helper do git vale só para os repositórios do dono da conta.
    const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [`${i}:${env[`GIT_CONFIG_KEY_${i}`]}`, env[`GIT_CONFIG_VALUE_${i}`]]))
    assert.strictEqual(config['0:credential.https://github.com.useHttpPath'], 'true')
    assert.strictEqual(config['1:credential.https://github.com/empresa1.helper'], '')
    assert.match(config['2:credential.https://github.com/empresa1.helper'], /password=\$GATEWAY_GH_0/)
  })

  it('duas contas GitHub: cada dono com a sua, e sem GH_TOKEN (o `gh` não saberia qual)', async () => {
    const { accounts } = service()
    accounts.save('p1', 'gh-1', { kind: 'github-token', label: '1', public: { owner: 'empresa1' }, secret: 'ghp_1' }, 'admin')
    accounts.save('p1', 'gh-2', { kind: 'github-token', label: '2', public: { owner: 'empresa2' }, secret: 'ghp_2' }, 'admin')
    const { env } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual([env.GATEWAY_GH_0, env.GATEWAY_GH_1, env.GH_TOKEN], ['ghp_1', 'ghp_2', undefined])
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`])
    assert.ok(keys.includes('credential.https://github.com/empresa1.helper') && keys.includes('credential.https://github.com/empresa2.helper'))
  })

  it('o App que não gera token não derruba o comando: vira aviso', async () => {
    const { accounts } = service({ githubApp: async () => Promise.reject(new Error('Bad credentials')) })
    accounts.save('p1', 'gh-app', { kind: 'github-app', label: 'App', public: { appId: '1', installationId: '2' }, secret: PEM }, 'admin')
    const { env, problems } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual(problems, ['conta gh-app: Bad credentials'])
    assert.strictEqual(env.GH_TOKEN, undefined)
  })

  it('⛔ cadastro: variável que o gateway monta é recusada; App sem a chave .pem também', () => {
    const { accounts } = service()
    for (const envName of ['HOME', 'HTTPS_PROXY', 'GIT_SSH_COMMAND', 'LD_PRELOAD', 'GH_TOKEN', 'GIT_CONFIG_COUNT'])
      assert.throws(() => accounts.save('p1', 'x', { kind: 'secret-env', label: '', public: { envName }, secret: 'v' }, 'admin'), AccountValidationError)
    assert.throws(() => accounts.save('p1', 'y', { kind: 'github-app', label: '', public: { appId: '1', installationId: '2' }, secret: 'não é pem' }, 'admin'), /chave privada/)
    assert.throws(() => accounts.save('p1', 'z', { kind: 'github-token', label: '', public: {} }, 'admin'), /secret: obrigatório/)
  })
})
