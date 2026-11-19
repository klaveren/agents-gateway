import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqlitePushSubscriptionRepository } from '@infra/persistence/Sqlite.PushSubscriptionRepository'
import { WebPushSender } from '@infra/push/WebPush.Sender'
import { makeSecretBox } from './Credentials.Factory'

let instance: WebPushSender | undefined

/**
 * 📱 O Web Push do gateway (ver `WebPush.Sender`). O `subject` do VAPID é o contato que os serviços de push (Apple,
 * Google) usam se precisarem falar com quem manda: `PUSH_SUBJECT` (`mailto:` ou `https:`), senão um endereço genérico.
 */
export function makePush(): WebPushSender {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const path = configured === 'off' || configured === ':memory:' ? ':memory:' : configured || DEFAULT_DB_PATH
  const subject = process.env.PUSH_SUBJECT?.trim()
  instance = new WebPushSender(
    new SqlitePushSubscriptionRepository(makeSecretBox(), path),
    subject && /^(mailto:|https:)/.test(subject) ? subject : 'mailto:push@agents-gateway.invalid',
  )
  return instance
}
