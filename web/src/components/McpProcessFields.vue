<script setup lang="ts">
  import { computed } from 'vue'
  import type { IMcpProcess } from '@/lib/types'

  /**
   * Os campos de um MCP que roda como processo do gateway. ⚠️ Sem trava nenhuma: o processo tem o usuário,
   * o disco e a rede do servidor — é escolha de quem administra.
   */
  const model = defineModel<IMcpProcess>({ required: true })
  defineProps<{ issues?: Record<string, string[]> }>()

  const args = computed({
    get: () => model.value.args.join('\n'),
    set: (text: string) =>
      (model.value = {
        ...model.value,
        args: text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
  })
  const env = computed({
    get: () => model.value.env.join(', '),
    set: (text: string) =>
      (model.value = {
        ...model.value,
        env: text
          .split(/[,\s]+/)
          .map((name) => name.trim().toUpperCase())
          .filter(Boolean),
      }),
  })

  /** O chromium da imagem do gateway (`/usr/bin/chromium`); sem `--no-sandbox` ele não sobe sem root no pod. */
  function playwright() {
    model.value = { package: '@playwright/mcp@latest', args: ['--headless', '--isolated', '--no-sandbox', '--executable-path=/usr/bin/chromium'], env: [], scope: 'conversation' }
  }
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <span class="min-w-0 flex-1">
        Roda
        <strong>direto no servidor</strong>
        , sem isolamento: quem usa o agente tem o mesmo acesso que o servidor.
      </span>
      <button type="button" class="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-zinc-100 hover:bg-zinc-700" @click="playwright">Preencher com Playwright</button>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="field">
        Pacote npm
        <input v-model="model.package" class="input font-mono" placeholder="@playwright/mcp@latest" />
        <small class="hint">Instalado pelo botão "Instalar". Em branco, usa só o comando.</small>
        <small v-for="m in issues?.package" :key="m" class="error">{{ m }}</small>
      </label>
      <label class="field">
        Comando
        <span class="hint">opcional</span>
        <input v-model="model.command" class="input font-mono" placeholder="comando do pacote" />
        <small class="hint">
          Com pacote: só se ele tiver vários comandos. Sem pacote: o comando a rodar (
          <code>npx</code>
          ,
          <code>uvx</code>
          , caminho absoluto).
        </small>
        <small v-for="m in issues?.command" :key="m" class="error">{{ m }}</small>
      </label>
    </div>
    <label class="field">
      Argumentos
      <span class="hint">um por linha</span>
      <textarea v-model="args" rows="4" class="input font-mono text-xs" placeholder="--headless" />
      <small class="hint">
        No Mac ou Windows, remova a linha
        <code>--executable-path=/usr/bin/chromium</code>
        para usar o Chrome instalado.
      </small>
      <small v-for="m in issues?.args" :key="m" class="error">{{ m }}</small>
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="field">
        Variáveis secretas
        <span class="hint">só os nomes — os valores você coloca depois de salvar</span>
        <input v-model="env" class="input font-mono text-xs" placeholder="API_TOKEN" />
        <small v-for="m in issues?.env" :key="m" class="error">{{ m }}</small>
      </label>
      <div class="field">
        Execução
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="chip" :class="{ on: model.scope === 'conversation' }" @click="model = { ...model, scope: 'conversation' }">Uma por conversa</button>
          <button type="button" class="chip" :class="{ on: model.scope === 'shared' }" @click="model = { ...model, scope: 'shared' }">Compartilhada</button>
        </div>
        <small class="hint">
          {{
            model.scope === 'conversation'
              ? 'Cada conversa tem a sua, separada.'
              : 'Uma só para todas: o que uma faz aparece para as outras.'
          }}
        </small>
      </div>
    </div>
  </div>
</template>

<style scoped>
  @reference '../style.css';

  .field {
    @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
  }
  .input {
    @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
  }
  .hint {
    @apply text-xs font-normal text-zinc-500;
  }
  .error {
    @apply text-xs font-normal text-rose-300;
  }
  .chip {
    @apply rounded-full border border-zinc-700 px-3 py-1 text-sm font-normal text-zinc-300 hover:bg-zinc-800;
  }
  .chip.on {
    @apply border-emerald-500/60 bg-emerald-500/15 text-emerald-200;
  }
</style>
