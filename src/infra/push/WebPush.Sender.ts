import { createECDH } from 'node:crypto'
import webpush from 'web-push'
import { IPushNotice, IPushSubscription, PUSH_LIMITS } from '@domain/models/PushSubscription.Model'
import type { IPushSubscriptionRepository } from '@domain/ports/PushSubscriptionRepository.Port'

/** O envio de fato (trocável nos testes). */
export type TPushSend = (
  subscription: Pick<IPushSubscription, 'endpoint' | 'keys'>,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
) => Promise<void>

const sendWithWebPush: TPushSend = async (subscription, payload, vapid) => {
  await webpush.sendNotification(subscription, payload, { vapidDetails: vapid, TTL: 60 * 60 * 24, urgency: 'high' })
}

/**
 * 📱 WEB PUSH: o aviso de mensagem nova chega no celular (o PWA instalado) e no navegador de quem ligou "Receber no
 * aparelho". O par VAPID nasce no primeiro uso e fica no banco (a privada cifrada); a pública vai para a tela assinar.
 * ⛔ Só o aviso sai do gateway (assunto e começo do texto, cifrados para o aparelho): o fio inteiro fica na tela.
 * Assinatura que o serviço de push dá como acabada (404/410) é apagada; qualquer outra falha não derruba quem mandou.
 */
export class WebPushSender {
  constructor(
    private readonly repository: IPushSubscriptionRepository,
    /** O contato do ambiente (`PUSH_SUBJECT`), usado quando a tela não definiu um. */
    private readonly fallbackSubject: string,
    private readonly send: TPushSend = sendWithWebPush,
  ) {}

  publicKey(): string {
    return this.keys().publicKey
  }

  subscribe(userId: string, input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }, label?: string): void {
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint : ''
    const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh : ''
    const auth = typeof input.keys?.auth === 'string' ? input.keys.auth : ''
    // ⛔ Só um serviço de push de verdade (https), nunca um endereço da rede interna que o gateway sairia chamando.
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new PushError('endpoint must be an https URL')
    }
    if (url.protocol !== 'https:' || endpoint.length > PUSH_LIMITS.endpoint || !isPushService(url.hostname)) throw new PushError('endpoint is not a known push service')
    if (!p256dh || !auth || p256dh.length > PUSH_LIMITS.key || auth.length > PUSH_LIMITS.key) throw new PushError('keys.p256dh and keys.auth are required')
    const mine = this.repository.of(userId)
    if (mine.length >= PUSH_LIMITS.perUser && !mine.some((item) => item.endpoint === endpoint)) this.repository.remove(userId, mine[0].endpoint)
    this.repository.save({ endpoint, keys: { p256dh, auth }, userId, ...(label ? { label: label.slice(0, PUSH_LIMITS.label) } : {}), createdAt: new Date() })
  }

  unsubscribe(userId: string, endpoint: string): void {
    this.repository.remove(userId, endpoint)
  }

  devices(userId: string): number {
    return this.repository.of(userId).length
  }

  /** Manda o aviso para todos os aparelhos da pessoa, sem esperar nem falhar quem chamou. */
  notify(userId: string, notice: IPushNotice): Promise<void> {
    const subscriptions = this.repository.of(userId)
    if (!subscriptions.length) return Promise.resolve()
    const body = notice.body.replace(/\s+/g, ' ').trim()
    const payload = JSON.stringify({ ...notice, body: body.length > PUSH_LIMITS.body ? `${body.slice(0, PUSH_LIMITS.body - 1)}…` : body })
    const vapid = { subject: this.subject(), ...this.keys() }
    return Promise.all(
      subscriptions.map((subscription) =>
        this.send(subscription, payload, vapid).catch((error: unknown) => {
          const status = (error as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) this.repository.forget(subscription.endpoint)
        }),
      ),
    ).then(() => undefined)
  }

  /** 🔐 O que a tela de Configurações mostra: a pública, o contato e quantos aparelhos recebem. A privada nunca sai. */
  config(): { publicKey: string; contact: string; custom: boolean; devices: number } {
    const custom = this.repository.contact()
    return { publicKey: this.publicKey(), contact: custom ?? this.fallbackSubject, custom: !!custom, devices: this.repository.count() }
  }

  /** O contato: um e-mail (vira `mailto:`) ou um endereço `https:`; vazio = o do ambiente. */
  setContact(contact: string | undefined): void {
    const value = contact?.trim()
    if (!value) return this.repository.setContact(undefined)
    const normalized = /^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : value
    if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && !/^https:\/\/[^\s]+$/.test(normalized)) throw new PushError('contact must be an e-mail or an https:// address')
    this.repository.setContact(normalized.slice(0, 320))
  }

  /**
   * 🔐 Usa um par VAPID trazido de fora (o mesmo de outra instalação, por exemplo). Confere que a privada gera a
   * pública. Trocar o par invalida as assinaturas: os aparelhos precisam religar o aviso.
   */
  importKeys(publicKey: string, privateKey: string): void {
    const pub = publicKey.trim()
    const priv = privateKey.trim()
    let derived: string
    try {
      const ecdh = createECDH('prime256v1')
      ecdh.setPrivateKey(Buffer.from(priv, 'base64url'))
      derived = ecdh.getPublicKey().toString('base64url')
    } catch {
      throw new PushError('privateKey is not a P-256 VAPID private key (base64url)')
    }
    if (Buffer.from(priv, 'base64url').length !== 32) throw new PushError('privateKey is not a P-256 VAPID private key (base64url)')
    if (derived !== Buffer.from(pub, 'base64url').toString('base64url')) throw new PushError('publicKey does not match privateKey')
    this.repository.setVapid({ publicKey: derived, privateKey: priv })
    this.repository.clear()
  }

  /** 🔐 Gera um par novo (se o antigo vazou). Os aparelhos precisam religar o aviso. */
  rotate(): void {
    this.repository.setVapid(webpush.generateVAPIDKeys())
    this.repository.clear()
  }

  private subject(): string {
    return this.repository.contact() ?? this.fallbackSubject
  }

  private keys(): { publicKey: string; privateKey: string } {
    const stored = this.repository.vapid()
    if (stored) return stored
    const created = webpush.generateVAPIDKeys()
    this.repository.setVapid(created)
    return created
  }
}

export class PushError extends Error {}

/** Os serviços de push dos navegadores (Apple, Google/Chrome/Edge, Mozilla, Microsoft). */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
]
function isPushService(host: string): boolean {
  return PUSH_HOSTS.some((pattern) => pattern.test(host))
}
