<script setup lang="ts">
import { AlertTriangle, LoaderCircle, Trash2, X } from '@lucide/vue';
import { nextTick, ref, useId, watch } from 'vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  itemName: string;
  loading?: boolean;
  error?: string | null;
  warning?: string;
  confirmLabel?: string;
  loadingLabel?: string;
}>(), {
  loading: false,
  error: null,
  warning: '删除后无法撤销，相关配置和历史关联可能同时失效。',
  confirmLabel: '确认删除',
  loadingLabel: '正在删除…',
});

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

const titleId = `delete-dialog-${useId()}`;
const cancelButton = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    cancelButton.value?.focus();
  },
);

function cancel(): void {
  if (!props.loading) emit('cancel');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="delete-backdrop" @click.self="cancel" @keydown.esc="cancel">
      <section class="delete-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="titleId">
        <header>
          <span class="danger-mark"><AlertTriangle :size="20" aria-hidden="true" /></span>
          <div>
            <h2 :id="titleId">{{ title }}</h2>
            <p>{{ description }}</p>
          </div>
          <button class="icon-btn close-button" type="button" :disabled="loading" title="关闭" aria-label="关闭" @click="cancel">
            <X :size="17" aria-hidden="true" />
          </button>
        </header>

        <div class="delete-body">
          <p class="target-name">{{ itemName }}</p>
          <p class="warning-copy">{{ warning }}</p>
          <div v-if="error" class="notice notice-danger" role="alert">{{ error }}</div>
        </div>

        <footer>
          <button ref="cancelButton" class="btn btn-secondary" type="button" :disabled="loading" @click="cancel">取消</button>
          <button class="btn confirm-button" type="button" :disabled="loading" @click="emit('confirm')">
            <LoaderCircle v-if="loading" :size="16" class="spin" aria-hidden="true" />
            <Trash2 v-else :size="16" aria-hidden="true" />
            {{ loading ? loadingLabel : confirmLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.delete-backdrop {
  position: fixed;
  z-index: 120;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(12 18 16 / 52%);
}

.delete-dialog {
  width: min(480px, 100%);
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  border: 1px solid #e0c2bf;
  border-radius: 7px;
  background: var(--surface);
  box-shadow: 0 18px 50px rgb(10 24 20 / 20%);
}

.delete-dialog > header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 17px;
  border-bottom: 1px solid var(--border);
}

.danger-mark {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
}

.delete-dialog h2 {
  margin: 0;
  font-size: 18px;
}

.delete-dialog header p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.close-button {
  width: 36px;
  height: 36px;
  flex-basis: 36px;
}

.delete-body {
  display: grid;
  gap: 10px;
  padding: 17px;
}

.target-name {
  margin: 0;
  padding: 10px 12px;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-subtle);
  font-weight: 680;
}

.warning-copy {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.delete-dialog > footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 13px 17px;
  border-top: 1px solid var(--border);
  background: var(--surface-subtle);
}

.confirm-button {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}

.confirm-button:hover:not(:disabled) {
  border-color: #8e302d;
  background: #8e302d;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 430px) {
  .delete-dialog > header,
  .delete-body {
    padding: 14px;
  }

  .delete-dialog > footer {
    padding: 12px 14px;
  }

  .delete-dialog > footer .btn {
    flex: 1 1 0;
  }
}
</style>
