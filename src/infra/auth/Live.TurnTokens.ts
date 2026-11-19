/**
 * ⚖️ OS LOGINS DE TURNOS EM ANDAMENTO. Um turno longo usa o login de quem conversa para chamar o próprio gateway (o MCP
 * dele, a ponte dos MCPs em contêiner, as ferramentas do turno). Sair da conta, ou sair de todos os aparelhos, não deve
 * matar no meio o trabalho que já começou: só impede os próximos.
 *
 * ⛔ O que este registro libera é estreito: o token tem de ter sido o de um turno que ainda roda, e só nas rotas que o
 * turno usa por dentro (`Local.CallerProof`). Conta desativada, papel trocado e senha trocada continuam derrubando na
 * hora. Contagem por token: duas conversas da mesma pessoa podem rodar juntas.
 */
export class LiveTurnTokens {
  private readonly held = new Map<string, number>()

  hold(token: string | undefined): () => void {
    if (!token) return () => undefined
    this.held.set(token, (this.held.get(token) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.held.get(token) ?? 1) - 1
      if (count > 0) this.held.set(token, count)
      else this.held.delete(token)
    }
  }

  holds(token: string): boolean {
    return this.held.has(token)
  }
}

let shared: LiveTurnTokens | undefined
/** Os turnos do processo (o provider segura; a prova consulta). */
export function liveTurnTokens(): LiveTurnTokens {
  shared ??= new LiveTurnTokens()
  return shared
}
