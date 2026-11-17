import { HostApprovalsService } from '@application/HostApprovals.Service'

let shared: HostApprovalsService | undefined

/** 🖥️ Um só por processo: quem pede (o terminal do agente de máquina) e quem responde (a rota da conversa) se encontram aqui. */
export function makeHostApprovals(): HostApprovalsService {
  shared ??= new HostApprovalsService()
  return shared
}
