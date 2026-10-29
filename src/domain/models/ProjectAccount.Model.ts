/**
 * AS CONTAS DE UM PROJETO: as credenciais que o terminal dos agentes dele usa (o GitHub da empresa, uma variável
 * secreta). Cada projeto tem as suas; o cerco já esconde um projeto do outro.
 *
 * ⛔ O SEGREDO DE LONGO PRAZO NUNCA ENTRA NO CERCO quando há como evitar: do GitHub App vai ao comando só um token de
 * 1h, gerado no gateway. Os tipos em que o comando recebe o próprio segredo (`exposesSecret`) dizem isso na tela — o
 * que o shell usa, o shell consegue imprimir.
 *
 * ⚖️ Quem usa cada conta: as permissões (`account <id>`), nas camadas do agente e do projeto. Sem regra, ninguém.
 */
export type TProjectAccountKind = 'github-app' | 'github-token' | 'gcp-service-account' | 'secret-env'

export const PROJECT_ACCOUNT_KINDS: readonly TProjectAccountKind[] = ['github-app', 'github-token', 'gcp-service-account', 'secret-env']

/** O que pode aparecer na tela e no log. O segredo fica à parte, selado. */
export interface IProjectAccountPublic {
  /** GitHub: a organização ou o usuário dono dos repositórios (o credential helper do git vale só para ele). */
  owner?: string
  /** GitHub App: o id do app e o da instalação. */
  appId?: string
  installationId?: string
  /** GitHub App: os repositórios do token (vazio = todos os da instalação). */
  repositories?: string[]
  /** GCP: o projeto padrão do `gcloud` e a conta de serviço (o e-mail dela, lido do JSON). */
  gcpProject?: string
  clientEmail?: string
  /** Variável secreta: o nome dela no comando. */
  envName?: string
  /** O fim do segredo, para reconhecer qual foi cadastrado. */
  last4?: string
}

export interface IProjectAccount {
  projectId: string
  id: string
  kind: TProjectAccountKind
  label: string
  public: IProjectAccountPublic
  updatedAt: Date
  updatedBy?: string
}

/** O comando recebe o próprio segredo (não um derivado de vida curta). */
export function exposesSecret(kind: TProjectAccountKind): boolean {
  return kind !== 'github-app' && kind !== 'gcp-service-account'
}

/** O JSON de uma conta de serviço do GCP, com o que a troca por token precisa. */
export interface IGcpServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
  project_id?: string
}

export function parseGcpKey(secret: string): IGcpServiceAccountKey | undefined {
  try {
    const key = JSON.parse(secret) as Partial<IGcpServiceAccountKey> & { type?: string }
    if (key.type !== 'service_account' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string') return undefined
    return key as IGcpServiceAccountKey
  } catch {
    return undefined
  }
}

export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/

/**
 * ⛔ Nomes que uma variável secreta não pode tomar: os que o cerco e o gateway montam (HOME, o proxy, o ssh do git) e
 * os que mudam o que o shell ou o Node executam.
 */
const RESERVED_ENV =
  /^(HOME|PATH|TMPDIR|SHELL|ENV|BASH_ENV|IFS|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_USE_ENV_PROXY|NO_PROXY|GIT_SSH_COMMAND|GH_TOKEN|GITHUB_TOKEN|GOOGLE_CLOUD_PROJECT)$|PROXY$|^(LD_|DYLD_|GIT_CONFIG|GATEWAY_|npm_config_|CLOUDSDK_)/i

/** O que se valida no cadastro: o público e o segredo de cada tipo. Devolve os problemas (vazio = ok). */
export function accountIssues(kind: TProjectAccountKind, input: IProjectAccountPublic, secret: string | undefined, creating: boolean): string[] {
  const issues: string[] = []
  if (input.owner !== undefined && !GITHUB_OWNER.test(input.owner)) issues.push('owner: nome de organização ou usuário do GitHub')
  if (kind === 'github-app') {
    if (!/^\d{1,12}$/.test(input.appId ?? '')) issues.push('appId: o número do GitHub App')
    if (!/^\d{1,15}$/.test(input.installationId ?? '')) issues.push('installationId: o número da instalação')
    if ((input.repositories ?? []).some((repo) => !GITHUB_REPO.test(repo))) issues.push('repositories: só o nome do repositório, sem o dono')
    if (secret !== undefined && !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(secret)) issues.push('secret: a chave privada do App (.pem)')
  }
  if (kind === 'gcp-service-account') {
    if (input.gcpProject !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.gcpProject)) issues.push('gcpProject: o id do projeto do GCP')
    if (secret !== undefined && !parseGcpKey(secret)) issues.push('secret: o JSON da conta de serviço (type service_account)')
  }
  if (kind === 'secret-env') {
    if (!ENV_NAME.test(input.envName ?? '')) issues.push('envName: maiúsculas, números e _ (ex.: GITLAB_TOKEN)')
    else if (RESERVED_ENV.test(input.envName!)) issues.push(`envName: ${input.envName} é do gateway`)
  }
  if (creating && !secret?.trim()) issues.push('secret: obrigatório')
  if (secret !== undefined && secret.length > 16_384) issues.push('secret: grande demais')
  return issues
}
