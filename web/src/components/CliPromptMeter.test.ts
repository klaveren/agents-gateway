import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { CLI_ARG_MAX_BYTES } from '@/lib/cliPrompt'
import type { IAgentFootprint } from '@/lib/types'
import CliPromptMeter from './CliPromptMeter.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const saved = { soul: 'Calma.', systemPrompt: 'Faça X.' }

function footprint(bytes: number): IAgentFootprint {
  return {
    total: 0,
    sections: [],
    cli: {
      providers: ['codex'],
      bytes,
      limit: CLI_ARG_MAX_BYTES,
      warnAt: Math.floor(CLI_ARG_MAX_BYTES * 0.8),
      parts: [
        { key: 'soul', label: 'Soul', bytes: 50 },
        { key: 'instructions', label: 'Instrução do sistema', bytes: 8 },
        { key: 'projectSpecs', label: 'Contexto inicial do projeto', bytes: bytes - 1_000 },
        { key: 'skills', label: 'Índice de skills', bytes: 900 },
      ],
    },
  }
}

async function mount(props: Record<string, unknown>): Promise<HTMLElement> {
  const host = document.createElement('div')
  const pinia = createPinia()
  setActivePinia(pinia)
  createApp(CliPromptMeter, props).use(pinia).mount(host)
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  return host
}

describe('CliPromptMeter', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  it('abaixo de 80%: o total contra o limite, sem aviso', async () => {
    vi.mocked(api).mockResolvedValueOnce(footprint(60_000))
    const host = await mount({ providers: ['Codex'], codex: false, ...saved, agentId: 'dev', projectId: 'xpto', saved })
    expect(api).toHaveBeenCalledWith('/agents/dev/footprint', { query: {} })
    expect(host.textContent).toContain('Prompt no Codex: ≈ 58,6 KiB de 128 KiB (46%)')
    expect(host.querySelector('[data-test="cli-warn"]')).toBeNull()
  })

  it('a partir de 80%: aviso, sem bloquear, dizendo o que pesa mais', async () => {
    vi.mocked(api).mockResolvedValueOnce(footprint(110_000))
    const host = await mount({ providers: ['Codex', 'Antigravity'], codex: false, ...saved, agentId: 'dev', projectId: 'xpto', saved })
    const warn = host.querySelector('[data-test="cli-warn"]')
    expect(warn?.textContent).toContain('Perto do limite do Linux')
    expect(warn?.textContent).toContain('O que mais pesa: Contexto inicial do projeto (106,4 KiB), Índice de skills (0,9 KiB)')
  })

  it('acima do limite: diz que a conversa nesses provedores vai ser recusada', async () => {
    vi.mocked(api).mockResolvedValueOnce(footprint(CLI_ARG_MAX_BYTES + 10))
    const host = await mount({ providers: ['Codex'], codex: false, ...saved, agentId: 'dev', projectId: 'xpto', saved })
    expect(host.querySelector('[data-test="cli-warn"]')?.textContent).toContain('vai ser recusada')
  })

  it('agente novo: só o soul e a instrução da tela, sem pedir nada ao servidor', async () => {
    const host = await mount({ providers: ['Antigravity'], codex: false, systemPrompt: 'a'.repeat(110_000) })
    expect(api).not.toHaveBeenCalled()
    expect(host.querySelector('[data-test="cli-warn"]')?.textContent).toContain('Instrução do sistema')
    expect(host.textContent).toContain('entram depois de salvar')
  })
})
