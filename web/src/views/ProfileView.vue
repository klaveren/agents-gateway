<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AccessTokens from '@/components/AccessTokens.vue'
import OpenSessions from '@/components/OpenSessions.vue'
import { ApiError } from '@/lib/api'
import type { TVoiceLevel } from '@/lib/speech'
import { KNOWN_SPEECH_MODELS } from '@/lib/speechCatalog'
import { useAuthStore } from '@/stores/auth'
import { useSpeechStore } from '@/stores/speech'

/** O perfil: o que é da PESSOA (conta, senha, tokens de acesso). O que é do sistema mora em Configuração. */
const auth = useAuthStore()

const speech = useSpeechStore()
const voiceError = ref<string>()
const voiceDraft = ref('')
/** 🔊 As vozes do modelo que o admin escolheu (ver `speechCatalog`); sem lista conhecida, o campo livre. */
const voiceChoices = computed(() => {
  const model = speech.voice?.engine.model
  const known = model ? ([...KNOWN_SPEECH_MODELS.dashscope, ...KNOWN_SPEECH_MODELS.openai].find((item) => item.id === model)?.voices ?? []) : []
  // 🎙️ As vozes da conta (já filtradas pelo servidor para o modelo do motor) vão depois das conhecidas.
  const account = (speech.voice?.engine.voices ?? []).filter((id) => !known.some((voice) => voice.id === id)).map((id) => ({ id, label: `${id} · voz da conta` }))
  return [...known, ...account]
})
const typingVoice = ref(false)
function pickVoice(value: string) {
  if (value === '__other__') {
    typingVoice.value = true
    return
  }
  voiceDraft.value = value
  void saveVoice({ voice: value || null })
}
const LEVEL_OPTIONS: Array<{ value: TVoiceLevel; label: string }> = [
  { value: 'info', label: 'Todas' },
  { value: 'attention', label: 'Atenção e urgentes' },
  { value: 'urgent', label: 'Só urgentes' },
]

onMounted(async () => {
  if (!auth.user) return
  try {
    await speech.load()
    voiceDraft.value = speech.voice?.voice ?? ''
  } catch {
    // Sem a voz a seção só não aparece com valores; o resto do perfil segue.
  }
})

async function saveVoice(patch: Parameters<typeof speech.save>[0]) {
  voiceError.value = undefined
  try {
    await speech.save(patch)
  } catch (error) {
    voiceError.value = error instanceof Error ? error.message : String(error)
  }
}

function testVoice() {
  voiceError.value = undefined
  speech.sample()
}

const currentPassword = ref('')
const nextPassword = ref('')
const passwordNote = ref<string>()
const passwordError = ref<string>()

async function changePassword() {
  passwordNote.value = undefined
  passwordError.value = undefined
  try {
    await auth.changePassword(currentPassword.value, nextPassword.value)
    currentPassword.value = ''
    nextPassword.value = ''
    passwordNote.value = 'Senha trocada. As outras sessões desta conta foram encerradas.'
  } catch (error) {
    const issues = error instanceof ApiError ? error.fieldIssues : {}
    passwordError.value = issues.current ? 'A senha atual não confere.' : issues.password ? 'A nova senha precisa ter pelo menos 10 caracteres.' : String(error)
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto px-4 py-6">
    <div class="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 class="text-xl font-semibold">Perfil</h1>

      <p v-if="!auth.user" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
        Entre para ver a sua conta.
        <RouterLink v-if="auth.localAccounts" :to="{ path: '/login', query: { next: '/profile' } }" class="text-emerald-300 underline">Entrar</RouterLink>
      </p>

      <template v-else>
        <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 class="font-medium">Minha conta</h2>
          <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div class="min-w-0"><dt class="text-xs text-zinc-500">Nome</dt><dd class="truncate text-zinc-200">{{ auth.user.name }}</dd></div>
            <div class="min-w-0"><dt class="text-xs text-zinc-500">E-mail</dt><dd class="truncate text-zinc-200">{{ auth.user.email }}</dd></div>
            <div class="min-w-0"><dt class="text-xs text-zinc-500">Papel</dt><dd class="text-zinc-200">{{ auth.user.role === 'admin' ? 'administrador' : 'membro' }}</dd></div>
          </dl>
        </section>

        <section v-if="speech.voice" class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5" data-test="voice-section">
          <h2 class="font-medium">Voz</h2>
          <p v-if="!speech.voice.engine.available" class="text-sm text-zinc-500" data-test="voice-unavailable">A voz ainda não foi configurada pelo administrador (Ajustes → Voz).</p>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              class="accent-emerald-500"
              data-test="voice-enabled"
              :checked="speech.voice.enabled"
              :disabled="!speech.voice.engine.available"
              @change="saveVoice({ enabled: ($event.target as HTMLInputElement).checked })"
            />
            Ler minhas mensagens em voz alta
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
              Ler
              <select
                class="rounded-lg border border-zinc-800 bg-zinc-900 px-2 h-9 text-sm"
                data-test="voice-level"
                :value="speech.voice.minLevel"
                @change="saveVoice({ minLevel: ($event.target as HTMLSelectElement).value as TVoiceLevel })"
              >
                <option v-for="option in LEVEL_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
              Voz
              <select
                v-if="voiceChoices.length && !typingVoice"
                :value="voiceDraft"
                class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 h-9 text-sm"
                data-test="voice-name"
                @change="pickVoice(($event.target as HTMLSelectElement).value)"
              >
                <option value="">Padrão{{ speech.voice.engine.defaultVoice ? ` (${speech.voice.engine.defaultVoice})` : '' }}</option>
                <option v-if="voiceDraft && !voiceChoices.some((voice) => voice.id === voiceDraft)" :value="voiceDraft">{{ voiceDraft }}</option>
                <option v-for="voice in voiceChoices" :key="voice.id" :value="voice.id">{{ voice.label }}</option>
                <option value="__other__">Outra…</option>
              </select>
              <input
                v-else
                v-model="voiceDraft"
                type="text"
                class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 h-9 text-sm"
                data-test="voice-name"
                :placeholder="speech.voice.engine.defaultVoice ?? 'Voz padrão'"
                @change="saveVoice({ voice: voiceDraft.trim() || null })"
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300 sm:col-span-2">
              Velocidade: {{ speech.voice.rate.toFixed(1) }}x
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                class="accent-emerald-500"
                data-test="voice-rate"
                :value="speech.voice.rate"
                @change="saveVoice({ rate: Number(($event.target as HTMLInputElement).value) })"
              />
            </label>
          </div>
          <div class="flex items-center gap-3">
            <button type="button" class="btn btn-secondary" data-test="voice-test" :disabled="!speech.voice.engine.available" @click="testVoice">Testar</button>
            <button v-if="speech.blocked" type="button" class="btn btn-ghost btn-sm" data-test="voice-unlock" @click="speech.unlock()">Ativar som</button>
            <span v-if="voiceError || speech.error" class="text-sm text-rose-300" data-test="voice-error">{{ voiceError || speech.error }}</span>
          </div>
        </section>

        <section class="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 class="font-medium">Senha</h2>
          <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="changePassword">
            <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
              Senha atual
              <input v-model="currentPassword" type="password" required autocomplete="current-password" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 h-9 text-sm" />
            </label>
            <label class="flex min-w-0 flex-col gap-1 text-sm text-zinc-300">
              Nova senha
              <input v-model="nextPassword" type="password" required autocomplete="new-password" class="rounded-lg border border-zinc-800 bg-zinc-900 px-3 h-9 text-sm" />
            </label>
            <div class="flex items-center gap-3 sm:col-span-2">
              <button type="submit" class="btn btn-secondary">Trocar senha</button>
              <span v-if="passwordNote" class="text-sm text-success-300">{{ passwordNote }}</span>
              <span v-if="passwordError" class="text-sm text-rose-300">{{ passwordError }}</span>
            </div>
          </form>
        </section>

        <OpenSessions />

        <AccessTokens />
      </template>
    </div>
  </div>
</template>
