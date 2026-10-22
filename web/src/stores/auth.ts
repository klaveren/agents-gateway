import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, ApiError, CALLER_TOKEN_KEY, GATEWAY_TOKEN_KEY } from '@/lib/api'
import { readLocal, writeLocal } from '@/lib/storage'

/**
 * Quem está usando a tela, do ponto de vista do gateway.
 *
 * ⚖️ ADMIN É PERGUNTADO, não deduzido do token: o gateway só considera admin quem tem a identidade
 * PROVADA (`CALLER_PROOF_TOOL`), e um papel no token não basta. `GET /settings` responde 200 só para
 * admin (404 para o resto) — é a mesma porta das telas de Agentes e Configuração.
 */
export const useAuthStore = defineStore('auth', () => {
  const gatewayToken = ref(readLocal(GATEWAY_TOKEN_KEY) ?? '')
  const callerToken = ref(readLocal(CALLER_TOKEN_KEY) ?? '')
  const isAdmin = ref(false)
  const checked = ref(false)
  /** O gateway recusou a credencial (401): a tela pede os tokens em vez de mostrar listas vazias. */
  const unauthorized = ref(false)

  async function probe(): Promise<void> {
    try {
      await api('/settings')
      isAdmin.value = true
      unauthorized.value = false
    } catch (error) {
      isAdmin.value = false
      unauthorized.value = error instanceof ApiError && error.status === 401
    } finally {
      checked.value = true
    }
  }

  function saveTokens(gateway: string, caller: string): Promise<void> {
    gatewayToken.value = gateway.trim()
    callerToken.value = caller.trim()
    writeLocal(GATEWAY_TOKEN_KEY, gatewayToken.value || null)
    writeLocal(CALLER_TOKEN_KEY, callerToken.value || null)
    return probe()
  }

  return { gatewayToken, callerToken, isAdmin, checked, unauthorized, probe, saveTokens }
})
