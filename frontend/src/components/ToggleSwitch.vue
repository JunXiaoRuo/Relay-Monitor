<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  disabled?: boolean;
  label: string;
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <label class="toggle-wrap" :class="{ disabled }">
    <button
      class="toggle"
      :class="{ active: modelValue }"
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :aria-label="label"
      :title="label"
      :disabled="disabled"
      @click="$emit('update:modelValue', !modelValue)"
    >
      <span />
    </button>
    <span class="toggle-label">{{ label }}</span>
  </label>
</template>

<style scoped>
.toggle-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.toggle-wrap.disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.toggle {
  position: relative;
  width: 36px;
  height: 20px;
  flex: 0 0 36px;
  padding: 0;
  border: 1px solid #acb8b4;
  border-radius: 999px;
  background: #c8d0cd;
  cursor: pointer;
}

.toggle span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(15 35 29 / 20%);
  transition: transform 130ms ease;
}

.toggle.active {
  border-color: var(--accent);
  background: var(--accent);
}

.toggle.active span {
  transform: translateX(16px);
}

.toggle-label {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 620;
}
</style>
