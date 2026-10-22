import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiError, CALLER_TOKEN_KEY, GATEWAY_TOKEN_KEY, setUnauthorizedHandler } from '@/lib/api'
import { readLocal, writeLocal } from '@/lib/storage'
import type { ISession, IUser } from '@/lib/types'

/**
 * A sessão: quem está logado, e se é admin.
 *
 * ⚖️ ADMIN É PERGUNTADO AO GATEWAY (`GET /settings` responde 200 só para admin), e não deduzido do
 * papel guardado aqui: é a mesma porta das telas de operação, e vale também para quem entra por uma
 * prova externa em vez de conta local.
 *
 * O token vai no `X-Tool-Authorization` (a chave `callerToken`), o cabeçalho que o gateway já lia.
 */
export const useAuthStore = defineStore('auth', () => {
  const gatewayToken = ref(readLocal(GATEWAY_TOKEN_KEY) ?? '')
  const user = ref<IUser>()
  const isAdmin = ref(false)
  const checked = ref(false)
  const unauthorized = ref(false)
  const localAccounts = ref(false)
  const setupRequired = ref(false)

  const signedIn = computed(() => !!user.value)

  async function probe(): Promise<void> {
    try {
      const status = await api<{ localAccounts: boolean; setupRequired: boolean }>('/auth/status').catch(() => ({ localAccounts: false, setupRequired: false }))
      localAccounts.value = status.localAccounts
      setupRequired.value = status.setupRequired

      user.value = readLocal(CALLER_TOKEN_KEY) ? await api<IUser>('/auth/me').catch(() => undefined) : undefined

      try {
        await api('/settings')
        isAdmin.value = true
        unauthorized.value = false
      } catch (error) {
        isAdmin.value = false
        unauthorized.value = error instanceof ApiError && error.status === 401
      }
    } finally {
      checked.value = true
    }
  }

  async function start(session: ISession): Promise<void> {
    writeLocal(CALLER_TOKEN_KEY, session.token)
    user.value = session.user
    await probe()
  }

  async function login(email: string, password: string): Promise<void> {
    await start(await api<ISession>('/auth/login', { method: 'POST', body: { email, password } }))
  }

  async function setup(input: { email: string; name: string; password: string }): Promise<void> {
    await start(await api<ISession>('/auth/setup', { method: 'POST', body: input }))
  }

  /** Sai NO SERVIDOR (todas as sessões da conta) e depois aqui. Se o servidor não responder, sai daqui mesmo assim. */
  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
    writeLocal(CALLER_TOKEN_KEY, null)
    user.value = undefined
    isAdmin.value = false
    return probe()
  }

  /** As outras sessões caem; esta continua com o token novo que o gateway devolve. */
  async function changePassword(current: string, password: string): Promise<void> {
    const session = await api<ISession>('/auth/password', { method: 'PUT', body: { current, password } })
    writeLocal(CALLER_TOKEN_KEY, session.token)
    user.value = session.user
  }

  function saveGatewayToken(value: string): Promise<void> {
    gatewayToken.value = value.trim()
    writeLocal(GATEWAY_TOKEN_KEY, gatewayToken.value || null)
    return probe()
  }

  // Sessão recusada pelo gateway (venceu, conta desativada, papel trocado): sai e a tela pede login.
  setUnauthorizedHandler(() => {
    writeLocal(CALLER_TOKEN_KEY, null)
    user.value = undefined
    isAdmin.value = false
  })

  return { gatewayToken, user, isAdmin, checked, unauthorized, localAccounts, setupRequired, signedIn, probe, login, setup, logout, changePassword, saveGatewayToken }
})
