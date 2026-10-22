/**
 * Como uma conversa foi classificada — para achar padrão sem ler tudo.
 *
 * ⚖️ São quatro porque cada uma manda para uma ação DIFERENTE, e é isso que justifica separá-las:
 *
 *  · `green` — uso normal. Nada a fazer.
 *  · `amber` — pediram algo legítimo que o produto não faz. A ação é de PRODUTO: ou a capacidade
 *              falta, ou a recusa foi confusa e a pessoa não entendeu o caminho.
 *  · `red`   — tentaram burlar a regra: prompt injection, extrair a instrução do agente, alcançar
 *              dado de outra conta. A ação é de SEGURANÇA, e é urgente.
 *  · `blue`  — TRABALHO DE QUEM OPERA: o agente não entregou algo que deveria conseguir, por tool
 *              incompleta, instrução fraca ou capacidade ausente. A ação é de ROADMAP.
 *
 * Um `amber` em massa vira decisão de produto; um `red` isolado vira investigação hoje.
 *
 * ⚖️ `amber` E `blue` SEPARAM RECUSA DE FALHA. A pergunta que as distingue é "de quem é o trabalho?":
 * em `amber` o sistema funcionou como desenhado e a decisão é se vale mudar o desenho; em `blue`
 * alguém saiu sem resposta e há o que consertar.
 */
export type TClassification = 'green' | 'amber' | 'red' | 'blue'

export const CLASSIFICATIONS: readonly TClassification[] = ['green', 'amber', 'red', 'blue']

/** Valor vindo de fora (query, coluna do banco) é uma classificação conhecida? */
export function isClassification(value: unknown): value is TClassification {
  return typeof value === 'string' && (CLASSIFICATIONS as readonly string[]).includes(value)
}

const SEVERITY: Record<TClassification, number> = { green: 0, blue: 1, amber: 2, red: 3 }

/**
 * A pior classificação vence quando se resume uma conversa inteira.
 *
 * ⚠️ NUNCA a mais recente nem a mais comum. Uma conversa com trinta turnos normais e um `red` é uma
 * conversa `red` — o sinal que importa é o pior que aconteceu ali, e mediar afogaria exatamente o
 * que se quer encontrar. Ausência e valor desconhecido são ignorados; sem nenhum válido, `undefined`.
 */
export function worstOf(values: readonly (TClassification | undefined)[]): TClassification | undefined {
  const known = values.filter(isClassification)
  if (!known.length) return undefined

  return known.reduce((worst, current) => (SEVERITY[current] > SEVERITY[worst] ? current : worst))
}
