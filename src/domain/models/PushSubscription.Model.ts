/**
 * 📱 A ASSINATURA DE PUSH de um aparelho (Web Push, RFC 8030): o navegador dá o `endpoint` (o serviço de push dele —
 * Apple, Google, Mozilla) e as chaves com que a mensagem é cifrada. O gateway só manda para lá o aviso de mensagem nova
 * (assunto e começo do texto); o conteúdo fica na tela.
 */
export interface IPushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  userId: string
  /** O aparelho, como o navegador se apresenta (para a pessoa saber qual desligar). */
  label?: string
  createdAt: Date
}

/** O aviso que vai para o aparelho. */
export interface IPushNotice {
  title: string
  body: string
  /** Onde o toque leva (dentro do gateway). */
  url: string
  /** Avisos do mesmo fio se substituem no aparelho em vez de empilhar. */
  tag: string
}

export const PUSH_LIMITS = { endpoint: 2048, key: 256, label: 160, perUser: 20, body: 180 } as const
