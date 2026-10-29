import { accountIssues, IProjectAccount } from '@domain/models/ProjectAccount.Model'
import { IProjectAccountRepository, IProjectAccountSave } from '@domain/ports/ProjectAccountRepository.Port'

/** Quem gera e confere os tokens do GitHub (fora do cerco, no gateway). */
export interface IAccountTokens {
  githubApp(cacheKey: string, grant: { appId: string; installationId: string; privateKey: string; repositories?: readonly string[] }): Promise<{ token: string; expiresAt: Date }>
  describeGitHub(token: string, installation: boolean): Promise<string>
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
  ) {}

  list(projectId: string): IProjectAccount[] {
    return this.repository.list(projectId)
  }

  get(projectId: string, id: string): IProjectAccount | undefined {
    return this.repository.get(projectId, id)
  }

  save(projectId: string, id: string, input: IProjectAccountSave, by: string): IProjectAccount {
    const current = this.repository.get(projectId, id)
    const issues = accountIssues(input.kind, input.public, input.secret, !current || current.kind !== input.kind)
    if (issues.length) throw new AccountValidationError(issues)
    return this.repository.save(projectId, id, { ...input, label: input.label.trim() || id }, by)
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
    return { env, problems }
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
