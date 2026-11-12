import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SqliteProjectAccountRepository } from '@infra/persistence/Sqlite.ProjectAccountRepository'
import { AccountValidationError, IAccountSshKeys, IAccountTokens, ProjectAccountsService } from './ProjectAccounts.Service'

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
  const issued: Array<{ principals: readonly string[]; minutes: number }> = []
  const ssh: IAccountSshKeys = {
    generateCa: async () => ({ privateKey: 'CA-PRIVADA', publicKey: 'ssh-ed25519 AAAACA gateway-ca' }),
    publicOf: async () => 'ssh-ed25519 AAAAIMPORTADA',
    issue: async (_ca, principals, minutes) => (issued.push({ principals, minutes }), { privateKey: 'EFEMERA', certificate: 'ssh-ed25519-cert-v01@openssh.com AAAACERT' }),
    describeCertificate: async () => 'ok',
    sign: async (key, namespace, data) => `assinado(${key.includes('CHAVE-IMPORTADA')},${namespace},${data})`,
  }
  return { accounts: new ProjectAccountsService(new SqliteProjectAccountRepository(new SecretBox(randomBytes(32))), all, ssh), minted, issued }
}

describe('ProjectAccountsService', () => {
  it('⛔ o comando recebe só as contas que as permissões liberam, e do App só o token de 1h', async () => {
    const { accounts } = service()
    await accounts.save('p1', 'gh-app', { kind: 'github-app', label: 'App', public: { appId: '1', installationId: '2', owner: 'empresa1' }, secret: PEM }, 'admin')
    await accounts.save('p1', 'gitlab', { kind: 'secret-env', label: 'GitLab', public: { envName: 'GITLAB_TOKEN' }, secret: 'glpat-x' }, 'admin')

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

  it('⛔ o clone do gateway recebe só o helper e o token da conta escolhida (sem GH_TOKEN); conta que não é do git, nada', async () => {
    const { accounts } = service()
    await accounts.save('p1', 'gh-1', { kind: 'github-token', label: '1', public: { owner: 'empresa1' }, secret: 'ghp_1' }, 'admin')
    await accounts.save('p1', 'gh-2', { kind: 'github-token', label: '2', public: { owner: 'empresa2' }, secret: 'ghp_2' }, 'admin')
    await accounts.save(
      'p1',
      'interno',
      { kind: 'git-https', label: 'Interno', public: { baseUrl: 'https://Git.Empresa.Test:8443/grupo', username: 'robo' }, secret: 'tok-int' },
      'admin',
    )
    await accounts.save('p1', 'gitlab', { kind: 'secret-env', label: 'GitLab', public: { envName: 'GITLAB_TOKEN' }, secret: 'glpat-x' }, 'admin')

    const github = await accounts.gitEnv('p1', 'gh-2')
    assert.deepStrictEqual(Object.keys(github!.env).sort(), [
      'GATEWAY_GH_0',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_VALUE_2',
    ])
    assert.strictEqual(github!.env.GATEWAY_GH_0, 'ghp_2')
    assert.strictEqual(github!.env.GIT_CONFIG_KEY_2, 'credential.https://github.com/empresa2.helper')
    assert.strictEqual(github!.host, undefined)
    assert.ok(!JSON.stringify(github).includes('ghp_1'))

    const own = await accounts.gitEnv('p1', 'interno')
    assert.strictEqual(own!.host, 'git.empresa.test:8443')
    assert.strictEqual(own!.env.GATEWAY_GIT_0, 'tok-int')
    assert.strictEqual(own!.env.GIT_CONFIG_KEY_1, 'credential.https://git.empresa.test:8443/grupo.helper')

    assert.strictEqual(await accounts.gitEnv('p1', 'gitlab'), undefined)
    assert.strictEqual(await accounts.gitEnv('p1', 'nao-existe'), undefined)
    assert.strictEqual(await accounts.gitEnv('p2', 'gh-1'), undefined, 'a conta é do projeto dela')
  })

  it('duas contas GitHub: cada dono com a sua, e sem GH_TOKEN (o `gh` não saberia qual)', async () => {
    const { accounts } = service()
    await accounts.save('p1', 'gh-1', { kind: 'github-token', label: '1', public: { owner: 'empresa1' }, secret: 'ghp_1' }, 'admin')
    await accounts.save('p1', 'gh-2', { kind: 'github-token', label: '2', public: { owner: 'empresa2' }, secret: 'ghp_2' }, 'admin')
    const { env } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual([env.GATEWAY_GH_0, env.GATEWAY_GH_1, env.GH_TOKEN], ['ghp_1', 'ghp_2', undefined])
    const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`])
    assert.ok(keys.includes('credential.https://github.com/empresa1.helper') && keys.includes('credential.https://github.com/empresa2.helper'))
  })

  it('o App que não gera token não derruba o comando: vira aviso', async () => {
    const { accounts } = service({ githubApp: async () => Promise.reject(new Error('Bad credentials')) })
    await accounts.save('p1', 'gh-app', { kind: 'github-app', label: 'App', public: { appId: '1', installationId: '2' }, secret: PEM }, 'admin')
    const { env, problems } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual(problems, ['conta gh-app: Bad credentials'])
    assert.strictEqual(env.GH_TOKEN, undefined)
  })

  it('⛔ cadastro: variável que o gateway monta é recusada; App sem a chave .pem também', async () => {
    const { accounts } = service()
    for (const envName of ['HOME', 'HTTPS_PROXY', 'GIT_SSH_COMMAND', 'LD_PRELOAD', 'GH_TOKEN', 'GIT_CONFIG_COUNT'])
      await assert.rejects(accounts.save('p1', 'x', { kind: 'secret-env', label: '', public: { envName }, secret: 'v' }, 'admin'), AccountValidationError)
    await assert.rejects(accounts.save('p1', 'y', { kind: 'github-app', label: '', public: { appId: '1', installationId: '2' }, secret: 'não é pem' }, 'admin'), /chave privada/)
    await assert.rejects(accounts.save('p1', 'z', { kind: 'github-token', label: '', public: {} }, 'admin'), /secret: obrigatório/)
  })

  it('⛔ GCP: o comando recebe só o token de 1h e o projeto; o e-mail sai do JSON; uma conta do GCP por comando', async () => {
    const { accounts } = service()
    const json = (email: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: 'PEM-DA-CONTA', project_id: 'proj-empresa-1' })
    const saved = await accounts.save('p1', 'gcp-1', { kind: 'gcp-service-account', label: 'GCP', public: {}, secret: json('sa@proj-empresa-1.iam.gserviceaccount.com') }, 'admin')
    assert.deepStrictEqual([saved.public.clientEmail, saved.public.gcpProject, saved.public.last4], ['sa@proj-empresa-1.iam.gserviceaccount.com', 'proj-empresa-1', undefined])
    await accounts.save(
      'p1',
      'gcp-2',
      { kind: 'gcp-service-account', label: 'GCP 2', public: { gcpProject: 'outro-projeto' }, secret: json('sa2@x.iam.gserviceaccount.com') },
      'admin',
    )

    const { env, problems } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual([env.CLOUDSDK_AUTH_ACCESS_TOKEN, env.CLOUDSDK_CORE_PROJECT, env.GOOGLE_CLOUD_PROJECT], ['ya29.de_1h', 'proj-empresa-1', 'proj-empresa-1'])
    assert.ok(!JSON.stringify(env).includes('PEM-DA-CONTA'))
    assert.deepStrictEqual(problems, ['conta gcp-2: só uma conta do GCP por comando (vale gcp-1)'])
    await assert.rejects(accounts.save('p1', 'gcp-3', { kind: 'gcp-service-account', label: '', public: {}, secret: '{"type":"authorized_user"}' }, 'admin'), /conta de serviço/)
  })

  it('⛔ CA SSH: nasce no gateway (o que se cola é ignorado), editar mantém a mesma, e cada comando recebe uma chave efêmera com certificado', async () => {
    const { accounts, issued } = service()
    const known = 'srv.empresa1.com ssh-ed25519 AAAAhost'
    const ca = await accounts.save(
      'p1',
      'servidores',
      { kind: 'ssh-ca', label: 'Servidores', public: { principals: ['deploy'], knownHosts: known, validityMinutes: 5 }, secret: 'colado' },
      'admin',
    )
    assert.strictEqual(ca.public.publicKey, 'ssh-ed25519 AAAACA gateway-ca')
    const edited = await accounts.save('p1', 'servidores', { kind: 'ssh-ca', label: 'Servidores', public: { principals: ['deploy', 'app'], knownHosts: known } }, 'admin')
    assert.strictEqual(edited.public.publicKey, 'ssh-ed25519 AAAACA gateway-ca')

    const { ssh, env } = await accounts.commandEnv('p1', () => true)
    assert.deepStrictEqual(ssh, [{ id: 'servidores', privateKey: 'EFEMERA', certificate: 'ssh-ed25519-cert-v01@openssh.com AAAACERT', hostPatterns: [], knownHosts: known }])
    assert.deepStrictEqual(issued.at(-1), { principals: ['deploy', 'app'], minutes: 10 })
    assert.ok(!JSON.stringify({ ssh, env }).includes('CA-PRIVADA'))
    await assert.rejects(accounts.save('p1', 'sem-hosts', { kind: 'ssh-ca', label: '', public: { principals: ['deploy'] } }, 'admin'), /knownHosts/)
  })

  it('chave SSH importada: vai ao comando (o agente vê) e assina sem sair do gateway; só a do tipo chave assina', async () => {
    const { accounts } = service()
    const known = 'git.empresa1.com ssh-ed25519 AAAAhost'
    const key = await accounts.save(
      'p1',
      'chave',
      { kind: 'ssh-key', label: 'Chave', public: { knownHosts: known, hostPatterns: ['git.empresa1.com'] }, secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nCHAVE-IMPORTADA' },
      'admin',
    )
    assert.strictEqual(key.public.publicKey, 'ssh-ed25519 AAAAIMPORTADA')
    assert.match(await accounts.sign('p1', 'chave', 'token', 'dados'), /^assinado\(true,token,dados\)$/)
    await assert.rejects(accounts.sign('p1', 'nao-existe', 'token', 'x'), /Não há chave SSH/)
  })

  it('⛔ Git HTTPS (servidor próprio): o helper vale só sob a URL da conta, com o usuário dela; o token numa variável, nunca na config', async () => {
    const { accounts } = service()
    const saved = await accounts.save(
      'p1',
      'infoccus',
      { kind: 'git-https', label: 'Infoccus', public: { baseUrl: 'HTTPS://Git.Infoccus.com.br/infoccus/', username: 'agente' }, secret: 'tok-wxyz' },
      'admin',
    )
    assert.deepStrictEqual(saved.public, { baseUrl: 'https://git.infoccus.com.br/infoccus', username: 'agente', last4: 'wxyz' })
    assert.strictEqual(await accounts.test('p1', 'infoccus'), 'usuário agente em https://git.infoccus.com.br/infoccus/ — o token só se confere no git do agente')

    assert.strictEqual((await accounts.commandEnv('p1', () => false)).env.GATEWAY_GIT_0, undefined)
    const { env, problems } = await accounts.commandEnv('p1', (id) => id === 'infoccus')
    assert.deepStrictEqual(problems, [])
    assert.strictEqual(env.GATEWAY_GIT_0, 'tok-wxyz')
    assert.strictEqual(env.GH_TOKEN, undefined)
    const config = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]])
    assert.deepStrictEqual(config, [
      ['credential.https://git.infoccus.com.br/infoccus.helper', ''],
      ['credential.https://git.infoccus.com.br/infoccus.helper', `!f() { test "$1" = get && echo 'username=agente' && echo "password=$GATEWAY_GIT_0"; }; f`],
    ])
    assert.ok(!config.flat().join('\n').includes('tok-wxyz'))
  })

  it('⛔ Git HTTPS: só https, sem credencial na URL, nunca loopback/link-local; usuário sem aspas; token numa linha', async () => {
    const { accounts } = service()
    const save = (baseUrl: string, username = 'agente', secret = 'tok') =>
      accounts.save('p1', 'g', { kind: 'git-https', label: '', public: { baseUrl, username }, secret }, 'admin')
    await assert.rejects(save('http://git.empresa.com.br'), /só https/)
    await assert.rejects(save('https://agente:tok@git.empresa.com.br/grupo'), /sem usuário ou senha na URL/)
    await assert.rejects(save('https://git.empresa.com.br/grupo?x=1'), /sem \? nem #/)
    for (const host of ['localhost', 'git.localhost', '127.0.0.1', '169.254.169.254', '[::1]', '[fe80::1]', 'metadata.google.internal'])
      await assert.rejects(save(`https://${host}/grupo`), /sempre negado/, host)
    await assert.rejects(save('não é url'), /baseUrl: uma URL https/)
    await assert.rejects(save('https://git.empresa.com.br', "agente' ; rm -rf ~ #"), /username/)
    await assert.rejects(save('https://git.empresa.com.br', 'agente', 'tok\nhost=outro'), /numa linha só/)
    await assert.rejects(accounts.save('p1', 'g', { kind: 'git-https', label: '', public: { baseUrl: 'https://git.empresa.com.br' } }, 'admin'), /username/)
    // Rede local passa (o portão de rede exige a regra exata); a porta fica na URL.
    assert.strictEqual((await save('https://10.0.0.5:8443/grupo')).public.baseUrl, 'https://10.0.0.5:8443/grupo')
  })

  it('⛔ aviso de fim de turno: um segredo por endereço, e ele nunca vai para o comando, nem com a conta liberada', async () => {
    const { accounts } = service()
    const secret = 'a'.repeat(64)
    await accounts.save('p1', 'esteira', { kind: 'turn-callback', label: 'Esteira', public: { callbackHost: '10.10.0.4:4003' }, secret }, 'admin')
    await accounts.save('p1', 'site', { kind: 'turn-callback', label: 'Site', public: { callbackHost: 'Hooks.Empresa.com' }, secret: 'b'.repeat(40) }, 'admin')

    assert.strictEqual(accounts.callbackSecret('p1', '10.10.0.4:4003'), secret)
    assert.strictEqual(accounts.get('p1', 'esteira')?.public.last4, 'aaaa', 'o fim do segredo aparece na lista')
    assert.strictEqual(accounts.callbackSecret('p1', 'hooks.empresa.com:443'), 'b'.repeat(40), 'sem porta na conta = a porta padrão')
    assert.strictEqual(accounts.callbackSecret('p1', '10.10.0.4:4004'), undefined, 'outra porta, outro endereço')
    assert.strictEqual(accounts.callbackSecret('p2', '10.10.0.4:4003'), undefined, 'outro projeto não vê')

    const { env } = await accounts.commandEnv('p1', () => true)
    assert.ok(!JSON.stringify(env).includes(secret), 'o segredo do aviso não entra no terminal')

    await assert.rejects(
      accounts.save('p1', 'curto', { kind: 'turn-callback', label: 'x', public: { callbackHost: '10.10.0.4:4003' }, secret: 'curto' }, 'admin'),
      AccountValidationError,
    )
    await assert.rejects(accounts.save('p1', 'url', { kind: 'turn-callback', label: 'x', public: { callbackHost: 'http://x/fim' }, secret }, 'admin'), AccountValidationError)
    // ⛔ SSRF: loopback, link-local e metadado não recebem aviso (o Docker em 127.0.0.1:2375, o 169.254.169.254)
    for (const callbackHost of ['169.254.169.254:80', '127.0.0.1:2375', 'localhost:3100', '2130706433', '0x7f.1', '0.0.0.0:80', 'api.localhost'])
      await assert.rejects(accounts.save('p1', 'ssrf', { kind: 'turn-callback', label: 'x', public: { callbackHost }, secret }, 'admin'), AccountValidationError, callbackHost)
  })
})
