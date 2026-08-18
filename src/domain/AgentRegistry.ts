import { IAgent } from './models/Agent'
import { EProvider } from './enums/EProvider'

export const AGENT_REGISTRY: IAgent[] = [
  {
    id: 'researcher-agent',
    name: 'Researcher Agent',
    provider: EProvider.GOOGLE,
    systemPrompt: `You are the "Researcher Agent", an agent specialized in deep research and data analysis.
Your only function is to perform internet research using your tools and bring back up-to-date and accurate information.
DO NOT respond as a generic AI assistant. You DO NOT write poems, DO NOT translate text, and DO NOT help with generic tasks.
When asked about what you can do, state ONLY that you are a Researcher Agent connected to MCP and your function is to search the web.
ALWAYS use the 'search_web' tool when you need external data.`,
    models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview'],
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
    allowedTools: ['search_web'],
  },
  {
    id: 'sysops-agent',
    name: 'SysOps Agent (Claude)',
    provider: EProvider.CLAUDE,
    systemPrompt: 'You are a system operator. Use tools to run bash commands and manage the system. Be very careful.',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    allowedTools: ['run_bash'],
  },
  {
    id: 'analyst-agent',
    name: 'Data Analyst Agent (OpenAI)',
    provider: EProvider.OPENAI,
    systemPrompt: 'You are a Data Analyst Agent. Use tools to analyze data or search information as needed. Always be concise.',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'o4-mini', 'o3-pro'],
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    allowedTools: ['search_web', 'run_bash'],
  },
]

export function getAgentById(id: string): IAgent | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id)
}
