/** O que se sabe de quem está falando, já confirmado pelo gateway. Todos os campos são opcionais. */
export interface ISessionIdentity {
  id?: string
  email?: string
  role?: string
  account?: string
}

/**
 * Quem escreve o contexto que abre uma conversa.
 *
 * ⚖️ UM PORT, e não texto no código. O que vale dizer ao modelo antes da primeira pergunta — conta,
 * usuário, data — é decisão de PRODUTO; o gateway só garante o mecanismo: entra uma vez, e não vira
 * parte do que a pessoa escreveu. Devolver `undefined` é "não há contexto", e a mensagem segue pura.
 *
 * ⛔ O resultado é lido pelo modelo como se viesse do sistema. Nunca monte o contexto com texto
 * livre de quem chama: o que vem de identidade passa por quem sanitiza (ver `Template.SessionContext`).
 */
export interface ISessionContextProvider {
  (identity: ISessionIdentity): string | undefined
}
