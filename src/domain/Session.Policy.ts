import { EMode } from '@domain/enums/EMode.Enum'
import { ModeNotSupportedError, ToolsNotSupportedError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'

/**
 * Em que lane a sessão pode abrir.
 *
 * Estas duas são regras de negócio, não detalhe de adapter: um agente só roda nas lanes que
 * declara, e o loop de tools escrito à mão só existe na lane `chat` — na `agent` quem conduz
 * é o SDK, e ligar o nosso por cima seria pedir duas orquestrações para o mesmo turno.
 *
 * Moravam no `Agent.Provider`, em infra. O domínio ficava com a classe de erro e sem a
 * decisão.
 */
export function resolveSessionMode(agent: IAgent, input: ICreateSessionInput, lanes: readonly EMode[] = Object.values(EMode)): EMode {
  // Sem pedido, chat — ou a lane que o agente tem NESTE provider, quando não há chat (os de assinatura).
  const offered = agent.modes.filter((mode) => lanes.includes(mode))
  const mode = input.mode ?? (offered.includes(EMode.CHAT) ? EMode.CHAT : (offered[0] ?? agent.modes[0] ?? EMode.CHAT))

  if (!offered.includes(mode)) throw new ModeNotSupportedError(agent.id, mode)
  if (input.tools && mode !== EMode.CHAT) throw new ToolsNotSupportedError(mode)

  return mode
}
