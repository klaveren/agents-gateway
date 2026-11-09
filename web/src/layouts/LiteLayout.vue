<script setup lang="ts">
  import LiteNav from '@/components/LiteNav.vue'
</script>

<!-- A casca da lite: o mesmo conteúdo da PRO, com o menu reduzido. -->
<template>
  <div class="flex h-full overflow-hidden">
    <LiteNav />
    <slot />
  </div>
</template>
