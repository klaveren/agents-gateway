import { SpeechFailedError, SpeechService, SpeechUnavailableError } from '@application/Speech.Service'
import type { PersonMessagesService } from '@application/PersonMessages.Service'
import { PERSON_MESSAGE_LEVELS } from '@domain/models/PersonMessage.Model'
import { speechText, VOICE_RATE, VOICE_VOICE_MAX } from '@domain/models/Speech.Model'
import { Request, Response } from 'express'
import { z } from 'zod'
import { ownerOf, resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface ISpeechControllerDeps {
  speech: SpeechService
  messages?: PersonMessagesService
  proof?: ICallerProof
}

/** `PUT /me/voice`: alteração parcial das preferências; `voice: null` volta à voz padrão. */
export const updateVoiceSchema = z.object({
  enabled: z.boolean().optional(),
  voice: z.string().trim().max(VOICE_VOICE_MAX).nullable().optional(),
  rate: z.number().min(VOICE_RATE.min).max(VOICE_RATE.max).optional(),
  minLevel: z.enum(PERSON_MESSAGE_LEVELS).optional(),
})

/**
 * 🔊 A VOZ (ver `Speech.Service`): as preferências de quem está logado e o áudio das mensagens que recebeu.
 * ⛔ O áudio de uma mensagem é só do destinatário (a mesma regra da caixa de entrada): de outra pessoa, 404.
 */
export class SpeechController {
  constructor(private readonly deps: ISpeechControllerDeps) {
    for (const name of ['messageSpeech', 'getVoice', 'putVoice', 'voiceSample'] as const) this[name] = this[name].bind(this)
  }

  /** `GET /messages/:conversationId/:messageId/speech` — o áudio da mensagem, com a voz de quem a recebeu. */
  async messageSpeech(req: Request, res: Response) {
    try {
      const userId = await this.userId()
      const message = this.deps.messages?.thread(userId, req.params.conversationId as string).find((item) => item.id === req.params.messageId)
      if (!message) throw new HttpError(404, 'not_found', 'Not found')
      this.audio(res, await this.run(() => this.deps.speech.speak(userId, speechText(message))))
    } catch (error: unknown) {
      this.failure(res, error)
    }
  }

  /** `GET /me/voice` — as preferências e o motor. */
  async getVoice(_req: Request, res: Response) {
    await this.json(res, async () => this.deps.speech.view(await this.userId()))
  }

  /** `PUT /me/voice` — salva (parcial) e devolve o mesmo que o GET. */
  async putVoice(req: Request, res: Response) {
    await this.json(res, async () => {
      const userId = await this.userId()
      return this.deps.speech.save(userId, parseBody(updateVoiceSchema, req.body))
    })
  }

  /** `GET /me/voice/sample` — a frase fixa, para testar a voz no Perfil. */
  async voiceSample(_req: Request, res: Response) {
    try {
      const userId = await this.userId()
      this.audio(res, await this.run(() => this.deps.speech.sample(userId)))
    } catch (error: unknown) {
      this.failure(res, error)
    }
  }

  /** Só quem tem conta: a voz é de uma pessoa (nem token anônimo, nem de integração sem dono). */
  private async userId(): Promise<string> {
    const resolved = await resolveCaller(this.deps.proof)
    if (!resolved) throw new HttpError(401, 'unauthorized', 'Sign in to use the voice')
    const id = ownerOf(resolved)?.id
    if (!id) throw new HttpError(401, 'unauthorized', 'Sign in to use the voice')
    return id
  }

  /** 409 sem motor; 502 quando o motor falha (a mensagem já vem sem a chave). */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      if (error instanceof SpeechUnavailableError) throw new HttpError(409, 'speech_unavailable', 'The voice has not been configured by the administrator')
      if (error instanceof SpeechFailedError) throw new HttpError(502, 'speech_failed', `The voice engine failed: ${error.message}`)
      throw error
    }
  }

  private audio(res: Response, audio: { data: Buffer; mime: string }): void {
    res
      .status(200)
      .set({ 'Content-Type': audio.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Length': String(audio.data.length) })
      .end(audio.data)
  }

  private async json<T>(res: Response, work: () => Promise<T>): Promise<void> {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      this.failure(res, error)
    }
  }

  private failure(res: Response, error: unknown): void {
    const failure = toHttpFailure(error)
    if (failure.status >= 500 && failure.status !== 502) console.error('[SpeechController] Error:', failure.message)
    res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
  }
}
