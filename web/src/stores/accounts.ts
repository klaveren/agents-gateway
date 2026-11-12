import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

export type TAccountKind = 'github-app' | 'github-token' | 'git-https' | 'gcp-service-account' | 'ssh-ca' | 'ssh-key' | 'secret-env' | 'turn-callback'

/** Uma conta do projeto como a tela a recebe: ⛔ nunca o segredo (só o fim dele). */
export interface IProjectAccount {
  id: string
  kind: TAccountKind
  label: string
  public: {
    owner?: string
    baseUrl?: string
    username?: string
    appId?: string
    installationId?: string
    repositories?: string[]
    envName?: string
    gcpProject?: string
    clientEmail?: string
    principals?: string[]
    validityMinutes?: number
    hostPatterns?: string[]
    knownHosts?: string
    publicKey?: string
    certificate?: string
    callbackHost?: string
    last4?: string
  }
  exposesSecret: boolean
  updatedAt: string
  updatedBy?: string
}

/** O corpo da gravação: o público e, se mudou, o segredo (que entra e não volta). */
export interface IAccountInput {
  kind: TAccountKind
  label: string
  public: Record<string, unknown>
  secret?: string
}

/**
 * As contas de cada projeto (só admin; a chave é o id do projeto). A gravação devolve a conta (sem o segredo) e ela
 * entra na lista, pelo id, como o servidor ordena; apagar a tira — sem reler.
 */
export const useAccountsStore = defineStore('accounts', () => {
  const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/accounts`
  const lists = keyedResource(async (projectId) => (await api<{ accounts: IProjectAccount[] }>(base(projectId))).accounts)

  async function save(projectId: string, id: string, input: IAccountInput): Promise<IProjectAccount> {
    const saved = await api<IProjectAccount>(`${base(projectId)}/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
    lists.update(projectId, (list) => [...list.filter((item) => item.id !== saved.id), saved].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    return saved
  }

  async function remove(projectId: string, id: string): Promise<void> {
    await api(`${base(projectId)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    lists.update(projectId, (list) => list.filter((item) => item.id !== id))
  }

  /** O teste da conta: uma chamada de verdade, na hora (não guardada). */
  async function test(projectId: string, id: string): Promise<{ ok: boolean; detail: string }> {
    return api<{ ok: boolean; detail: string }>(`${base(projectId)}/${encodeURIComponent(id)}/test`, { method: 'POST' })
  }

  /**
   * A conta "variável secreta" vira secreta do projeto (Ambiente → Variáveis): o valor vai junto, a conta sai. ⛔ Só pela
   * sessão da tela; nome que o projeto já tem é 409.
   */
  async function moveToVariables(projectId: string, id: string): Promise<void> {
    await api(`${base(projectId)}/${encodeURIComponent(id)}/move-to-variables`, { method: 'POST' })
    lists.update(projectId, (list) => list.filter((item) => item.id !== id))
  }

  return { lists, save, remove, test, moveToVariables }
})
