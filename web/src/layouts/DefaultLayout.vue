<script setup lang="ts">
  import NavRail from '@/components/NavRail.vue'
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <NavRail />
    <slot />
  </div>
</template>
