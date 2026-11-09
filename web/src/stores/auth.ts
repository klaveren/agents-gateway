import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiError, authHeaders, CALLER_TOKEN_KEY, setUnauthorizedHandler } from '@/lib/api'
import { clearResources } from '@/lib/resource'
import { setEdition, type TEdition } from '@/lib/edition'
import { readLocal, writeLocal } from '@/lib/storage'
import type { ISession, ISettings, IUser } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useConversationsStore } from './conversations'
import { useMcpStore } from './mcp'
import { usePackagesStore } from './packages'
import { useImportsStore } from './imports'
import { useProvidersStore } from './providers'
import { useSchedulesStore } from './schedules'
import { useSettingsStore } from './settings'
import { useThreadStore } from './thread'
import { useUsageStore } from './usage'
import { useProjectsStore } from './projects'
import { useUsersStore } from './users'

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
   * Esquece o que é de quem estava logado: a lista de conversas, a conversa aberta, as não lidas, o uso, as
   * configurações e o que as stores guardam (agentes, providers, MCPs, contas, agendamentos, pacotes). ⚠️ Sem isto,
   * quem entra depois no mesmo navegador vê, por um instante — ou de vez, no que é lido uma vez só —, os dados do anterior.
   */
  function clearClientState(): void {
    useConversationsStore().reset()
    useThreadStore().reset()
    useUsageStore().reset()
    useSettingsStore().reset()
    useProjectsStore().reset()
    useAgentsStore().reset()
    useProvidersStore().reset()
    useMcpStore().reset()
    useUsersStore().reset()
    useSchedulesStore().reset()
    usePackagesStore().reset()
    useImportsStore().reset()
    // As stores do catálogo, da importação e as outras: todo dado lido pelo `keyedResource`.
    clearResources()
  }

  /**
   * Refaz o que depende de QUEM é e do que PODE: agentes, as ferramentas, configurações (só admin) e o stream de
   * eventos das conversas (que muda de escopo com o papel). Roda quando o papel ou a conta muda, e no logout.
   */
  async function rescope(): Promise<void> {
    // Saiu de uma conta e há login: não há escopo até entrar de novo (a tela de login é quem refaz).
    if (!user.value && localAccounts.value) return
    // Os projetos primeiro: o atual recorta agentes, conversas e o stream.
    await useProjectsStore()
      .load()
      .catch(() => undefined)
    const conversations = useConversationsStore()
    // ⚖️ "De todos" vale para o admin do gateway e para quem administra o projeto atual (os projetos já foram lidos).
    const everyone = useProjectsStore().seesAll
    conversations.subscribe(everyone)
    void conversations.load(everyone)
    const settings = useSettingsStore()
    const agents = useAgentsStore()
    await Promise.all([
      agents.load().catch(() => undefined),
      agents.loadTools().catch(() => undefined),
      // ⚖️ `ensure`: a pergunta "é admin?" (`scan`) acabou de trazê-las.
      isAdmin.value ? settings.ensure().catch(() => undefined) : settings.reset(),
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
      // ⚖️ As três de uma vez: o gateway pode estar longe (~220 ms de ida e volta), e cada espera em fila soma isso.
      const status = api<{ localAccounts: boolean; setupRequired: boolean; edition?: TEdition }>('/auth/status').catch(() => ({ localAccounts: false, setupRequired: false, edition: undefined }))
      // O token antigo vira cookie ANTES de perguntar quem é (só quando há um no navegador).
      await migrateStoredSession()
      const [found, me, admin] = await Promise.all([
        status,
        api<IUser>('/auth/me').catch(() => undefined),
        // ⚖️ A resposta não é descartada: vira as configurações guardadas (a tela de Sistema não pergunta de novo).
        api<ISettings>('/settings').then(
          (settings) => void useSettingsStore().seed(settings),
          (error: unknown) => error,
        ),
      ])
      localAccounts.value = found.localAccounts
      setupRequired.value = found.setupRequired
      setEdition(found.edition)
      user.value = me
      isAdmin.value = admin === undefined
      unauthorized.value = admin instanceof ApiError && admin.status === 401
    } finally {
      // Sem resposta do status, PRO: o router não fica esperando.
      setEdition(undefined)
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
