import { caller, TCallerIdentity } from '@infra/mcp/Caller.Identity'
import { ICallerProof } from './Caller.Proof'

/** Quem passou pelo portão: uma identidade (provada ou só afirmada), ou ninguém (chamada anônima). */
export interface IResolvedCaller {
  /** Ausente na chamada anônima — sem credencial nenhuma, só possível com `ALLOW_ANONYMOUS=1`. */
  identity?: TCallerIdentity
  /** `true` só quando a prova confirmou o token. */
  proven: boolean
}

/**
 * `REQUIRE_PROVEN_OWNER` — se só a identidade PROVADA vale como dono. Padrão: SIM.
 *
 * ⚖️ O TRADE-OFF, e por que o padrão é o lado seguro. Sem prova, a identidade é o que o token
 * AFIRMA, e o gateway não tem como verificar a assinatura: quem sabe o id de outra pessoa forja um
 * token com ele em um minuto e passa a listar, ler e dirigir as sessões dela — gasto de modelo
 * incluso. Aceitar identidade afirmada como dono troca essa garantia por conveniência.
 *
 * O custo do padrão seguro é real e é barulhento de propósito: sem `CALLER_PROOF_TOOL`, uma
 * credencial presente é RECUSADA (401) nas rotas de identidade, e o boot avisa. Barulho que se
 * conserta com uma variável é melhor que um buraco que ninguém vê. Desligue
 * (`REQUIRE_PROVEN_OWNER=0`) só quando todo chamador já for de confiança — uma rede privada, um
 * proxy seu que verifica o token antes — e o dono servir apenas para separar conversas, nunca para
 * proteger uma da outra.
 *
 * Lido a cada chamada, para o teste ligar e desligar entre casos.
 */
export function requireProvenOwner(): boolean {
  const raw = process.env.REQUIRE_PROVEN_OWNER?.trim().toLowerCase()

  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

/**
 * A identidade de quem chamou, DEPOIS de a prova confirmar a credencial.
 *
 * ⛔ USE ISTO SEMPRE QUE A IDENTIDADE DECIDIR ACESSO. `caller()` sozinho devolve o que o token
 * AFIRMA; aqui devolve o que foi CONFIRMADO. A diferença entre os dois é um JWT forjado com o id
 * de outra pessoa — que passa no primeiro e não passa aqui.
 *
 * `undefined` quando não há credencial, quando a prova está desligada, quando a prova recusa ou
 * quando não pôde ser feita. Na dúvida, não é ninguém.
 */
export async function provenCaller(proof: ICallerProof | undefined): Promise<TCallerIdentity | undefined> {
  const identity = caller()
  if (!proof || !identity?.token || !identity.id) return undefined
  if (proof.covers && !proof.covers(identity.token)) return undefined

  return (await proof.prove(identity.token)) ? identity : undefined
}

/**
 * Decide quem a requisição é, para as rotas em que identidade importa. `undefined` = recusado.
 *
 * - SEM credencial: anônimo. O portão (`requireCaller`) já recusou quem não tem credencial, a menos
 *   que `ALLOW_ANONYMOUS=1` — então chegar aqui assim é o uso local, de um usuário só.
 * - COM credencial e prova ligada: só passa se a prova confirmar.
 * - COM credencial e prova desligada: só passa se `REQUIRE_PROVEN_OWNER=0` e o token trouxer um id.
 * - ⛔ COM credencial sem id legível: NUNCA vira anônimo. Credencial que não identifica ninguém
 *   cairia no escopo "sem dono", e esse escopo enxerga o que não tem dono — "não consegui
 *   identificar" jamais pode virar "aqui está tudo".
 */
export async function resolveCaller(proof: ICallerProof | undefined): Promise<IResolvedCaller | undefined> {
  const identity = caller()
  if (!identity?.token) return { proven: false }
  if (!identity.id) return undefined

  // Prova que não responde por este token = sem prova para ele (ver `ICallerProof.covers`).
  if (proof && (!proof.covers || proof.covers(identity.token))) return (await provenCaller(proof)) ? { identity, proven: true } : undefined

  return requireProvenOwner() ? undefined : { identity, proven: false }
}

/** O dono que a sessão grava ao nascer. Vazio para o anônimo: a sessão fica sem dono. */
export function ownerOf(resolved: IResolvedCaller): Record<string, string> | undefined {
  const identity = resolved.identity
  if (!identity?.id) return undefined

  const owner: Record<string, string> = { id: identity.id }
  if (identity.email) owner.email = identity.email
  if (identity.account) owner.account = identity.account

  return owner
}

/**
 * A sessão é deste chamador?
 *
 * ⚖️ O anônimo só enxerga o que não tem dono, e quem tem identidade só enxerga o que é dele — os
 * dois escopos nunca se tocam. Sessão com conta exige a mesma conta: a mesma pessoa costuma ter
 * acesso a mais de uma, e trocar de conta não pode continuar mostrando as sessões da anterior.
 */
export function ownsSession(resolved: IResolvedCaller, metadata: Record<string, unknown> | undefined): boolean {
  const owner = metadata?.owner as { id?: unknown; account?: unknown } | undefined
  const hasOwner = typeof owner === 'object' && owner !== null && owner.id !== undefined

  if (!resolved.identity) return !hasOwner
  if (!hasOwner || owner.id !== resolved.identity.id) return false

  return !owner.account || owner.account === resolved.identity.account
}
