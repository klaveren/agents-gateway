import { IPermissionVerdict } from './Permission.Policy'

/**
 * ⚖️ A CONTA LIBERADA ABRE A REDE PARA O SERVIDOR DELA (o GitHub, o host do Git HTTPS) sem regra `network`. Só onde nenhuma
 * regra decidiu (`default`): uma negação do agente ou do projeto, e as travas do sistema, seguem vencendo.
 * `hosts` vêm como `host:porta` (ver `commandEnv`).
 */
export function accountOpensHost(verdict: Pick<IPermissionVerdict, 'allowed' | 'layer'>, hosts: readonly string[] | undefined, host: string, port: number): boolean {
  return !verdict.allowed && verdict.layer === 'default' && !!hosts?.includes(`${host.toLowerCase()}:${port}`)
}
