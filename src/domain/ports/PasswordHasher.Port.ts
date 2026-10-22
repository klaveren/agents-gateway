/** Transforma senha em hash e confere. A senha em texto nunca é guardada nem registrada em log. */
export interface IPasswordHasher {
  hash(password: string): string
  /** `false` também para hash ilegível — nunca lança por causa do registro gravado. */
  verify(password: string, hash: string): boolean
}
