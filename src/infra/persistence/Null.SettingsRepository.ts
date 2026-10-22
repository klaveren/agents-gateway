import { DEFAULT_SETTINGS, IAgentSettings } from '@domain/models/Settings.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'

/**
 * Configurações que não persistem — o que vale enquanto não há banco plugado.
 *
 * ⚠️ Guarda em MEMÓRIA, e não é o mesmo que ignorar: quem salva vê o efeito enquanto o processo
 * viver. Some no restart, o que é honesto para uma instalação sem banco, e evita que configurar
 * pareça quebrado em desenvolvimento.
 *
 * ⚖️ É por causa desta classe que o resto do sistema pode assumir que sempre há configuração.
 * Sem ela, cada ponto de leitura precisaria tratar "não há repositório" — e é aí que nasce um
 * default diferente em cada lugar.
 */
export class NullSettingsRepository implements ISettingsRepository {
  private readonly listeners: Array<(settings: IAgentSettings) => void> = []

  /** Estado inicial injetável: o teste declara a configuração que pressupõe, sem esperar um save. */
  constructor(private value: IAgentSettings = DEFAULT_SETTINGS) {}

  async read(): Promise<IAgentSettings> {
    return this.value
  }

  async save(settings: IAgentSettings): Promise<void> {
    this.value = { ...settings, updatedAt: new Date() }
    for (const listener of this.listeners) listener(this.value)
  }

  subscribe(listener: (settings: IAgentSettings) => void): void {
    this.listeners.push(listener)
  }
}
