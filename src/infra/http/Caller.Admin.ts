import { TCallerIdentity } from '@infra/mcp/Caller.Identity'
import { provenCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { listFromEnv } from './Caller.Roles'

/** `identity` vem junto quando permitido: quem grava (`updatedBy`) já tem a identidade provada em mãos. */
export type TAdminAccess = { allowed: boolean; reason?: string; identity?: TCallerIdentity }

/**
 * Quem administra o gateway: lê e altera as configurações (e, em fases futuras, vê a conversa dos
 * outros). UMA função só, para cada porta administrativa passar pela mesma regra.
 *
 * ⚖️ DUAS FORMAS DE ENTRAR, e a diferença importa:
 *  · um PAPEL de `ADMIN_ROLES` (padrão: `admin`) — quem o produto já classifica como administrador;
 *  · um id ou e-mail de `ADMIN_USERS` — nomes avulsos, para quem administra sem ter esse papel.
 *
 * ⛔ SEMPRE COM IDENTIDADE PROVADA, sem exceção para `REQUIRE_PROVEN_OWNER=0`. Aqui a identidade
 * abre a única porta que atravessa o isolamento entre chamadores e que desliga o agente para todos;
 * papel e e-mail vêm do token, e token se forja. Sem `CALLER_PROOF_TOOL` configurada ninguém é
 * administrador — é o lado seguro, e o custo é só configurar a prova.
 *
 * ⚠️ O motivo volta no resultado e vai para o log de quem chama, mas NUNCA para a resposta: quem
 * recebe 404 não pode distinguir "não é administrador" de "a rota não existe".
 */
export async function checkAdminAccess(proof: ICallerProof | undefined): Promise<TAdminAccess> {
  const identity = await provenCaller(proof)
  if (!identity) return { allowed: false, reason: 'caller identity is not proven' }

  const roles = listFromEnv('ADMIN_ROLES', ['admin'])
  const users = listFromEnv('ADMIN_USERS', [])

  const role = identity.role?.trim().toLowerCase()
  if (role && roles.includes(role)) return { allowed: true, identity }

  const claims = [identity.id, identity.email].filter(Boolean).map((value) => String(value).trim().toLowerCase())
  if (claims.some((claim) => users.includes(claim))) return { allowed: true, identity }

  return { allowed: false, reason: 'caller is not an administrator' }
}
