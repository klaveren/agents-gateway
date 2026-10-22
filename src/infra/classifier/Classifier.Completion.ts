import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { TComplete } from './Llm.TurnClassifier'

/**
 * De qual provider é um modelo.
 *
 * ⚖️ O REGISTRY MANDA: o agente que declara o modelo diz o provider, e é a mesma resposta que as
 * sessões usam. O prefixo do id só entra para o modelo que nenhum agente declara — e é o caso comum
 * do classificador, que quer um modelo MENOR do que os dos agentes. Id que não casa com nada devolve
 * `undefined` (classificador desligado), em vez de chutar um provider e falhar a cada turno.
 */
export function providerOfModel(model: string, agents = AGENT_REGISTRY): EProvider | undefined {
  const declared = agents.find((agent) => agent.models.includes(model))
  const protocol = Object.values(EProvider).find((value) => value === declared?.provider)
  if (protocol) return protocol

  const id = model.toLowerCase()
  if (id.startsWith('claude')) return EProvider.CLAUDE
  if (id.startsWith('gemini')) return EProvider.GOOGLE
  if (/^(gpt|o\d|chatgpt)/.test(id)) return EProvider.OPENAI

  return undefined
}

/** A chave que o provider exige, ou `undefined` se não estiver definida. */
export function apiKeyOf(provider: EProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = provider === EProvider.CLAUDE ? 'ANTHROPIC_API_KEY' : provider === EProvider.OPENAI ? 'OPENAI_API_KEY' : 'GOOGLE_API_KEY'

  return env[name]?.trim() || undefined
}

/**
 * A função `complete` de um modelo, sobre o SDK PLANO do provider — o mesmo das lanes `chat`.
 *
 * ⚠️ RACIOCÍNIO MÍNIMO ONDE O SDK PERMITE, e teto de saída com folga onde não permite:
 *  · Claude: sem o parâmetro `thinking` não há raciocínio.
 *  · GPT: `reasoning_effort: 'low'` nos modelos que raciocinam (o menor que todos aceitam).
 *  · Gemini: o `@google/generative-ai` 0.24 não tem controle de thinking; o teto de saída é quem
 *    garante que sobre texto depois do raciocínio (ver `CLASSIFIER_MAX_OUTPUT_TOKENS`).
 *
 * `temperature: 0` onde o modelo aceita (Gemini, GPT sem raciocínio): a mesma entrada deve dar o mesmo
 * rótulo. A Anthropic recusa o parâmetro nos modelos atuais.
 */
export function makeComplete(provider: EProvider, model: string, apiKey: string): TComplete {
  if (provider === EProvider.CLAUDE) {
    const client = new Anthropic({ apiKey })

    // Sem `temperature`: os modelos atuais da Anthropic recusam o parâmetro (400), e a saída já é
    // uma palavra entre quatro.
    return async (system, user, { maxOutputTokens }) => {
      const response = await client.messages.create({ model, system, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: user }] })

      return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    }
  }

  if (provider === EProvider.OPENAI) {
    const client = new OpenAI({ apiKey })
    const reasons = /^(o\d|gpt-5)/i.test(model)

    return async (system, user, { maxOutputTokens }) => {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: maxOutputTokens,
        // Modelos que raciocinam recusam `temperature`; os outros aceitam `reasoning_effort` não.
        ...(reasons ? { reasoning_effort: 'low' as const } : { temperature: 0 }),
      })

      return response.choices[0]?.message?.content ?? ''
    }
  }

  const client = new GoogleGenerativeAI(apiKey)

  return async (system, user, { maxOutputTokens }) => {
    const generative = client.getGenerativeModel({ model, systemInstruction: system })
    const result = await generative.generateContent({
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens },
    })

    return result.response.text()
  }
}
