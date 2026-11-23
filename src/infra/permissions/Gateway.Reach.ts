import { networkInterfaces } from 'node:os'

/** A porta HTTP do gateway (a do `PORT`; 3000 sem ela). */
export function gatewayHttpPort(): number {
  return Number(process.env.PORT) || 3000
}

let reach: () => boolean = () => false

/** A composição liga aqui a leitura viva da Configuração (`agentsReachGatewayApi`). Sem ela, desligado (falha fechada). */
export function setGatewayReach(read: () => boolean): void {
  reach = read
}

/**
 * 🔌 "Agentes alcançam a API deste gateway": ligado, a porta HTTP do gateway deixa de ser negada sempre e passa a valer como
 * qualquer serviço local (só com a regra EXATA `localhost:<porta>`). ⚖️ A troca: o agente (ou o processo que ele sobe) fala
 * com a API com o token que tiver, e o que ele alcança é o que esse token pode — por isso nasce desligado e só o admin liga.
 * ⛔ A porta do portão e o link-local seguem negados, ligado ou não.
 */
export function gatewayReachOn(): boolean {
  try {
    return reach() === true
  } catch {
    return false
  }
}

/** As portas HTTP do gateway que nenhum comando alcança agora: a do `PORT`, enquanto a Configuração está desligada. */
export function deniedGatewayPorts(): number[] {
  return gatewayReachOn() ? [] : [gatewayHttpPort()]
}

/** Os endereços da própria máquina que uma regra pode usar para chegar ao gateway. */
function ownHosts(): string[] {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((one) => !!one && !one.internal)
    .map((one) => one!.address)
  return ['localhost', '127.0.0.1', '::1', '[::1]', ...lan]
}

/**
 * A regra de rede `host:porta` que mira a porta HTTP do gateway na própria máquina — e por isso, com a Configuração
 * desligada, nunca vale. Devolve o motivo, ou nada se a regra não é essa.
 */
export function gatewayRuleReason(pattern: string, port: number = gatewayHttpPort()): string | undefined {
  const match = /^(.+):(\d{1,5})$/.exec(pattern.trim().toLowerCase())
  if (!match || Number(match[2]) !== port) return undefined
  if (!ownHosts().includes(match[1])) return undefined
  return `${pattern.trim()} é a porta do próprio gateway: sem efeito enquanto "Agentes alcançam a API deste gateway" estiver desligado (Sistema → Configurações)`
}
