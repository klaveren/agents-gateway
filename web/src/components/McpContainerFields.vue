<script setup lang="ts">
import { computed } from 'vue'
import type { IMcpContainer } from '@/lib/types'

/**
 * Os campos de um MCP em contêiner isolado. ⛔ As travas (disco só leitura, sem privilégios, sem volumes,
 * sem portas, sem a rede do servidor, um contêiner por conversa) não aparecem: não são opção.
 */
const model = defineModel<IMcpContainer>({ required: true })
defineProps<{ issues?: Record<string, string[]> }>()

const lines = (key: 'args' | 'writable' | 'allowedHosts') =>
  computed({
    get: () => model.value[key].join('\n'),
    set: (text: string) => (model.value = { ...model.value, [key]: text.split('\n').map((line) => line.trim()).filter(Boolean) }),
  })
const args = lines('args')
const writable = lines('writable')
const hosts = lines('allowedHosts')
const env = computed({
  get: () => model.value.env.join(', '),
  set: (text: string) => (model.value = { ...model.value, env: text.split(/[,\s]+/).map((name) => name.trim().toUpperCase()).filter(Boolean) }),
})

function playwright() {
  model.value = { image: 'mcr.microsoft.com/playwright/mcp:latest', args: ['--isolated', '--proxy-server={proxy}'], writable: ['/home/node'], memoryMb: 1024, cpus: 1, network: 'allowlist', allowedHosts: ['{meta:siteDomain}'], env: [] }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
      <span class="min-w-0 flex-1">Cada conversa ganha o <strong>seu</strong> contêiner: sem acesso ao disco, às chaves nem à rede deste servidor, e com saída só para os domínios listados.</span>
      <button type="button" class="shrink-0 rounded-full bg-zinc-800 px-3 py-1 text-zinc-100 hover:bg-zinc-700" @click="playwright">Modelo: Playwright</button>
    </div>
    <label class="field">
      Imagem
      <input v-model="model.image" required class="input font-mono" placeholder="mcr.microsoft.com/playwright/mcp:latest" />
      <small v-for="m in issues?.image" :key="m" class="error">{{ m }}</small>
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="field">
        Argumentos <span class="hint">um por linha; <code>{proxy}</code> = o proxy de saída</span>
        <textarea v-model="args" rows="3" class="input font-mono text-xs" placeholder="--isolated" />
      </label>
      <label class="field">
        Pastas graváveis <span class="hint">em memória; o resto é só leitura</span>
        <textarea v-model="writable" rows="3" class="input font-mono text-xs" placeholder="/home/node" />
        <small v-for="m in issues?.writable" :key="m" class="error">{{ m }}</small>
      </label>
    </div>
    <div class="field">
      Rede
      <div class="flex flex-wrap gap-1.5">
        <button type="button" class="chip" :class="{ on: model.network === 'none' }" @click="model = { ...model, network: 'none' }">Sem rede</button>
        <button type="button" class="chip" :class="{ on: model.network === 'allowlist' }" @click="model = { ...model, network: 'allowlist' }">Só estes domínios</button>
      </div>
    </div>
    <label v-if="model.network === 'allowlist'" class="field">
      Domínios permitidos <span class="hint">um por linha, com subdomínios; <code>{meta:siteDomain}</code> = o domínio gravado no metadata da conversa (um por cliente)</span>
      <textarea v-model="hosts" rows="3" class="input font-mono text-xs" placeholder="{meta:siteDomain}" />
      <small v-for="m in issues?.allowedHosts" :key="m" class="error">{{ m }}</small>
    </label>
    <div class="grid gap-3 sm:grid-cols-3">
      <label class="field">Variáveis secretas <span class="hint">nomes; o valor vai depois</span><input v-model="env" class="input font-mono text-xs" placeholder="API_TOKEN" /></label>
      <label class="field">Memória (MB)<input v-model.number="model.memoryMb" type="number" min="128" max="4096" class="input" /></label>
      <label class="field">CPUs<input v-model.number="model.cpus" type="number" min="0.25" max="4" step="0.25" class="input" /></label>
    </div>
    <small v-for="m in [...(issues?.memoryMb ?? []), ...(issues?.cpus ?? []), ...(issues?.env ?? []), ...(issues?.args ?? [])]" :key="m" class="error">{{ m }}</small>
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
