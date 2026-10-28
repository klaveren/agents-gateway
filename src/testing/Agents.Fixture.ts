import { AgentCatalog } from '../application/Agent.Catalog'
import { EMode } from '../domain/enums/EMode.Enum'
import { EProvider } from '../domain/enums/EProvider.Enum'
import { IAgent } from '../domain/models/Agent.Model'
import { NullAgentRepository } from '../infra/persistence/Null.AgentRepository'

/**
 * Agentes de TESTE, um por protocolo oficial — dublês, não semente: a semente é só o Atlas (`Agent.Seed`).
 * Os testes de adapter, sessão e controller precisam de agentes com modelos, lanes e ferramentas diferentes
 * entre si; aqui eles nascem com nomes que não existem em produção.
 */
export const GOOGLE_TEST_AGENT: IAgent = {
  id: 'pesquisa-teste',
  name: 'Pesquisa (teste)',
  providers: [{ provider: EProvider.GOOGLE, models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview'] }],
  systemPrompt: 'Você pesquisa na web com search_web e responde com as fontes.',
  modes: [EMode.CHAT, EMode.AGENT],
  allowedTools: ['search_web'],
}

export const CLAUDE_TEST_AGENT: IAgent = {
  id: 'operador-teste',
  name: 'Operador (teste)',
  providers: [{ provider: EProvider.CLAUDE, models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'] }],
  systemPrompt: 'Você opera o sistema com run_bash, com cuidado.',
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  modes: [EMode.CHAT, EMode.AGENT],
  allowedTools: ['run_bash'],
}

export const OPENAI_TEST_AGENT: IAgent = {
  id: 'analista-teste',
  name: 'Analista (teste)',
  providers: [{ provider: EProvider.OPENAI, models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'o4-mini', 'o3-pro'] }],
  systemPrompt: 'Você analisa dados e responde de forma concisa.',
  reasoningEfforts: ['none', 'low', 'medium', 'high'],
  modes: [EMode.CHAT, EMode.AGENT],
  allowedTools: ['search_web', 'run_bash'],
}

export const TEST_AGENTS: readonly IAgent[] = [GOOGLE_TEST_AGENT, CLAUDE_TEST_AGENT, OPENAI_TEST_AGENT]

/** Os agentes de teste como diretório (`IAgentDirectory`), para quem monta o provider de sessões sem banco. */
export const TEST_AGENT_DIRECTORY = {
  list: (): IAgent[] => [...TEST_AGENTS],
  get: (id: string): IAgent | undefined => TEST_AGENTS.find((agent) => agent.id === id),
}

/** Um catálogo em memória já com os agentes de teste (e o que mais o teste passar). */
export function testAgentCatalog(
  usable?: ConstructorParameters<typeof AgentCatalog>[1],
  runnable?: ConstructorParameters<typeof AgentCatalog>[2],
  core?: ConstructorParameters<typeof AgentCatalog>[3],
): AgentCatalog {
  const repository = new NullAgentRepository()
  repository.seedOnce(TEST_AGENTS, 'teste')
  return new AgentCatalog(repository, usable, runnable, core)
}
