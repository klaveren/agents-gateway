import { TSelfApi } from './Self.Api'

/**
 * Uma conversa conduzida pelo PRÓPRIO gateway, em nome de uma conta: o que os hooks e os agendamentos fazem.
 *
 * ⚖️ PELA API, com uma sessão curta da conta: valem as mesmas regras de quem abre a conversa pela tela (agente só para
 * admin, audiência, teto de conversas, MCP `caller`), o `/command` é expandido no mesmo lugar, e a conversa aparece na
 * caixa de entrada dessa conta. Nada aqui reimplementa essas regras.
 */

/** A API recusou abrir a conversa: o mesmo status e a mesma mensagem voltam a quem pediu. */
export class SelfCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

/** Abre a conversa (`POST /sessions`) e devolve o id. `metadata` carimba a origem (o hook, o agendamento). */
export async function openConversation(api: TSelfApi, input: { agentId: string; projectId?: string; metadata: Record<string, unknown> }): Promise<string> {
  const created = await api('POST', '/sessions', { body: { agentId: input.agentId, ...(input.projectId ? { projectId: input.projectId } : {}), metadata: input.metadata } })
  const id = (created.result as { id?: string } | undefined)?.id
  if (!created.ok || !id) throw new SelfCallError(created.status || 500, created.code, created.message ?? 'Could not open the conversation')
  return id
}

/**
 * O turno, pelo stream da API: os headers chegam na hora, então um turno longo não estoura o prazo de
 * resposta do `fetch`. Devolve o erro do turno, ou `undefined` se terminou bem. A conversa cuja sessão expirou é
 * retomada pela própria API ao receber a mensagem.
 */
export async function runTurn(base: string, credentials: Record<string, string>, conversationId: string, message: string): Promise<string | undefined> {
  const response = await fetch(`${base}/sessions/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { ...credentials, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const text = await response.text()
  if (!response.ok) {
    const envelope = (() => {
      try {
        return JSON.parse(text) as { message?: string }
      } catch {
        return {}
      }
    })()
    return envelope.message ?? `HTTP ${response.status}`
  }
  // O último `error` do stream é o motivo; sem nenhum, o turno terminou bem.
  const errors = text
    .split('\n\n')
    .filter((frame) => /^event: error$/m.test(frame))
    .map((frame) => {
      const data = /^data: (.*)$/m.exec(frame)?.[1]
      try {
        return (JSON.parse(data ?? '{}') as { payload?: { message?: string } }).payload?.message ?? 'turn failed'
      } catch {
        return 'turn failed'
      }
    })
  return errors.at(-1)
}
