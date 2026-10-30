<script setup lang="ts">
  /**
   * SEGURANÇA (só admin): as guias do que protege o gateway. Cada guia é uma rota filha (`/security/<guia>`), então o link
   * de cada uma é colável. Por enquanto, Segredos (a máscara da saída das ferramentas).
   */
  const TABS = [{ to: '/security/secrets', name: 'security-secrets', label: 'Segredos' }] as const
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="px-4 pt-5">
      <div class="mx-auto flex max-w-3xl flex-col gap-2">
        <h1 class="text-xl font-semibold">Segurança</h1>
        <nav class="flex gap-1 text-sm" aria-label="Guias">
          <RouterLink
            v-for="tab in TABS"
            :key="tab.name"
            :to="tab.to"
            class="rounded-full px-3 py-1"
            :class="$route.name === tab.name ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60'"
            :aria-current="$route.name === tab.name ? 'page' : undefined"
          >
            {{ tab.label }}
          </RouterLink>
        </nav>
      </div>
    </header>
    <div class="min-h-0 flex-1">
      <RouterView />
    </div>
  </div>
</template>
