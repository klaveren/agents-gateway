<script setup lang="ts">
  import NavRail from '@/components/NavRail.vue'
</script>

<template>
  <div class="flex h-full overflow-hidden pt-[env(safe-area-inset-top)]">
    <NavRail />
    <slot />
  </div>
</template>
