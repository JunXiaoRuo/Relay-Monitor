<script setup lang="ts">
import { Boxes, Check, Layers3 } from '@lucide/vue';

import type { RateGroupScope, Sub2ApiGroup } from '../types/domain';

const props = defineProps<{
  groups: Sub2ApiGroup[];
  mode: RateGroupScope['mode'];
  selectedIds: string[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:mode': [mode: RateGroupScope['mode']];
  'update:selectedIds': [ids: string[]];
}>();

function toggleGroup(id: string, checked: boolean): void {
  const selected = new Set(props.selectedIds);
  if (checked) selected.add(id);
  else selected.delete(id);
  emit('update:selectedIds', [...selected]);
}
</script>

<template>
  <div class="group-selector">
    <div class="scope-control" role="radiogroup" aria-label="倍率分组范围">
      <label :class="{ active: mode === 'all' }">
        <input :checked="mode === 'all'" type="radio" value="all" :disabled="disabled" @change="emit('update:mode', 'all')" />
        <Layers3 :size="17" aria-hidden="true" />
        <span><strong>全部分组</strong><small>自动包含以后新增的分组</small></span>
      </label>
      <label :class="{ active: mode === 'selected' }">
        <input :checked="mode === 'selected'" type="radio" value="selected" :disabled="disabled" @change="emit('update:mode', 'selected')" />
        <Boxes :size="17" aria-hidden="true" />
        <span><strong>指定分组</strong><small>只采集勾选的分组</small></span>
      </label>
    </div>

    <div v-if="mode === 'selected'" class="group-list" aria-label="选择 Sub2API 分组">
      <label v-for="group in groups" :key="group.id" :class="{ selected: selectedIds.includes(group.id) }">
        <input
          type="checkbox"
          :checked="selectedIds.includes(group.id)"
          :disabled="disabled"
          @change="toggleGroup(group.id, ($event.target as HTMLInputElement).checked)"
        />
        <span class="check-mark"><Check :size="13" aria-hidden="true" /></span>
        <span class="group-copy"><strong>{{ group.name }}</strong><small class="mono">ID {{ group.id }}</small></span>
        <span class="platform-label">{{ group.platform ?? '未分类' }}</span>
        <span class="rate-copy"><small>基础 / 生效</small><strong class="mono">{{ group.base_rate }} / {{ group.effective_rate }}</strong></span>
      </label>
      <p v-if="!groups.length" class="empty-copy">认证后获取分组，才能选择指定范围。</p>
    </div>
  </div>
</template>

<style scoped>
.group-selector { display: grid; gap: 12px; }
.scope-control { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.scope-control label { display: grid; min-width: 0; min-height: 64px; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary); cursor: pointer; }
.scope-control label.active { border-color: #91baae; background: var(--accent-soft); color: var(--accent); }
.scope-control input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.scope-control label:has(input:focus-visible) { outline: 3px solid rgb(19 107 90 / 18%); outline-offset: 1px; }
.scope-control strong,
.scope-control small { display: block; }
.scope-control strong { color: var(--text); font-size: 13px; }
.scope-control small { margin-top: 1px; color: var(--text-tertiary); font-size: 11px; }
.group-list { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.group-list > label { display: grid; min-width: 0; grid-template-columns: auto minmax(150px, 1fr) auto minmax(120px, auto); align-items: center; gap: 10px; min-height: 58px; padding: 9px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.group-list > label:last-of-type { border-bottom: 0; }
.group-list > label.selected { background: var(--accent-soft); }
.group-list input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.group-list > label:has(input:focus-visible) { outline: 3px solid rgb(19 107 90 / 18%); outline-offset: -3px; }
.check-mark { display: grid; width: 22px; height: 22px; place-items: center; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--surface); color: transparent; }
.selected .check-mark { border-color: var(--accent); background: var(--accent); color: #fff; }
.group-copy,
.group-copy strong,
.group-copy small,
.rate-copy,
.rate-copy strong,
.rate-copy small { display: block; min-width: 0; }
.group-copy strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.group-copy small,
.rate-copy small { color: var(--text-tertiary); font-size: 10px; }
.rate-copy { text-align: right; }
.rate-copy strong { font-size: 12px; }
.platform-label { padding: 3px 6px; border-radius: 4px; background: var(--blue-soft); color: var(--blue); font-size: 10px; font-weight: 650; }
.empty-copy { margin: 0; padding: 16px; color: var(--text-tertiary); font-size: 12px; text-align: center; }

@media (max-width: 640px) {
  .scope-control { grid-template-columns: minmax(0, 1fr); }
  .group-list > label { grid-template-columns: auto minmax(0, 1fr) auto; }
  .group-list > label > .check-mark { grid-column: 1; }
  .group-list > label > .group-copy { grid-column: 2; }
  .platform-label { grid-column: 3; }
  .rate-copy { grid-column: 2 / -1; text-align: left; }
}
</style>
