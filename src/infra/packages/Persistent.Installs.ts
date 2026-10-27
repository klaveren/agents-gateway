import { delimiter, join } from 'node:path'
import { dataDir, INSTALL_PASSTHROUGH } from '@infra/adapters/support/Subscription.Workspace'
import { toolsPrefix } from './Micromamba.Adapter'

type TInstallVar = (typeof INSTALL_PASSTHROUGH)[number]

/**
 * Onde cada gerenciador instala, no PVC: `<dados>/tools/<gerenciador>` (e o cache em `<dados>/cache`).
 * ⚖️ Um destino POR GERENCIADOR, e não o HOME inteiro no PVC: com HOME compartilhado, histórico,
 * configuração e credenciais de uma conversa apareceriam na outra. Só o que foi instalado é compartilhado.
 */
export function persistentInstallEnv(env: NodeJS.ProcessEnv = process.env): { vars: Record<TInstallVar, string>; bins: string[] } {
  const tools = toolsPrefix(env)
  const cache = join(dataDir(env), 'cache')
  const vars: Record<TInstallVar, string> = {
    NPM_CONFIG_PREFIX: join(tools, 'npm'),
    npm_config_cache: join(cache, 'npm'),
    PYTHONUSERBASE: join(tools, 'python'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    UV_TOOL_DIR: join(tools, 'uv', 'tools'),
    UV_TOOL_BIN_DIR: join(tools, 'uv', 'bin'),
    UV_PYTHON_INSTALL_DIR: join(tools, 'uv', 'python'),
    UV_CACHE_DIR: join(cache, 'uv'),
    PIPX_HOME: join(tools, 'pipx'),
    PIPX_BIN_DIR: join(tools, 'pipx', 'bin'),
    CARGO_HOME: join(tools, 'cargo'),
    RUSTUP_HOME: join(tools, 'rustup'),
    GOPATH: join(tools, 'go'),
    GOCACHE: join(cache, 'go'),
    GEM_HOME: join(tools, 'gem'),
  }
  // A ordem é a da busca: o que a guia Pacotes instalou primeiro, depois o global de cada gerenciador.
  const bins = [
    join(tools, 'bin'),
    join(vars.NPM_CONFIG_PREFIX, 'bin'),
    join(vars.PYTHONUSERBASE, 'bin'),
    vars.UV_TOOL_BIN_DIR,
    vars.PIPX_BIN_DIR,
    join(vars.CARGO_HOME, 'bin'),
    join(vars.GOPATH, 'bin'),
    join(vars.GEM_HOME, 'bin'),
  ]
  return { vars, bins }
}

/**
 * ⚖️ NO BOOT, NO AMBIENTE DO PRÓPRIO GATEWAY: o `run_bash`, os clientes de assinatura, o Bash do SDK e os
 * MCPs `process` derivam o ambiente deste processo — `npm i -g`, `pip install --user`, `uv tool install`,
 * `cargo install`, `go install` e `gem install` passam a gravar no PVC e a achar o que instalaram, sem que
 * ninguém precise saber disso. Variável já definida (por quem opera) vale mais que a nossa.
 */
export function persistInstalls(env: NodeJS.ProcessEnv = process.env): void {
  const { vars, bins } = persistentInstallEnv(env)
  for (const [name, value] of Object.entries(vars)) env[name] ??= value
  const parts = (env.PATH ?? '').split(delimiter).filter(Boolean)
  env.PATH = [...bins.filter((bin) => !parts.includes(bin)), ...parts].join(delimiter)
}
