<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { computed } from 'vue';

import { clampPage, totalPages } from '../services/pagination';

const props = withDefaults(defineProps<{
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
}>(), {
  pageSizeOptions: () => [10, 20, 50, 100],
});

const emit = defineEmits<{
  'update:page': [value: number];
  'update:pageSize': [value: number];
}>();

const pageCount = computed(() => totalPages(props.total, props.pageSize));
const currentPage = computed(() => clampPage(props.page, props.total, props.pageSize));
const pageNumbers = computed(() => {
  const visible = 5;
  let start = Math.max(1, currentPage.value - Math.floor(visible / 2));
  const end = Math.min(pageCount.value, start + visible - 1);
  start = Math.max(1, end - visible + 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
});

function changePage(page: number): void {
  emit('update:page', clampPage(page, props.total, props.pageSize));
}

function changePageSize(event: Event): void {
  emit('update:pageSize', Number((event.target as HTMLSelectElement).value));
  emit('update:page', 1);
}
</script>

<template>
  <nav v-if="total > 0" class="pagination" aria-label="分页导航">
    <span class="pagination-summary">共 {{ total }} 条</span>
    <label class="pagination-size">
      <span>每页</span>
      <select class="select" :value="pageSize" aria-label="每页显示数量" @change="changePageSize">
        <option v-for="option in pageSizeOptions" :key="option" :value="option">{{ option }}</option>
      </select>
      <span>条</span>
    </label>
    <div class="pagination-pages">
      <button class="page-button" type="button" :disabled="currentPage <= 1" title="上一页" aria-label="上一页" @click="changePage(currentPage - 1)">
        <ChevronLeft :size="16" aria-hidden="true" />
      </button>
      <button
        v-for="number in pageNumbers"
        :key="number"
        class="page-button page-number"
        :class="{ active: number === currentPage }"
        type="button"
        :aria-current="number === currentPage ? 'page' : undefined"
        :aria-label="`第 ${number} 页`"
        @click="changePage(number)"
      >
        {{ number }}
      </button>
      <button class="page-button" type="button" :disabled="currentPage >= pageCount" title="下一页" aria-label="下一页" @click="changePage(currentPage + 1)">
        <ChevronRight :size="16" aria-hidden="true" />
      </button>
    </div>
    <span class="pagination-position">第 {{ currentPage }} / {{ pageCount }} 页</span>
  </nav>
</template>

<style scoped>
.pagination { display: flex; min-height: 58px; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.pagination-summary,
.pagination-position { color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }
.pagination-size { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.pagination-size .select { width: 70px; min-height: 34px; padding: 5px 24px 5px 8px; }
.pagination-pages { display: flex; min-height: 34px; align-items: center; gap: 4px; }
.page-button { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text-secondary); cursor: pointer; }
.page-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.page-button:disabled { cursor: not-allowed; opacity: 0.45; }
.page-number.active { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 700; }
@media (max-width: 600px) {
  .pagination { justify-content: center; }
  .pagination-summary { width: 100%; text-align: center; }
  .pagination-position { display: none; }
}
@media (max-width: 390px) {
  .page-number:not(.active) { display: none; }
}
</style>
