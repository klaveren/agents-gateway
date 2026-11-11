import type { IAgentSettings } from '@domain/models/Settings.Model'
import type { IGitGuardOptions } from '@infra/tools/Git.Guard'
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
