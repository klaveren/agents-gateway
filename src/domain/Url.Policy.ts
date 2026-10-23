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
  // 169.254.0.0/16 (link-local, onde mora o 169.254.169.254) e o fd00:ec2::254 da AWS em IPv6.
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^fe[89ab][0-9a-f]?:/.test(host) || host.startsWith('fd00:ec2')) return true
  // IPv4 mapeado em IPv6 (`::ffff:169.254.169.254`).
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  return !!mapped && /^169\.254\./.test(mapped[1])
}
