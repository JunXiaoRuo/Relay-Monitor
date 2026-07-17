<script setup lang="ts">
import { Inbox } from '@lucide/vue';

defineProps<{
  title: string;
  description: string;
}>();
</script>

<template>
  <div class="empty-state">
    <div>
      <Inbox :size="28" aria-hidden="true" />
      <h3>{{ title }}</h3>
      <p>{{ description }}</p>
      <div v-if="$slots.default" class="empty-actions">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-actions {
  display: flex;
  justify-content: center;
  margin-top: 13px;
}
</style>
