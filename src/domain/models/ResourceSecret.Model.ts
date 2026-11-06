import { ENV_NAME, RESERVED_ENV } from './ProjectAccount.Model'

/**
 * ⚖️ AS VARIÁVEIS SECRETAS de um agente, de uma skill ou de um command: o que o recurso precisa para operar (um token, uma
 * senha) sem que o valor passe pelo modelo. O agente recebe só o NOME; o valor entra como variável de ambiente nos
 * processos que o gateway abre, e a máscara da conversa o troca por `[segredo:<NOME>]` em tudo o que sai.
 *
 * ⛔ O VALOR SÓ ENTRA: cifrado no cofre (AES-256-GCM, a chave fora do banco), amarrado ao recurso e ao nome; nenhuma rota
 * o devolve, nem ao admin. Fora do histórico e da exportação do catálogo.
 *
 * ⚖️ QUANDO VALE: a do agente, em todo comando dele; a de uma skill ou de um command, só depois que ele foi CARREGADO na
 * conversa (`use_resource`, `/skill`, `/command`). Nome repetido: command > skill > agente > conta do projeto.
 *
 * ⛔ POR PROJETO (skill e command): o segredo NÃO vai junto no compartilhamento. Os valores da ORIGEM (o projeto do recurso,
 * ou o global) moram sob o projeto `''` (`ORIGIN_PROJECT`); cada projeto que recebeu o recurso configura os SEUS, com os
 * mesmos nomes, sob o id dele. Um agente do projeto P usa os valores de P — nunca os da origem.
 */
export type TSecretScope = 'agent' | 'skill' | 'command'
export const SECRET_SCOPES: readonly TSecretScope[] = ['agent', 'skill', 'command']

/** O "projeto" dos valores da ORIGEM (o projeto dono do recurso, ou o global) e de todo agente. */
export const ORIGIN_PROJECT = ''

/** O que se lê de uma variável: tudo, menos o valor. */
export interface IResourceSecretMeta {
  scope: TSecretScope
  scopeId: string
  name: string
  description?: string
  updatedAt: Date
  updatedBy?: string
}

/**
 * O que a tela lê: a variável com valor (`configured`) ou só o NOME esperado, que a origem usa e este projeto ainda não
 * configurou (`configured: false`, sem `updatedAt`).
 */
export interface IResourceSecretView extends Omit<IResourceSecretMeta, 'updatedAt'> {
  updatedAt?: Date
  configured: boolean
}

export const SECRET_LIMITS = { perScope: 30, description: 300, value: 16_384 } as const

/** ⛔ AAD do cofre: o cifrado de uma variável não abre como o de outra (outro recurso, outro nome). */
export function secretOwner(scope: TSecretScope, scopeId: string, name: string, project: string = ORIGIN_PROJECT): string {
  return project === ORIGIN_PROJECT ? `segredo:${scope}:${scopeId}:${name}` : `segredo:${scope}:${scopeId}:${name}@projeto:${project}`
}

/** Os problemas do nome (o mesmo padrão das contas do projeto, sem os que o cerco e o gateway montam). */
export function secretNameIssue(name: string): string | undefined {
  if (!ENV_NAME.test(name)) return 'maiúsculas, números e _ (ex.: GITLAB_TOKEN)'
  if (RESERVED_ENV.test(name)) return `${name} é do gateway`
  return undefined
}

/** Um recurso carregado na conversa (`skill:<id>` ou `command:<id>`), na ordem em que entrou. */
export interface ILoadedResource {
  kind: 'skill' | 'command'
  id: string
}

/** De onde veio cada variável que vale agora (o prompt e a ferramenta mostram; o valor nunca). */
export interface ISecretSource {
  name: string
  scope: TSecretScope
  scopeId: string
  /** De quem é o valor: `ORIGIN_PROJECT` (a origem) ou o projeto que recebeu o recurso. */
  project?: string
}

/**
 * As variáveis que valem agora, por PRECEDÊNCIA: command > skill > agente (a conta do projeto fica por baixo, no
 * terminal). Entre dois do mesmo tipo, o carregado por último vence.
 */
export function effectiveSources(agent: readonly ISecretSource[], loaded: readonly ISecretSource[][]): ISecretSource[] {
  const byName = new Map<string, ISecretSource>()
  const rank: Record<TSecretScope, number> = { agent: 0, skill: 1, command: 2 }
  for (const source of [...agent, ...loaded.flat()]) {
    const current = byName.get(source.name)
    if (!current || rank[source.scope] >= rank[current.scope]) byName.set(source.name, source)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * ⛔ O COMANDO QUE SÓ MOSTRA UMA VARIÁVEL SECRETA: `echo $X`, `printf "%s" "$X"`, `printenv`, `env`, `set`, `declare -p`,
 * `export -p`, ler `/proc/*\/environ` — só quando há variável secreta valendo. Devolve o motivo (ou nada). ⚖️ Usar a variável (`curl -H "…: $X"`) passa; quem
 * embaralha o valor de propósito passa pela máscara também — esta trava pega o descuido, não o mal-intencionado.
 */
export function printsSecret(command: string, names: readonly string[]): string | undefined {
  const text = command.trim()
  // Sem variável secreta valendo, nada a proteger: `env` e `printenv` seguem livres.
  if (!text || !names.length) return undefined
  if (/\/proc\/[^\s/]+\/environ/.test(text)) return 'ler o ambiente do processo'
  // `env` / `printenv` / `set` / `declare -p` / `export -p` sozinhos (ou num pipe) despejam o ambiente inteiro.
  if (/(?:^|[;&|]\s*)(?:printenv|env|set|declare\s+-[a-zA-Z]*p|export\s+-p|compgen\s+-v)\s*(?:$|[;&|>])/.test(text)) return 'despejar o ambiente'
  for (const name of names) {
    const ref = `\\$(?:\\{${name}(?:[:#%/][^}]*)?\\}|${name}\\b)`
    if (new RegExp(`(?:^|[;&|(\`]\\s*|\\$\\(\\s*)(?:(?:echo|printf|print|printenv)\\b|cat\\s*<<<)[^;&|]*${ref}`).test(text)) return `mostrar ${name}`
    if (new RegExp(`\\bprintenv\\s+${name}\\b`).test(text)) return `mostrar ${name}`
  }
  return undefined
}
