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
export function resolveSessionMode(agent: IAgent, input: ICreateSessionInput): EMode {
  const mode = input.mode ?? EMode.CHAT

  if (!agent.modes.includes(mode)) throw new ModeNotSupportedError(agent.id, mode)
  if (input.tools && mode !== EMode.CHAT) throw new ToolsNotSupportedError(mode)

  return mode
}
