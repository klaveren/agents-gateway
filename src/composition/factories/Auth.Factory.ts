import { AccountsService } from '@application/Accounts.Service'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { CompositeCallerProof, LocalCallerProof } from '@infra/auth/Local.CallerProof'
import { ScryptPasswordHasher } from '@infra/auth/Scrypt.PasswordHasher'
import { ICallerProof, proofFromEnv } from '@infra/http/Caller.Proof'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { makeTools } from './Tools.Factory'

let instance: { accounts: AccountsService; proof: ICallerProof } | undefined

/**
 * As contas e a prova de quem chama.
 *
 * ⚠️ UMA INSTÂNCIA SÓ: a trava de força bruta mora na memória do serviço, e duas instâncias dariam
 * dez tentativas em vez de cinco.
 *
 * ⛔ SEM BANCO, SEM CONTAS. Com `CONVERSATIONS_DB=off` não há onde guardar conta, e contas em memória
 * reabririam o setup a cada restart — o primeiro a chegar viraria admin de novo. Fica só a prova
 * externa, como antes.
 */
export function makeAuth(): { accounts?: AccountsService; proof?: ICallerProof } {
  if (instance) return instance

  const external = proofFromEnv(makeTools().catalog)
  const configured = process.env.CONVERSATIONS_DB?.trim()
  if (configured === 'off') return { proof: external }

  const users = new SqliteUserRepository(configured || DEFAULT_DB_PATH)
  const tokens = new HmacTokenIssuer(process.env.AUTH_SECRET?.trim() || users.signingSecret())

  instance = {
    accounts: new AccountsService(users, new ScryptPasswordHasher(), tokens),
    proof: new CompositeCallerProof(new LocalCallerProof(tokens, users), external),
  }
  return instance
}
