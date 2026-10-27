import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiError, authHeaders, CALLER_TOKEN_KEY, setUnauthorizedHandler } from '@/lib/api'
import { readLocal, writeLocal } from '@/lib/storage'
import type { ISession, IUser } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useConversationsStore } from './conversations'
import { useSettingsStore } from './settings'
import { useThreadStore } from './thread'
import { useUsageStore } from './usage'
import { useProjectsStore } from './projects'

/**
 * A sessão: quem está logado, e se é admin.
 *
 * ⚖️ ADMIN É PERGUNTADO AO GATEWAY (`GET /settings` responde 200 só para admin), e não deduzido do
 * papel guardado aqui: é a mesma porta das telas de operação, e vale também para quem entra por uma
 * prova externa em vez de conta local.
 *
 * ⛔ A SESSÃO MORA NUM COOKIE HttpOnly que o gateway grava no login: o JavaScript não a lê, e um XSS não
 * a leva. Esta store só sabe QUEM está logado (`/auth/me`), nunca o token.
 */
/** ⚠️ Só a limpeza: o portão do serviço (`GATEWAY_TOKEN`) saiu, e o que ficou no navegador de quem o usou não vale mais nada. */
const RETIRED_GATEWAY_TOKEN_KEY = 'gatewayToken'

export const useAuthStore = defineStore('auth', () => {
  writeLocal(RETIRED_GATEWAY_TOKEN_KEY, null)
  const user = ref<IUser>()
  const isAdmin = ref(false)
  const checked = ref(false)
  const unauthorized = ref(false)
  const localAccounts = ref(false)
  const setupRequired = ref(false)

  const signedIn = computed(() => !!user.value)

  /**
   * Esquece o que é de quem estava logado: a lista de conversas, a conversa aberta, as não lidas, o uso e as
   * configurações. ⚠️ Sem isto, quem entra depois no mesmo navegador vê, por um instante, os dados do anterior.
   */
  function clearClientState(): void {
    useConversationsStore().reset()
    useThreadStore().reset()
    useUsageStore().reset()
    useSettingsStore().reset()
    useProjectsStore().reset()
  }

  /**
   * Refaz o que depende de QUEM é e do que PODE: agentes, configurações (só admin) e o stream de eventos das
   * conversas (que muda de escopo com o papel). Roda quando o papel ou a conta muda, e no logout.
   */
  async function rescope(): Promise<void> {
    // Saiu de uma conta e há login: não há escopo até entrar de novo (a tela de login é quem refaz).
    if (!user.value && localAccounts.value) return
    // Os projetos primeiro: o atual recorta agentes, conversas e o stream.
    await useProjectsStore()
      .load()
      .catch(() => undefined)
    const conversations = useConversationsStore()
    conversations.subscribe(isAdmin.value)
    void conversations.load(isAdmin.value)
    const settings = useSettingsStore()
    await Promise.all([
      useAgentsStore()
        .load()
        .catch(() => undefined),
      isAdmin.value ? settings.load().catch(() => undefined) : settings.reset(),
    ])
  }

  async function probe(): Promise<void> {
    const wasChecked = checked.value
    const before = { admin: isAdmin.value, userId: user.value?.id }
    await scan()
    // Entrar (antes sem conta) quem chama já refaz o escopo; aqui é papel ou conta que mudou no meio da sessão.
    const login = before.userId === undefined && user.value !== undefined
    if (wasChecked && !login && (before.admin !== isAdmin.value || before.userId !== user.value?.id)) await rescope()
  }

  async function scan(): Promise<void> {
    try {
      const status = await api<{ localAccounts: boolean; setupRequired: boolean }>('/auth/status').catch(() => ({ localAccounts: false, setupRequired: false }))
      localAccounts.value = status.localAccounts
      setupRequired.value = status.setupRequired

      await migrateStoredSession()
      user.value = await api<IUser>('/auth/me').catch(() => undefined)

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

  /**
   * Quem entrou antes do cookie tem o token no `localStorage`: ele vira cookie uma vez (`/auth/cookie`)
   * e some daqui — sem pedir login de novo. Token vencido também some, e a tela pede login.
   */
  async function migrateStoredSession(): Promise<void> {
    const stored = readLocal(CALLER_TOKEN_KEY)
    if (!stored) return
    await fetch('/v1/auth/cookie', { method: 'POST', headers: { ...authHeaders(), 'X-Tool-Authorization': `Bearer ${stored}` } }).catch(() => undefined)
    writeLocal(CALLER_TOKEN_KEY, null)
  }

  async function start(session: ISession): Promise<void> {
    user.value = session.user
    await probe()
  }

  async function login(email: string, password: string): Promise<void> {
    await start(await api<ISession>('/auth/login', { method: 'POST', body: { email, password } }))
  }

  async function setup(input: { email: string; name: string; password: string; code: string }): Promise<void> {
    await start(await api<ISession>('/auth/setup', { method: 'POST', body: input }))
  }

  /** Sai NO SERVIDOR (todas as sessões da conta) e depois aqui. Se o servidor não responder, sai daqui mesmo assim. */
  async function logout(): Promise<void> {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
    user.value = undefined
    isAdmin.value = false
    clearClientState()
    await scan()
    await rescope()
  }

  /** As outras sessões caem; esta continua com o token novo que o gateway devolve. */
  async function changePassword(current: string, password: string): Promise<void> {
    const session = await api<ISession>('/auth/password', { method: 'PUT', body: { current, password } })
    user.value = session.user
  }

  // Sessão recusada pelo gateway (venceu, conta desativada, papel trocado): sai e a tela pede login.
  setUnauthorizedHandler(() => {
    if (user.value) clearClientState()
    user.value = undefined
    isAdmin.value = false
  })

  return { user, isAdmin, checked, unauthorized, localAccounts, setupRequired, signedIn, probe, login, setup, logout, changePassword }
})
