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
export type TProjectAccountKind = 'github-app' | 'github-token' | 'gcp-service-account' | 'ssh-ca' | 'ssh-key' | 'secret-env'

export const PROJECT_ACCOUNT_KINDS: readonly TProjectAccountKind[] = ['github-app', 'github-token', 'gcp-service-account', 'ssh-ca', 'ssh-key', 'secret-env']

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
  /** SSH: os usuários remotos do certificado (CA) e por quantos minutos ele vale. */
  principals?: string[]
  validityMinutes?: number
  /** SSH: os padrões de `Host` em que a conta vale (vazio = todos) e os `known_hosts` aceitos. */
  hostPatterns?: string[]
  knownHosts?: string
  /** SSH: a chave pública da CA (para o `TrustedUserCAKeys` do servidor) ou da chave importada, e o certificado dela. */
  publicKey?: string
  certificate?: string
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
  return kind !== 'github-app' && kind !== 'gcp-service-account' && kind !== 'ssh-ca'
}

/** O gateway gera o segredo (a chave da CA): no cadastro, ninguém cola nada. */
export function generatesSecret(kind: TProjectAccountKind): boolean {
  return kind === 'ssh-ca'
}

export const SSH_VALIDITY = { default: 10, max: 60 } as const

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
const SSH_PRINCIPAL = /^[A-Za-z0-9._@-]{1,64}$/
const SSH_HOST_PATTERN = /^!?[A-Za-z0-9.*?_:[\]-]{1,253}$/

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
  if (kind === 'ssh-ca' || kind === 'ssh-key') {
    const lines = (input.knownHosts ?? '').split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'))
    if (!lines.length || lines.some((line) => line.trim().split(/\s+/).length < 3)) issues.push('knownHosts: linhas do known_hosts (host tipo chave), como as do ssh-keyscan')
    if ((input.knownHosts ?? '').length > 16_384) issues.push('knownHosts: grande demais')
    if ((input.hostPatterns ?? []).some((pattern) => !SSH_HOST_PATTERN.test(pattern))) issues.push('hostPatterns: nomes ou padrões de host (ex.: *.empresa1.com)')
  }
  if (kind === 'ssh-ca') {
    if (!input.principals?.length || input.principals.length > 20 || input.principals.some((name) => !SSH_PRINCIPAL.test(name)))
      issues.push('principals: os usuários remotos (ex.: deploy)')
    if (input.validityMinutes !== undefined && (!Number.isInteger(input.validityMinutes) || input.validityMinutes < 1 || input.validityMinutes > SSH_VALIDITY.max))
      issues.push(`validityMinutes: de 1 a ${SSH_VALIDITY.max}`)
  }
  if (kind === 'ssh-key') {
    if (secret !== undefined && !/-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----/.test(secret)) issues.push('secret: a chave privada SSH (sem senha)')
    if (input.certificate !== undefined && !/^ssh-[a-z0-9-]+-cert-v01@openssh\.com AAAA[A-Za-z0-9+/=]+( .*)?$/.test(input.certificate.trim()))
      issues.push('certificate: o conteúdo do -cert.pub')
  }
  if (kind === 'secret-env') {
    if (!ENV_NAME.test(input.envName ?? '')) issues.push('envName: maiúsculas, números e _ (ex.: GITLAB_TOKEN)')
    else if (RESERVED_ENV.test(input.envName!)) issues.push(`envName: ${input.envName} é do gateway`)
  }
  if (creating && !generatesSecret(kind) && !secret?.trim()) issues.push('secret: obrigatório')
  if (secret !== undefined && secret.length > 16_384) issues.push('secret: grande demais')
  return issues
}
