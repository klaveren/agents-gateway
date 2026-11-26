/**
 * Uma sessão de LOGIN de pessoa (um navegador ou aparelho): o que a lista "Sessões abertas" mostra. ⛔ Nunca o token —
 * só o id da sessão (`sid`, o mesmo do token), o aparelho resumido e as datas.
 */
export interface ILoginSession {
  /** O `sid` do token. */
  id: string
  userId: string
  /** A geração da conta em que nasceu (`IStoredUser.sessionVersion`): de outra geração, já caiu. */
  ver: number
  /** "Manter conectado": 30 dias que deslizam com o uso. */
  keep: boolean
  /** O aparelho e o navegador, resumidos do user-agent (`Safari · iPhone`). */
  device: string
  createdAt: Date
  lastUsedAt: Date
  /** A validade do token mais novo desta sessão. */
  expiresAt: Date
}
