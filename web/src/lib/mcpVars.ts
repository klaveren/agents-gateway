import type { IMcpProcess } from './types'

/** O tipo de uma variável do MCP: a fixa (valor no MCP), a do projeto (valor visível) e a secreta do projeto. */
export type TMcpVarKind = 'fixed' | 'project' | 'secret'

export const MCP_VAR_KIND_LABEL: Record<TMcpVarKind, string> = { fixed: 'Fixa', project: 'Do projeto', secret: 'Secreta do projeto' }

/** Uma linha da lista de variáveis na tela. O `value` só vale na fixa. */
export interface IMcpVarRow {
  name: string
  kind: TMcpVarKind
  value: string
}

export type TMcpVars = Pick<IMcpProcess, 'vars' | 'projectVars' | 'env'>

/** As linhas do que está no cadastro: fixas, do projeto e secretas, nessa ordem. */
export function mcpVarRows(model: TMcpVars): IMcpVarRow[] {
  return [
    ...Object.entries(model.vars ?? {}).map(([name, value]) => ({ name, kind: 'fixed' as const, value })),
    ...(model.projectVars ?? []).map((name) => ({ name, kind: 'project' as const, value: '' })),
    ...model.env.map((name) => ({ name, kind: 'secret' as const, value: '' })),
  ]
}

/**
 * O cadastro a partir das linhas: o nome em maiúsculas, a linha sem nome fica de fora. ⚖️ Trocar o tipo de uma linha nunca
 * revela segredo: o MCP não guarda valor secreto, e a fixa nasce com o que se digitar aqui.
 */
export function mcpVarsOf(rows: readonly IMcpVarRow[]): TMcpVars {
  const named = rows.map((row) => ({ ...row, name: row.name.trim().toUpperCase() })).filter((row) => row.name)
  const vars = Object.fromEntries(named.filter((row) => row.kind === 'fixed').map((row) => [row.name, row.value]))
  const projectVars = named.filter((row) => row.kind === 'project').map((row) => row.name)
  return {
    ...(Object.keys(vars).length ? { vars } : {}),
    ...(projectVars.length ? { projectVars } : {}),
    env: named.filter((row) => row.kind === 'secret').map((row) => row.name),
  }
}
