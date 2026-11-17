import type { IPermissionRule } from './types'

/** Um serviço do ambiente do projeto: o Redis, o Kafka, o Mongo que o projeto usa. */
export interface IProjectService {
  name: string
  host: string
  port: string
}

const TARGET = /^([^\s:*/]+|\[[0-9a-f:]+\]):(\d{1,5})$/i
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i

/**
 * ⚖️ A regra que é um SERVIÇO: rede, permitir, `host:porta` exato (o mesmo `exactTcpTarget` do servidor). É ela que abre
 * a porta TCP no cerco; 80/443 são HTTP (passam pelo proxy) e `localhost` é porta local, ficam nas Permissões.
 */
export function isServiceRule(rule: IPermissionRule): boolean {
  if (rule.category !== 'network' || rule.decision !== 'allow') return false
  const match = TARGET.exec(rule.pattern.trim())
  return !!match && !['80', '443'].includes(match[2]!) && !LOOPBACK.test(match[1]!)
}

export function serviceOf(rule: IPermissionRule): IProjectService {
  const pattern = rule.pattern.trim()
  const at = pattern.lastIndexOf(':')
  return { name: rule.note ?? '', host: pattern.slice(0, at), port: pattern.slice(at + 1) }
}

export function ruleOf(service: IProjectService): IPermissionRule {
  const name = service.name.trim()
  return { category: 'network', pattern: `${service.host.trim()}:${service.port.trim()}`, decision: 'allow', ...(name ? { note: name } : {}) }
}

/** O que está errado na linha, em português; vazio = serve. */
export function serviceIssue(service: IProjectService): string | undefined {
  const host = service.host.trim()
  const port = service.port.trim()
  if (!host && !port) return undefined
  if (!host) return 'Falta o host.'
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return 'A porta é um número de 1 a 65535.'
  if (port === '80' || port === '443') return 'Porta 80 e 443 são HTTP: libere o domínio em Permissões → Rede.'
  if (LOOPBACK.test(host)) return 'localhost é porta local: libere em Permissões → Rede.'
  if (!TARGET.test(`${host}:${port}`)) return 'Host sem espaço, sem * e sem porta (a porta vai no campo ao lado).'
  return undefined
}

/** As regras do projeto com os serviços trocados pelos da tela; as outras regras ficam como estão. */
export function withServices(rules: readonly IPermissionRule[], services: readonly IProjectService[]): IPermissionRule[] {
  const others = rules.filter((rule) => !isServiceRule(rule))
  const seen = new Set<string>()
  const next = services
    .filter((service) => service.host.trim() && !serviceIssue(service))
    .map(ruleOf)
    .filter((rule) => !seen.has(rule.pattern) && !!seen.add(rule.pattern))
  return [...others, ...next]
}
