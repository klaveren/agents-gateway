<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import { ApiError } from '@/lib/api'
import type { IPackageHit } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { usePackagesStore } from '@/stores/packages'

/**
 * A guia Pacotes: ferramentas do servidor (git, curl, jq…) do conda-forge, instaladas pelo micromamba numa
 * pasta persistente que está no PATH do gateway — o Bash dos agentes, o run_bash e os MCPs locais as veem.
 */
const auth = useAuthStore()
const packages = usePackagesStore()

const loadError = ref<string>()
const query = ref('')
const hits = ref<IPackageHit[]>([])
const searching = ref(false)
const searchError = ref<string>()
/** O pacote em instalação ou remoção agora (o servidor faz uma operação por vez). */
const working = ref<string>()
const result = ref<{ name: string; action: 'install' | 'remove'; ok: boolean; log: string }>()
const removing = ref<string>()
const showDeps = ref(false)

onMounted(async () => {
  if (auth.isAdmin) await packages.load().catch((error) => (loadError.value = describe(error)))
})

const installed = computed(() => packages.state?.packages ?? [])
const requested = computed(() => installed.value.filter((entry) => entry.explicit))
const dependencies = computed(() => installed.value.filter((entry) => !entry.explicit))
const versionOf = (name: string) => installed.value.find((entry) => entry.name === name)?.version

function describe(error: unknown): string {
  if (error instanceof ApiError && error.code === 'package_busy') return 'Outra instalação está em andamento. Espere ela terminar.'
  return error instanceof Error ? error.message : String(error)
}

// Busca com debounce: o conda-forge é grande, e cada busca leva alguns segundos.
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
watch(query, (text) => {
  clearTimeout(timer)
  searchError.value = undefined
  const term = text.trim().toLowerCase()
  if (term.length < 2) {
    hits.value = []
    return
  }
  timer = setTimeout(async () => {
    const mine = ++generation
    searching.value = true
    try {
      const found = await packages.search(term)
      if (mine === generation) hits.value = found
    } catch (error) {
      if (mine === generation) searchError.value = describe(error)
    } finally {
      if (mine === generation) searching.value = false
    }
  }, 500)
})

async function act(name: string, action: 'install' | 'remove') {
  working.value = name
  result.value = undefined
  try {
    const outcome = action === 'install' ? await packages.install(name) : await packages.remove(name)
    result.value = { name, action, ...outcome }
  } catch (error) {
    result.value = { name, action, ok: false, log: describe(error) }
  } finally {
    working.value = undefined
  }
}

async function confirmRemove() {
  const name = removing.value
  removing.value = undefined
  if (name) await act(name, 'remove')
}
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra instala pacotes no servidor.</p>
  </div>

  <div v-else class="h-full overflow-y-auto">
    <section class="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <header class="flex items-center gap-2">
        <h1 class="text-xl font-semibold">Pacotes</h1>
        <span v-if="packages.state?.version" class="ml-auto text-xs text-zinc-500">micromamba {{ packages.state.version }}</span>
      </header>
      <p class="text-xs text-zinc-500">
        Ferramentas do servidor (git, curl, jq, ffmpeg…) do conda-forge, sem root. Ficam em <code>{{ packages.state?.prefix ?? '<dados>/tools' }}</code> — persistente: sobrevivem ao reboot. Valem na hora para o Bash dos agentes, o
        run_bash e os MCPs locais. Pacotes de linguagem instalados globalmente (<code>npm i -g</code>, <code>pip install --user</code>, <code>uv tool</code>, <code>cargo</code>, <code>go install</code>, <code>gem</code>) também
        vão para o disco persistente.
      </p>
      <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>

      <div v-if="packages.state && !packages.state.available" class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        O micromamba não está neste servidor. A imagem do gateway já traz; rodando fora dela, instale (<code>brew install micromamba</code> no Mac) ou aponte <code>MICROMAMBA_BIN</code> e reinicie.
      </div>

      <template v-else-if="packages.state">
        <label class="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 focus-within:border-emerald-500/60">
          <Icon name="search" class="h-4 w-4 shrink-0 text-zinc-500" />
          <input v-model="query" class="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none" placeholder="Buscar no conda-forge: git, curl, jq, ffmpeg…" autocomplete="off" spellcheck="false" />
          <span v-if="searching" class="text-xs text-zinc-500">buscando…</span>
        </label>
        <p v-if="searchError" class="text-sm text-rose-300">{{ searchError }}</p>

        <ul v-if="hits.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          <li v-for="hit in hits" :key="hit.name" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-[13px] text-zinc-200">{{ hit.name }}</div>
              <div class="text-xs text-zinc-500">{{ hit.version }}<template v-if="hit.license"> · {{ hit.license }}</template></div>
            </div>
            <span v-if="versionOf(hit.name)" class="text-xs text-emerald-300">instalado {{ versionOf(hit.name) }}</span>
            <button v-else type="button" :disabled="!!working" class="rounded-full bg-emerald-500 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="act(hit.name, 'install')">
              {{ working === hit.name ? 'Instalando…' : 'Instalar' }}
            </button>
          </li>
        </ul>
        <p v-else-if="query.trim().length >= 2 && !searching && !searchError" class="text-xs text-zinc-500">Nada no conda-forge com esse nome.</p>

        <div v-if="result" class="flex flex-col gap-2">
          <p class="text-sm" :class="result.ok ? 'text-emerald-300' : 'text-rose-300'">
            {{ result.ok ? `✓ ${result.name} ${result.action === 'install' ? 'instalado' : 'removido'}.` : `✕ Não deu para ${result.action === 'install' ? 'instalar' : 'remover'} ${result.name}.` }}
          </p>
          <pre v-if="!result.ok && result.log" class="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 text-[11px] whitespace-pre-wrap text-zinc-400">{{ result.log }}</pre>
        </div>

        <div class="border-t border-zinc-800/80 pt-4">
          <h2 class="mb-2 text-sm font-medium text-zinc-200">Instalados <span class="text-xs font-normal text-zinc-500">{{ requested.length }}</span></h2>
          <ul v-if="requested.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
            <li v-for="entry in requested" :key="entry.name" class="flex items-center gap-3 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-[13px] text-zinc-200">{{ entry.name }}</div>
                <div class="text-xs text-zinc-500">{{ entry.version }}</div>
              </div>
              <button type="button" :disabled="!!working" class="rounded-full px-3 py-1 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-40" @click="removing = entry.name">
                {{ working === entry.name ? 'Removendo…' : 'Desinstalar' }}
              </button>
            </li>
          </ul>
          <p v-else class="text-xs text-zinc-500">Nenhum pacote ainda — busque acima.</p>
          <button v-if="dependencies.length" type="button" class="mt-2 text-xs text-zinc-500 hover:text-zinc-300" @click="showDeps = !showDeps">
            {{ showDeps ? 'esconder' : 'mostrar' }} {{ dependencies.length }} dependência(s)
          </button>
          <p v-if="showDeps" class="mt-1 font-mono text-[11px] leading-relaxed text-zinc-500">
            <span v-for="entry in dependencies" :key="entry.name" class="mr-3 inline-block">{{ entry.name }} {{ entry.version }}</span>
          </p>
        </div>
      </template>
    </section>

    <ConfirmDialog
      :open="!!removing"
      :title="`Desinstalar ${removing ?? ''}?`"
      message="Sai da pasta de ferramentas do servidor. Agentes e MCPs que dependem dele deixam de achar o comando."
      action="Desinstalar"
      @confirm="confirmRemove"
      @cancel="removing = undefined"
    />
  </div>
</template>
