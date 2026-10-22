import { setTracingDisabled } from '@openai/agents'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { ClaudeAgentAdapter } from '@infra/adapters/ClaudeAgent.Adapter'
import { ClaudeChatAdapter } from '@infra/adapters/ClaudeChat.Adapter'
import { GoogleAgentAdapter } from '@infra/adapters/GoogleAgent.Adapter'
import { GoogleChatAdapter } from '@infra/adapters/GoogleChat.Adapter'
import { OpenAIAgentAdapter } from '@infra/adapters/OpenAIAgent.Adapter'
import { OpenAIChatAdapter } from '@infra/adapters/OpenAIChat.Adapter'
import { adapterKey, AgentProvider } from '@infra/providers/Agent.Provider'
import { SessionStore } from '@infra/session/Session.Store'
import { makeAgents } from './Agents.Factory'
import { makeProviders } from './Providers.Factory'
import { makeSettings } from './Settings.Factory'
import { makeTools } from './Tools.Factory'

let store: SessionStore | undefined

/**
 * Um store para todo o gateway. É ele que sabe de que agente e de que lane é cada sessão,
 * e por isso `sendMessage` e `cancel` precisam só do id.
 */
export function makeSessionStore(): SessionStore {
  store ??= new SessionStore()
  return store
}

/**
 * Monta as duas lanes: `chat` sobre os SDKs normais, `agent` sobre os Agents SDKs.
 *
 * Cada provider aparece duas vezes no mapa, uma por lane — é essa a comparação que o
 * projeto existe para fazer.
 */
export function makeOrchestrator(): AgentProvider {
  // Importar o @openai/agents já registra o exportador de tracing da OpenAI, que manda
  // prompts e resultados de tool para api.openai.com usando a OPENAI_API_KEY. Num gateway
  // local isso é vazamento, não telemetria.
  setTracingDisabled(true)

  const { catalog } = makeTools()
  const sessions = makeSessionStore()
  // O MESMO diretório da tela de Providers: chave e URL salvas lá valem na próxima chamada de qualquer lane.
  const connections = makeProviders()

  const adapters = new Map<string, IAgentAdapter>([
    [adapterKey(EProvider.CLAUDE, EMode.CHAT), new ClaudeChatAdapter({ store: sessions, catalog, connections })],
    [adapterKey(EProvider.OPENAI, EMode.CHAT), new OpenAIChatAdapter({ store: sessions, catalog, connections })],
    [adapterKey(EProvider.GOOGLE, EMode.CHAT), new GoogleChatAdapter({ store: sessions, catalog, connections })],
    [adapterKey(EProvider.CLAUDE, EMode.AGENT), new ClaudeAgentAdapter({ store: sessions, catalog, connections })],
    [adapterKey(EProvider.OPENAI, EMode.AGENT), new OpenAIAgentAdapter({ store: sessions, catalog, connections })],
    [adapterKey(EProvider.GOOGLE, EMode.AGENT), new GoogleAgentAdapter({ store: sessions, catalog, connections })],
  ])

  /**
   * A MESMA instância que o controller recebe (ver `makeSettings`): a tela salva num repositório e o
   * provider escuta o mesmo, e é isso que faz a mudança valer no instante em que é gravada.
   */
  return new AgentProvider(adapters, sessions, makeSettings(), makeAgents(), connections)
}
