import { accountIssues, IGcpServiceAccountKey, IProjectAccount, parseGcpKey, SSH_VALIDITY } from '@domain/models/ProjectAccount.Model'
import { IProjectAccountRepository, IProjectAccountSave } from '@domain/ports/ProjectAccountRepository.Port'

/** Quem gera e confere os tokens do GitHub (fora do cerco, no gateway). */
export interface IAccountTokens {
  githubApp(cacheKey: string, grant: { appId: string; installationId: string; privateKey: string; repositories?: readonly string[] }): Promise<{ token: string; expiresAt: Date }>
  describeGitHub(token: string, installation: boolean): Promise<string>
  gcp(cacheKey: string, key: IGcpServiceAccountKey): Promise<{ token: string; expiresAt: Date }>
  describeGcp(token: string): Promise<string>
}

/** O `ssh-keygen` do gateway (fora do cerco): a CA, o certificado de cada comando e a assinatura. */
export interface IAccountSshKeys {
  generateCa(comment: string): Promise<{ privateKey: string; publicKey: string }>
  publicOf(privateKey: string): Promise<string>
  issue(caPrivateKey: string, principals: readonly string[], minutes: number, keyId: string): Promise<{ privateKey: string; certificate: string }>
  describeCertificate(certificate: string): Promise<string>
  sign(privateKey: string, namespace: string, data: string): Promise<string>
}

/** Uma identidade SSH de um comando: a chave (efêmera, na CA) e o certificado, onde ela vale e os hosts aceitos. */
export interface IAccountSshIdentity {
  id: string
  privateKey: string
  certificate?: string
  hostPatterns: string[]
  knownHosts: string
}

export class AccountValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Conta inválida: ${issues.join('; ')}`)
    this.name = 'AccountValidationError'
  }
}

/** O que um comando recebe das contas: as variáveis e o que deu errado (a conta que não gerou token). */
export interface IAccountCommandEnv {
  env: Record<string, string>
  problems: string[]
  /** As identidades SSH, que o terminal grava numa pasta do comando (ver `Ssh.Kit`). */
  ssh: IAccountSshIdentity[]
}

/**
 * As contas de cada projeto: cadastro (só admin, pela rota) e a entrega a cada comando do terminal.
 *
 * ⛔ A entrega só leva as contas que as permissões deixam ESTE agente usar (`account <id>`), e o GitHub App entra como
 * token de 1h — a chave privada fica aqui.
 */
export class ProjectAccountsService {
  constructor(
    private readonly repository: IProjectAccountRepository,
    private readonly tokens: IAccountTokens,
    private readonly ssh?: IAccountSshKeys,
  ) {}

  list(projectId: string): IProjectAccount[] {
    return this.repository.list(projectId)
  }

  get(projectId: string, id: string): IProjectAccount | undefined {
    return this.repository.get(projectId, id)
  }

  async save(projectId: string, id: string, input: IProjectAccountSave, by: string): Promise<IProjectAccount> {
    const current = this.repository.get(projectId, id)
    const creating = !current || current.kind !== input.kind
    const issues = accountIssues(input.kind, input.public, input.secret, creating)
    if (issues.length) throw new AccountValidationError(issues)
    let visible = input.public
    let secret = input.secret
    // GCP: o e-mail da conta e o projeto padrão saem do próprio JSON (o projeto escolhido na tela vence).
    const key = input.kind === 'gcp-service-account' && secret ? parseGcpKey(secret) : undefined
    if (key) visible = { ...visible, clientEmail: key.client_email, gcpProject: visible.gcpProject ?? key.project_id }
    if (input.kind === 'ssh-ca') {
      // ⛔ A CA nasce aqui e a privada nunca sai: o que se cola na tela é ignorado. Editar mantém a mesma CA.
      if (creating) {
        const ca = await this.requireSsh().generateCa(`gateway-ca:${projectId}:${id}`)
        secret = ca.privateKey
        visible = { ...visible, publicKey: ca.publicKey }
      } else {
        secret = undefined
        visible = { ...visible, publicKey: current.public.publicKey }
      }
    }
    if (input.kind === 'ssh-key') {
      if (secret) visible = { ...visible, publicKey: await this.requireSsh().publicOf(secret) }
      else if (current) visible = { ...visible, publicKey: current.public.publicKey }
    }
    return this.repository.save(projectId, id, { kind: input.kind, label: input.label.trim() || id, public: visible, ...(secret ? { secret } : {}) }, by)
  }

  remove(projectId: string, id: string): boolean {
    return this.repository.remove(projectId, id)
  }

  removeProject(projectId: string): void {
    this.repository.deleteProject(projectId)
  }

  /** Gera o token (ou confere o segredo) e diz o que ele alcança — sem devolver o segredo. */
  async test(projectId: string, id: string): Promise<string> {
    const account = this.repository.get(projectId, id)
    const secret = account && this.repository.secret(projectId, id)
    if (!account || !secret) throw new Error(account ? 'o segredo não abre com a chave-mestra de agora: cadastre de novo' : `Conta não encontrada: ${id}`)
    if (account.kind === 'secret-env') return `a variável ${account.public.envName} vai para os comandos`
    if (account.kind === 'github-token') return this.tokens.describeGitHub(secret, false)
    if (account.kind === 'gcp-service-account') return this.tokens.describeGcp((await this.gcpToken(account, secret)).token)
    if (account.kind === 'ssh-ca') return this.requireSsh().describeCertificate((await this.sshCertificate(account, secret, 'teste')).certificate)
    if (account.kind === 'ssh-key')
      return account.public.certificate
        ? this.requireSsh().describeCertificate(account.public.certificate)
        : `chave ${account.public.publicKey?.split(' ')[0] ?? '?'}, sem certificado`
    const { token, expiresAt } = await this.githubToken(account, secret)
    return `${await this.tokens.describeGitHub(token, true)} — token até ${expiresAt.toISOString().slice(11, 16)} UTC`
  }

  /**
   * As variáveis de UM comando: as contas do projeto que `allowed` libera.
   *
   * GitHub: cada conta ganha um credential helper do git só para a URL dela (`https://github.com/<owner>`, ou o
   * github.com inteiro) — com várias contas, cada repositório usa a do dono. O `GH_TOKEN` (do `gh`) só quando há uma.
   */
  async commandEnv(projectId: string, allowed: (id: string) => boolean): Promise<IAccountCommandEnv> {
    const env: Record<string, string> = {}
    const problems: string[] = []
    const config: Array<[string, string]> = []
    const github: string[] = []
    let gcp: string | undefined
    const ssh: IAccountSshIdentity[] = []
    for (const account of this.repository.list(projectId).filter((item) => allowed(item.id))) {
      const secret = this.repository.secret(projectId, account.id)
      if (!secret) {
        problems.push(`conta ${account.id}: o segredo não abre; cadastre de novo`)
        continue
      }
      if (account.kind === 'secret-env' && account.public.envName) {
        env[account.public.envName] = secret
        continue
      }
      if (account.kind === 'ssh-ca' || account.kind === 'ssh-key') {
        try {
          const identity = account.kind === 'ssh-ca' ? await this.sshCertificate(account, secret, 'comando') : { privateKey: secret, certificate: account.public.certificate }
          ssh.push({ id: account.id, ...identity, hostPatterns: account.public.hostPatterns ?? [], knownHosts: account.public.knownHosts ?? '' })
        } catch (error: unknown) {
          problems.push(`conta ${account.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }
      if (account.kind === 'gcp-service-account') {
        // O `gcloud` usa o token direto; as bibliotecas do Google, não (pedem o arquivo da conta, que não entra no cerco).
        if (gcp) {
          problems.push(`conta ${account.id}: só uma conta do GCP por comando (vale ${gcp})`)
          continue
        }
        try {
          env.CLOUDSDK_AUTH_ACCESS_TOKEN = (await this.gcpToken(account, secret)).token
          gcp = account.id
          if (account.public.gcpProject) env.CLOUDSDK_CORE_PROJECT = env.GOOGLE_CLOUD_PROJECT = account.public.gcpProject
        } catch (error: unknown) {
          problems.push(`conta ${account.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        continue
      }
      let token = secret
      if (account.kind === 'github-app') {
        try {
          token = (await this.githubToken(account, secret)).token
        } catch (error: unknown) {
          problems.push(`conta ${account.id}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      const slot = `GATEWAY_GH_${github.length}`
      env[slot] = token
      github.push(token)
      const url = account.public.owner ? `https://github.com/${account.public.owner}` : 'https://github.com'
      // O valor vazio zera os helpers de antes para esta URL (o do `.gitconfig`): vale o da conta.
      config.push([`credential.${url}.helper`, ''], [`credential.${url}.helper`, `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${slot}"; }; f`])
    }
    if (config.some(([key]) => key.startsWith('credential.https://github.com/'))) config.unshift(['credential.https://github.com.useHttpPath', 'true'])
    if (github.length === 1) env.GH_TOKEN = github[0]
    if (config.length) {
      env.GIT_CONFIG_COUNT = String(config.length)
      config.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key
        env[`GIT_CONFIG_VALUE_${index}`] = value
      })
    }
    return { env, problems, ssh }
  }

  /**
   * ⛔ ASSINAR COM A CHAVE SSH IMPORTADA sem ela entrar no cerco (`ssh-keygen -Y sign`): para gerar um token a partir
   * da chave. Quem pede confere a permissão `account <id>` antes.
   */
  async sign(projectId: string, id: string, namespace: string, data: string): Promise<string> {
    const account = this.repository.get(projectId, id)
    if (account?.kind !== 'ssh-key') throw new Error(`Não há chave SSH importada com o id ${id} neste projeto`)
    const secret = this.repository.secret(projectId, id)
    if (!secret) throw new Error('o segredo não abre com a chave-mestra de agora: cadastre de novo')
    return this.requireSsh().sign(secret, namespace, data)
  }

  private sshCertificate(account: IProjectAccount, caPrivateKey: string, purpose: string) {
    const minutes = Math.min(account.public.validityMinutes ?? SSH_VALIDITY.default, SSH_VALIDITY.max)
    return this.requireSsh().issue(caPrivateKey, account.public.principals ?? [], minutes, `gateway:${account.projectId}:${account.id}:${purpose}`)
  }

  private requireSsh(): IAccountSshKeys {
    if (!this.ssh) throw new Error('o SSH não está disponível neste servidor')
    return this.ssh
  }

  private async gcpToken(account: IProjectAccount, secret: string) {
    const key = parseGcpKey(secret)
    if (!key) throw new Error('o JSON da conta de serviço não é válido: cadastre de novo')
    return this.tokens.gcp(`${account.projectId}:${account.id}:${account.updatedAt.toISOString()}`, key)
  }

  private githubToken(account: IProjectAccount, privateKey: string) {
    return this.tokens.githubApp(`${account.projectId}:${account.id}:${account.updatedAt.toISOString()}`, {
      appId: account.public.appId ?? '',
      installationId: account.public.installationId ?? '',
      privateKey,
      repositories: account.public.repositories,
    })
  }
}
