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
  return lines.join('\n')
}

/**
 * O id da conversa, na ENTRADA do modelo: no primeiro turno e quando o histórico do modelo recomeça (repasse, compactação,
 * retomada). ⛔ Não é gravado, não aparece na tela, não entra na transcrição: é do sistema, não da pessoa.
 */
export function conversationNote(conversationId: string): string {
  return `<contexto>id desta conversa: ${conversationId}</contexto>`
}
