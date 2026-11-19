import type { IPushSubscription } from '@domain/models/PushSubscription.Model'

/** Onde ficam as assinaturas de push e o par de chaves VAPID do gateway (ver `PushSubscription.Model`). */
export interface IPushSubscriptionRepository {
  /** Grava (ou renova) a assinatura do aparelho; o mesmo `endpoint` passa a ser da pessoa que assinou por último. */
  save(subscription: IPushSubscription): void
  remove(userId: string, endpoint: string): void
  /** O serviço de push disse que a assinatura acabou (404/410). */
  forget(endpoint: string): void
  of(userId: string): IPushSubscription[]
  /** 🔐 O par VAPID: a privada sai do banco só decifrada em memória. */
  vapid(): { publicKey: string; privateKey: string } | undefined
  setVapid(keys: { publicKey: string; privateKey: string }): void
}
