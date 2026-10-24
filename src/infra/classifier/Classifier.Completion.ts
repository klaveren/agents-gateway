import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import OpenAI from 'openai'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { TComplete } from './Llm.TurnClassifier'

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
export function makeComplete(provider: EProvider, model: string, apiKey: string, baseUrl?: string): TComplete {
  if (provider === EProvider.CLAUDE) {
    const client = new Anthropic({ apiKey, baseURL: baseUrl })

    // Sem `temperature`: os modelos atuais da Anthropic recusam o parâmetro (400), e a saída já é
    // uma palavra entre quatro.
    return async (system, user, { maxOutputTokens }) => {
      const response = await client.messages.create({ model, system, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: user }] })

      return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    }
  }

  if (provider === EProvider.OPENAI) {
    const client = new OpenAI({ apiKey, baseURL: baseUrl })
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
