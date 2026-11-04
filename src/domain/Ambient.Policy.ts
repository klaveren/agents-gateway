/**
 * ⚖️ O MÍNIMO QUE O AGENTE SABE SEM GASTAR FERRAMENTA: quem ele é (o id), em que projeto está e onde opera (o diretório).
 * Vai no system prompt, uma vez (ver `composeSystemPrompt`): é estável na sessão. O id da conversa não está aqui — nasce
 * depois da composição e a sessão pode adotar outro — e vai na entrada do modelo (ver `conversationNote`).
 */
export interface IAmbient {
  agentId: string
  /** O projeto da conversa. `own`: o agente é dele, e trabalha na pasta dele. */
  project?: { id: string; name?: string; own: boolean }
  /** Aberta num repositório do projeto (e numa worktree dele). */
  repository?: { name: string; worktree?: string; branch?: string }
  /**
   * O diretório de operação: o do repositório ou da worktree, senão o do projeto do agente. É o `cwd` das lanes de código
   * (Claude Agent SDK, Codex) e a raiz das ferramentas do gateway (`run_bash`, arquivos). Ausente: a pasta vazia da conversa.
   */
  directory?: string
  /** A pasta com os arquivos do próprio agente (scripts, modelos): só leitura para ele. */
  files?: string
  /** As variáveis secretas que o agente pode usar (só os nomes; ver `ResourceSecret.Model`). */
  secrets?: IAmbientSecrets
}

/** Os NOMES das variáveis secretas: as do agente e as de cada skill ou command que ele pode carregar. */
export interface IAmbientSecrets {
  agent: string[]
  resources: Array<{ kind: 'skill' | 'command'; id: string; names: string[] }>
}

/** A seção "## Ambiente" do system prompt. */
export function ambientSection(ambient: IAmbient): string {
  const lines = ['## Ambiente', `- Agente: ${ambient.agentId}.`]
  const { project, repository, directory } = ambient
  if (project) {
    const label = project.name ? `${project.name} (projectId "${project.id}")` : `projectId "${project.id}"`
    lines.push(project.own || repository ? `- Projeto: ${label}.` : `- Projeto atual: ${label}. Agentes, hooks e conversas que você criar aqui pertencem a este projeto.`)
  }
  if (repository)
    lines.push(`- Repositório: ${repository.name}${repository.worktree ? `, worktree ${repository.worktree}` : ''}${repository.branch ? ` (branch ${repository.branch})` : ''}.`)
  if (!directory) lines.push('- Diretório de trabalho: uma pasta vazia, só desta conversa.')
  else if (repository) lines.push(`- Diretório de trabalho: ${directory}. Fora dele você não lê nem grava; o git dele funciona (status, commit, push).`)
  else lines.push(`- Diretório de trabalho: ${directory} — persistente e compartilhado pelas conversas do projeto. Fora dele você não lê nem grava.`)
  if (ambient.files) lines.push(`- Seus arquivos (scripts, modelos): ${ambient.files} — só leitura; rode-os pelo terminal a partir dessa pasta.`)
  if (ambient.secrets) lines.push('', secretsSection(ambient.secrets))
  return lines.join('\n')
}

/**
 * ⛔ As variáveis secretas: o agente sabe o NOME e usa `$NOME` no terminal; o valor nunca passa por ele. Imprimir é recusado
 * e o que sair com o valor é mascarado.
 */
function secretsSection(secrets: IAmbientSecrets): string {
  const lines = [
    '## Variáveis secretas',
    'Estão no ambiente dos seus comandos: use `$NOME` (ex.: `curl -H "Authorization: Bearer $NOME"`). Nunca as imprima, copie para arquivo nem as passe ao modelo; o valor não está aqui de propósito. Falta uma? Peça com `request_secret`.',
  ]
  if (secrets.agent.length) lines.push(`- Suas: ${secrets.agent.map((name) => `\`${name}\``).join(', ')}.`)
  for (const resource of secrets.resources)
    lines.push(`- ${resource.kind === 'skill' ? 'Skill' : 'Command'} ${resource.id} (valem depois de carregá-la): ${resource.names.map((name) => `\`${name}\``).join(', ')}.`)
  return lines.join('\n')
}

/**
 * O id da conversa, na ENTRADA do modelo: no primeiro turno e quando o histórico do modelo recomeça (repasse, compactação,
 * retomada). ⛔ Não é gravado, não aparece na tela, não entra na transcrição: é do sistema, não da pessoa.
 */
export function conversationNote(conversationId: string): string {
  return `<contexto>id desta conversa: ${conversationId}</contexto>`
}
