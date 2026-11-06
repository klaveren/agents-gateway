import { classifyAddress, isAlwaysBlockedKind } from './Address.Policy'

/**
 * ⛔ Os endereços de METADATA DE NUVEM (AWS, GCP, Azure, Alibaba, Oracle): de lá sai a credencial da
 * máquina. Nenhuma URL configurada (MCP, provider) aponta para eles — uma URL dessas é SSRF, não integração.
 */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', '100.100.100.200'])

export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (METADATA_HOSTS.has(host)) return true
  // IP literal em qualquer grafia (v4, v6, mapeado `::ffff:a9fe:a9fe`, 6to4…): pelo endereço lido em binário.
  return classifyAddress(host) === 'linklocal'
}

/**
 * ⛔ O host que NENHUM cadastro (nem de projeto) aponta: metadado, link-local, não especificado, loopback e `localhost`.
 * Vale no cadastro de endereço de aviso; a conexão confere de novo o endereço RESOLVIDO (ver `Guarded.Fetch`).
 */
export function isAlwaysBlockedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || isCloudMetadataHost(host)) return true
  return isAlwaysBlockedKind(classifyAddress(host))
}
