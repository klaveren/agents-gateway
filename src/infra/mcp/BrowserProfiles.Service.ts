import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'

/** De quem é o navegador de uma conversa: o agente, o projeto dela e se o agente guarda o login. */
export interface IBrowserProfileOwner {
  agentId: string
  projectId?: string
  keepLogin: boolean
}

/**
 * A pasta do perfil que um navegador usa. `temp`: a de sempre (quem pediu a apaga); `fixed`: o perfil guardado do agente
 * no projeto; `copy`: uma cópia dele (o guardado já estava em uso), apagada ao largar.
 */
export interface IBrowserProfile {
  userDataDir: string
  kind: 'temp' | 'fixed' | 'copy'
  /** Larga o perfil: solta o guardado ou apaga a cópia. Pode ser chamado mais de uma vez. */
  release(): void
}

export interface IBrowserProfilesOptions {
  /** Onde moram os perfis guardados. Padrão: `<dados>/browser-profiles`. */
  root?: () => string
  /** Onde nascem as cópias. Padrão: o tmpdir. */
  tmp?: () => string
}

/** O nome da pasta: só letras, números, `-` e `_` (o id nunca sai da pasta dos perfis). */
const safe = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || '_'

/** As travas e a porta de depuração de um Chromium que já fechou: sem apagar, o próximo não abre (ou lê a porta velha). */
const STALE = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']

/** O que a cópia não leva: caches (grandes, refeitos sozinhos) e as travas do Chromium que está aberto. */
const NOT_COPIED = new Set([
  ...STALE,
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'CacheStorage',
  'ScriptCache',
  'component_crx_cache',
  'Crashpad',
])

/**
 * 🌐 OS PERFIS GUARDADOS DO NAVEGADOR: um por agente e por projeto (`<dados>/browser-profiles/<agente>/<projeto|_>`, 0700),
 * para o login feito numa conversa valer nas próximas. Só para o agente que liga `browser.keepLogin`; os demais seguem
 * com o perfil temporário de cada conversa.
 *
 * ⛔ A pasta fica nos dados do gateway: o cerco do agente não lê `dataDir` e a regra de instalação nega ler e escrever
 * nela (ver `installationRules`). ⚠️ Os cookies guardados valem como login (no Linux, sem chaveiro, quase em claro).
 *
 * ⚖️ O Chromium não abre o mesmo perfil duas vezes: a segunda conversa do mesmo agente no mesmo projeto ganha uma CÓPIA
 * temporária (sem caches), apagada ao fechar — o login dela não volta para o guardado.
 */
export class BrowserProfiles {
  private readonly busy = new Set<string>()
  private owner: (sessionId: string) => IBrowserProfileOwner | undefined = () => undefined

  constructor(private readonly options: IBrowserProfilesOptions = {}) {}

  /** De quem é cada conversa (agente, projeto, `keepLogin`). Ligado na composição; ausente, todo perfil é temporário. */
  useOwner(owner: (sessionId: string) => IBrowserProfileOwner | undefined): void {
    this.owner = owner
  }

  private root(): string {
    return this.options.root?.() ?? join(dataDir(), 'browser-profiles')
  }

  /** A pasta do perfil guardado do agente no projeto (`undefined` = conversa sem projeto). */
  dirOf(agentId: string, projectId?: string): string {
    return join(this.root(), safe(agentId), projectId ? safe(projectId) : '_')
  }

  /**
   * O perfil para o navegador desta conversa. `temp`: a pasta temporária que o chamador usaria sem perfil guardado.
   * `known`: o dono já lido pelo chamador (a rota da tela lê do gravado; a conversa pode não estar viva na memória).
   */
  acquire(sessionId: string, temp: string, known?: IBrowserProfileOwner): IBrowserProfile {
    let owner = known
    try {
      owner ??= this.owner(sessionId)
    } catch {
      owner = undefined
    }
    if (!owner?.keepLogin) return { userDataDir: temp, kind: 'temp', release: () => undefined }
    const fixed = this.dirOf(owner.agentId, owner.projectId)
    if (!this.busy.has(fixed)) {
      this.prepare(fixed)
      this.busy.add(fixed)
      let held = true
      return {
        userDataDir: fixed,
        kind: 'fixed',
        release: () => {
          if (held) this.busy.delete(fixed)
          held = false
        },
      }
    }
    const copy = mkdtempSync(join(this.options.tmp?.() ?? tmpdir(), 'gw-browser-copy-'))
    try {
      cpSync(fixed, copy, { recursive: true, force: true, filter: (source) => !NOT_COPIED.has(basename(source)) })
    } catch (error: unknown) {
      // O Chromium aberto grava enquanto copiamos: o que não deu para copiar fica de fora (a cópia segue, talvez sem login).
      console.warn('[BrowserProfiles] the profile copy is incomplete:', error instanceof Error ? error.message : error)
    }
    chmodSync(copy, 0o700)
    return { userDataDir: copy, kind: 'copy', release: () => rmSync(copy, { recursive: true, force: true }) }
  }

  /** A pasta existe com 0700 (e a raiz também) e sem as travas do Chromium que fechou (este processo é o único que abre). */
  private prepare(dir: string): void {
    const root = this.root()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    for (const name of STALE) rmSync(join(dir, name), { force: true })
  }

  /** Algum perfil guardado do agente (no projeto, ou em qualquer um) está aberto agora. */
  inUse(agentId: string, projectId?: string | null): boolean {
    const target = projectId === null ? join(this.root(), safe(agentId)) : this.dirOf(agentId, projectId)
    return [...this.busy].some((dir) => dir === target || dir.startsWith(target + sep))
  }

  /**
   * Apaga as sessões guardadas do agente: as do projeto (`undefined` = conversas sem projeto) ou, com `null`, as de todos.
   * Devolve `false` com o perfil aberto (o chamador recusa); `true` apagou (ou não havia nada).
   */
  clear(agentId: string, projectId?: string | null): boolean {
    if (this.inUse(agentId, projectId)) return false
    const target = projectId === null ? join(this.root(), safe(agentId)) : this.dirOf(agentId, projectId)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    return true
  }
}

let shared: BrowserProfiles | undefined

/** Os perfis do processo: o MCP do agente e o navegador da pessoa dividem a mesma trava. */
export function browserProfiles(): BrowserProfiles {
  return (shared ??= new BrowserProfiles())
}
