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
    gcp: async (key) => (minted.push(key), { token: 'ya29.de_1h', expiresAt: new Date(Date.now() + 3_600_000) }),
    describeGcp: async () => 'ok',
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

  it('⛔ GCP: o comando recebe só o token de 1h e o projeto; o e-mail sai do JSON; uma conta do GCP por comando', async () => {
    const { accounts } = service()
    const json = (email: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: 'PEM-DA-CONTA', project_id: 'proj-empresa-1' })
    const saved = accounts.save('p1', 'gcp-1', { kind: 'gcp-service-account', label: 'GCP', public: {}, secret: json('sa@proj-empresa-1.iam.gserviceaccount.com') }, 'admin')
    assert.deepStrictEqual([saved.public.clientEmail, saved.public.gcpProject, saved.public.last4], ['sa@proj-empresa-1.iam.gserviceaccount.com', 'proj-empresa-1', undefined])
    accounts.save('p1', 'gcp-2', { kind: 'gcp-service-account', label: 'GCP 2', public: { gcpProject: 'outro-projeto' }, secret: json('sa2@x.iam.gserviceaccount.com') }, 'admin')

    const { env, problems } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual([env.CLOUDSDK_AUTH_ACCESS_TOKEN, env.CLOUDSDK_CORE_PROJECT, env.GOOGLE_CLOUD_PROJECT], ['ya29.de_1h', 'proj-empresa-1', 'proj-empresa-1'])
    assert.ok(!JSON.stringify(env).includes('PEM-DA-CONTA'))
    assert.deepStrictEqual(problems, ['conta gcp-2: só uma conta do GCP por comando (vale gcp-1)'])
    assert.throws(() => accounts.save('p1', 'gcp-3', { kind: 'gcp-service-account', label: '', public: {}, secret: '{"type":"authorized_user"}' }, 'admin'), /conta de serviço/)
  })
})
