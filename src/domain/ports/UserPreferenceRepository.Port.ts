/** Onde as preferências de cada pessoa ficam: chave a chave, o valor em JSON (a tela dela, não do sistema). */
export interface IUserPreferenceRepository {
  /** O valor gravado (JSON em texto), ou ausente. */
  get(userId: string, key: string): string | undefined
  set(userId: string, key: string, value: string, at: Date): void
  remove(userId: string, key: string): void
}
