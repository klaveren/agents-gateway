import type { IConnectionChange } from '@/stores/connections'

const KIND: Record<string, string> = {
  project: 'Projeto',
  'project-permissions': 'Permissões',
  agent: 'Agente',
  skill: 'Skill',
  command: 'Comando',
  rule: 'Regra',
  spec: 'Spec',
  adr: 'ADR',
  knowledge: 'Doc',
  protocol: 'Protocolo',
  mcp: 'MCP',
}
const OP: Record<string, string> = { create: 'novo', update: 'alterado', delete: 'removido', import: 'importado', restore: 'restaurado', drift: 'ajustado', baseline: 'registrado' }

/** "Skill banco: alterado (3×)": a linha do aviso de atualização. */
export function changeLabel(change: IConnectionChange): string {
  return `${KIND[change.kind] ?? change.kind} ${change.id}: ${OP[change.op] ?? change.op}${change.revisions > 1 ? ` (${change.revisions}×)` : ''}`
}

/** A origem sem o `/v1` e o protocolo: o que a pessoa reconhece. */
export function originLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '').replace(/\/$/, '')
}
