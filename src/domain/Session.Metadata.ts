import { DELEGATED_BY, DELEGATED_FROM, DELEGATION_CHAIN, DELEGATION_DEPTH } from './models/Delegation.Model'

/**
 * As chaves da `metadata` que SÓ O SERVIDOR escreve: dono e delegação. Vindas do corpo, saem — com elas o
 * cliente se declararia dono de outro ou zeraria o limite de profundidade da delegação.
 */
/** ⛔ Só o servidor escreve: quem é o dono, a cadeia de delegação e o projeto da conversa (`PROJECT_METADATA_KEY`). */
export const PROJECT_METADATA_KEY = 'project'
export const RESERVED_METADATA_KEYS: readonly string[] = ['owner', DELEGATED_BY, DELEGATED_FROM, DELEGATION_DEPTH, DELEGATION_CHAIN, PROJECT_METADATA_KEY]

export const METADATA_MAX_KEYS = 32
export const METADATA_MAX_BYTES = 8 * 1024

export interface IMetadataIssue {
  field: string
  message: string
}

/**
 * A `metadata` que o CLIENTE declarou, limpa: sem as chaves reservadas e, para quem não é admin, sem as
 * chaves `protectedKeys` (as citadas num `{meta:…}` de egresso de contêiner — quem as define abre a rede).
 * ⛔ Teto de chaves e de tamanho: ela é gravada e devolvida em toda listagem.
 */
export function clientMetadata(
  declared: Record<string, unknown> | undefined,
  options: { admin: boolean; protectedKeys: readonly string[] },
): { metadata: Record<string, unknown>; issues: IMetadataIssue[] } {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (RESERVED_METADATA_KEYS.includes(key)) continue
    if (!options.admin && options.protectedKeys.includes(key)) continue
    metadata[key] = value
  }

  const issues: IMetadataIssue[] = []
  if (Object.keys(metadata).length > METADATA_MAX_KEYS) issues.push({ field: 'metadata', message: `at most ${METADATA_MAX_KEYS} keys` })
  if (Buffer.byteLength(JSON.stringify(metadata)) > METADATA_MAX_BYTES) issues.push({ field: 'metadata', message: `at most ${METADATA_MAX_BYTES} bytes` })
  return { metadata, issues }
}
