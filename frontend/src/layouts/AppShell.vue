<script setup lang="ts">
import {
  Activity,
  BellRing,
  CalendarClock,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  RadioTower,
  Settings2,
  TriangleAlert,
  X,
} from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { api } from '../services/api';
import { useAuthStore } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const drawerOpen = ref(false);
const passwordDialogOpen = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordBusy = ref(false);
const passwordError = ref<string | null>(null);
const passwordMessage = ref<string | null>(null);

const navigation = [
  { label: '运行概览', to: '/dashboard', icon: LayoutDashboard },
  { label: '中转站', to: '/sites', icon: RadioTower },
  { label: '倍率', to: '/rates', icon: Gauge },
  { label: '事件中心', to: '/incidents', icon: TriangleAlert },
  { label: '通知管理', to: '/notifications', icon: BellRing },
  { label: '维护与静默', to: '/maintenance', icon: CalendarClock },
  { label: '系统设置', to: '/system', icon: Settings2 },
];

const currentTitle = computed(() => String(route.meta.title ?? 'Relay Monitor'));

watch(() => route.fullPath, () => {
  drawerOpen.value = false;
});

async function logout(): Promise<void> {
  await auth.logout();
  await router.push('/login');
}

function clearPasswordFields(): void {
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
}

function openPasswordDialog(): void {
  clearPasswordFields();
  passwordError.value = null;
  passwordMessage.value = null;
  passwordDialogOpen.value = true;
}

function closePasswordDialog(): void {
  if (passwordBusy.value) return;
  passwordDialogOpen.value = false;
  clearPasswordFields();
  passwordError.value = null;
  passwordMessage.value = null;
}

async function changePassword(): Promise<void> {
  passwordError.value = null;
  passwordMessage.value = null;
  if (!currentPassword.value) {
    passwordError.value = '请输入当前密码。';
    return;
  }
  if (newPassword.value.length < 12) {
    passwordError.value = '新密码至少需要 12 个字符。';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = '两次输入的新密码不一致。';
    return;
  }
  if (newPassword.value === currentPassword.value) {
    passwordError.value = '新密码不能与当前密码相同。';
    return;
  }

  passwordBusy.value = true;
  try {
    const result = await api.session.changePassword(currentPassword.value, newPassword.value);
    clearPasswordFields();
    passwordMessage.value = result.revoked_session_count > 0
      ? `密码已修改，并已退出其他 ${result.revoked_session_count} 个会话。`
      : '密码已修改。';
  } catch (caught) {
    passwordError.value = caught instanceof Error ? caught.message : '密码修改失败，请稍后重试。';
  } finally {
    passwordBusy.value = false;
  }
}
</script>

<template>
  <div class="app-shell">
    <button
      v-if="drawerOpen"
      class="drawer-backdrop"
      type="button"
      aria-label="关闭导航菜单"
      title="关闭导航菜单"
      @click="drawerOpen = false"
    />

    <aside class="sidebar" :class="{ open: drawerOpen }" aria-label="主导航">
      <div class="brand-row">
        <RouterLink class="brand" to="/dashboard" aria-label="Relay Monitor 运行概览">
          <span class="brand-mark"><Activity :size="19" aria-hidden="true" /></span>
          <span>
            <strong>Relay Monitor</strong>
            <small>运维监控控制台</small>
          </span>
        </RouterLink>
        <button class="sidebar-close" type="button" title="关闭导航" aria-label="关闭导航" @click="drawerOpen = false">
          <X :size="19" aria-hidden="true" />
        </button>
      </div>

      <nav class="nav-list">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          class="nav-item"
          :to="item.to"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="account-row">
          <span class="account-avatar">{{ auth.user?.display_name.slice(0, 1) }}</span>
          <span class="account-copy">
            <strong>{{ auth.user?.display_name }}</strong>
            <small>{{ auth.user?.timezone }}</small>
          </span>
          <button class="account-action" type="button" title="修改密码" aria-label="修改密码" @click="openPasswordDialog">
            <KeyRound :size="17" aria-hidden="true" />
          </button>
          <button class="account-logout" type="button" title="退出登录" aria-label="退出登录" @click="logout">
            <LogOut :size="17" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>

    <div class="shell-main">
      <header class="topbar">
        <button class="topbar-menu" type="button" title="打开导航" aria-label="打开导航" @click="drawerOpen = true">
          <Menu :size="20" aria-hidden="true" />
        </button>
        <strong>{{ currentTitle }}</strong>
        <span class="topbar-environment">
          <span class="environment-dot" />
          管理服务在线
        </span>
      </header>
      <main class="main-content">
        <RouterView />
      </main>
    </div>

    <Teleport to="body">
      <div v-if="passwordDialogOpen" class="password-backdrop" @click.self="closePasswordDialog" @keydown.esc="closePasswordDialog">
        <form class="password-dialog" aria-labelledby="password-dialog-title" @submit.prevent="changePassword">
          <header>
            <div>
              <h2 id="password-dialog-title">修改管理员密码</h2>
              <p>修改后会保留当前会话，并退出其他已登录会话。</p>
            </div>
            <button class="dialog-close" type="button" :disabled="passwordBusy" title="关闭" aria-label="关闭" @click="closePasswordDialog">
              <X :size="18" aria-hidden="true" />
            </button>
          </header>
          <div class="password-body">
            <div v-if="passwordError" class="notice notice-danger" role="alert">{{ passwordError }}</div>
            <div v-if="passwordMessage" class="notice notice-success" role="status">{{ passwordMessage }}</div>
            <div class="field">
              <label for="account-current-password">当前密码</label>
              <input id="account-current-password" v-model="currentPassword" class="input" type="password" autocomplete="current-password" :disabled="passwordBusy" />
            </div>
            <div class="field">
              <label for="account-new-password">新密码</label>
              <input id="account-new-password" v-model="newPassword" class="input" type="password" autocomplete="new-password" :disabled="passwordBusy" />
              <span class="field-hint">至少 12 个字符，不能与当前密码相同。</span>
            </div>
            <div class="field">
              <label for="account-confirm-password">确认新密码</label>
              <input id="account-confirm-password" v-model="confirmPassword" class="input" type="password" autocomplete="new-password" :disabled="passwordBusy" />
            </div>
          </div>
          <footer>
            <button class="btn btn-secondary" type="button" :disabled="passwordBusy" @click="closePasswordDialog">取消</button>
            <button class="btn btn-primary" type="submit" :disabled="passwordBusy">
              <LoaderCircle v-if="passwordBusy" :size="16" class="spin" aria-hidden="true" />
              <KeyRound v-else :size="16" aria-hidden="true" />
              {{ passwordBusy ? '修改中…' : '修改密码' }}
            </button>
          </footer>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.sidebar {
  position: fixed;
  z-index: 40;
  top: 0;
  bottom: 0;
  left: 0;
  display: flex;
  width: var(--sidebar-width);
  flex-direction: column;
  background: #18201f;
  color: #edf3f1;
}

.brand-row {
  display: flex;
  min-height: var(--topbar-height);
  align-items: center;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
}

.brand {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 11px;
  padding: 11px 17px;
  text-decoration: none;
}

.brand-mark {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  background: #247663;
}

.brand strong,
.brand small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand strong {
  font-size: 15px;
  letter-spacing: 0;
}

.brand small {
  margin-top: 1px;
  color: #9fadaa;
  font-size: 11px;
  text-transform: uppercase;
}

.sidebar-close {
  display: none;
  width: 36px;
  height: 36px;
  place-items: center;
  margin-right: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #bdc7c4;
}

.nav-list {
  display: grid;
  gap: 4px;
  padding: 15px 11px;
}

.nav-item {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 11px;
  padding: 10px 11px;
  border-radius: 5px;
  color: #aebbb7;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}

.nav-item:hover {
  background: rgb(255 255 255 / 5%);
  color: #fff;
}

.nav-item.router-link-active {
  background: #273936;
  color: #fff;
}

.nav-item.router-link-active svg {
  color: #71c0aa;
}

.sidebar-footer {
  margin-top: auto;
  padding: 10px;
  border-top: 1px solid rgb(255 255 255 / 8%);
}

.account-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 7px 6px;
}

.account-avatar {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 50%;
  background: #344541;
  color: #e9f1ef;
  font-size: 13px;
  font-weight: 700;
}

.account-copy {
  min-width: 0;
  flex: 1;
}

.account-copy strong,
.account-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-copy strong {
  font-size: 13px;
}

.account-copy small {
  color: #8e9b98;
  font-size: 11px;
}

.account-action,
.account-logout {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #8e9b98;
  cursor: pointer;
}

.account-action:hover,
.account-logout:hover {
  background: rgb(255 255 255 / 6%);
  color: #fff;
}

.password-backdrop {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgb(12 18 16 / 52%);
}

.password-dialog {
  width: min(480px, 100%);
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  box-shadow: 0 18px 50px rgb(10 24 20 / 20%);
  color: var(--text);
}

.password-dialog > header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}

.password-dialog h2 { margin: 0; font-size: 18px; }
.password-dialog header p { margin: 3px 0 0; color: var(--text-secondary); font-size: 13px; }
.dialog-close { display: grid; width: 36px; height: 36px; flex: 0 0 36px; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.dialog-close:hover:not(:disabled) { background: var(--surface-muted); color: var(--text); }
.password-body { display: grid; gap: 14px; padding: 18px; }
.password-dialog > footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.shell-main {
  min-width: 0;
  margin-left: var(--sidebar-width);
}

.topbar {
  position: sticky;
  z-index: 25;
  top: 0;
  display: flex;
  height: var(--topbar-height);
  align-items: center;
  gap: 11px;
  padding: 0 36px;
  border-bottom: 1px solid var(--border);
  background: rgb(255 255 255 / 96%);
}

.topbar > strong {
  font-size: 15px;
}

.topbar-menu {
  display: none;
  width: 36px;
  height: 36px;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-secondary);
}

.topbar-environment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 13px;
}

.environment-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}

.drawer-backdrop {
  display: none;
}

@media (max-width: 900px) {
  .sidebar {
    transform: translateX(-100%);
    transition: transform 160ms ease;
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .sidebar-close,
  .topbar-menu {
    display: grid;
  }

  .shell-main {
    margin-left: 0;
  }

  .topbar {
    padding: 0 16px;
  }

  .drawer-backdrop {
    position: fixed;
    z-index: 35;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: rgb(12 18 16 / 44%);
  }
}

@media (max-width: 430px) {
  .sidebar {
    width: min(300px, 88vw);
  }

  .topbar {
    padding: 0 12px;
  }

  .topbar-environment {
    font-size: 0;
  }
}
</style>
