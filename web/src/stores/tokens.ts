import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** Um token de acesso pessoal como a lista o traz: ⛔ nunca o token (só o prefixo). */
export interface IAccessToken {
  id: string
  name: string
  prefix: string
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
}

/**
 * Os tokens de acesso da conta (a chave é o id da conta: outra pessoa entrando não vê a lista da anterior). O criado
 * entra no topo (a lista vem do mais novo para o mais velho). ⛔ O token só vem na resposta de `create` e NUNCA fica
 * na store: quem chama o mostra uma vez. Revogar não devolve o token revogado: relê.
 */
export const useTokensStore = defineStore('tokens', () => {
  const lists = keyedResource(() => api<IAccessToken[]>('/auth/tokens'))

  async function create(userId: string, input: { name: string; expiresInDays: number }): Promise<IAccessToken & { token: string }> {
    const created = await api<IAccessToken & { token: string }>('/auth/tokens', { method: 'POST', body: input })
    const { token: _token, ...kept } = created
    lists.update(userId, (list) => [kept, ...list.filter((item) => item.id !== kept.id)])
    return created
  }

  async function revoke(userId: string, id: string): Promise<void> {
    await api(`/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await lists.refresh(userId).catch(() => undefined)
  }

  return { lists, create, revoke }
})
