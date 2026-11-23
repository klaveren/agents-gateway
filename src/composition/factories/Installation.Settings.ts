import type { IAgentSettings } from '@domain/models/Settings.Model'
import type { IGitGuardOptions } from '@infra/tools/Git.Guard'
import { setGatewayReach } from '@infra/permissions/Gateway.Reach'
import { makeSettings } from './Settings.Factory'

let settings: IAgentSettings | undefined
let watching = false

/**
 * A cópia viva das Configurações para quem precisa delas SÍNCRONAS no caminho de cada comando (as travas de git, a base
 * das worktrees). Lida uma vez e acompanhada a cada gravação; antes da primeira leitura, os padrões.
 */
export function installationSettings(): IAgentSettings | undefined {
  if (!watching) {
    watching = true
    const store = makeSettings()
    void store
      .read()
      .then((stored) => (settings = stored))
      .catch(() => undefined)
    store.subscribe((stored) => (settings = stored))
  }
  return settings
}

/** 🌿 As travas de git desta instalação (ver `Git.Guard`): a pasta principal travada por padrão; protegidas, as escolhidas. */
export function gitGuardOptions(): IGitGuardOptions {
  const current = installationSettings()
  return {
    lockMainCheckout: current?.lockMainCheckout !== false,
    protectedBranches: current?.protectedBranches ?? [],
    ...(current?.branchPrefix ? { branchPrefix: current.branchPrefix } : {}),
  }
}

/** 🖥️ A variável do deploy que esconde "Permitir agentes de máquina" (o servidor onde ninguém deve ligar o modo pela tela). */
export function machineAgentsLocked(): boolean {
  return process.env.MACHINE_AGENTS?.trim().toLowerCase() === 'off'
}

/** 🔌 "Agentes alcançam a API deste gateway" está ligado? Lido vivo a cada comando; antes da primeira leitura, não (falha fechada). */
export function agentsReachGatewayApiOn(): boolean {
  return installationSettings()?.agentsReachGatewayApi === true
}

/**
 * 🖥️ Os agentes de máquina valem NESTA instalação? Ligado nas Configurações e não travado pelo deploy. Antes da primeira
 * leitura das Configurações, não (falha fechada).
 */
export function machineAgentsOn(): boolean {
  return !machineAgentsLocked() && installationSettings()?.machineAgents === true
}

// O portão, o cerco e o prompt leem a Configuração por aqui (viva, sem reiniciar).
setGatewayReach(agentsReachGatewayApiOn)
