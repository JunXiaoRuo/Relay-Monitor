import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { api, setCsrfToken } from '../services/api';
import type { AdminUser } from '../types/domain';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AdminUser | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const signedIn = computed(() => user.value !== null);

  async function initialize(): Promise<void> {
    if (initialized.value) return;
    try {
      const sessionUser = await api.session.me();
      user.value = sessionUser;
      setCsrfToken(sessionUser.csrf_token);
    } catch {
      user.value = null;
    } finally {
      initialized.value = true;
    }
  }

  async function login(username: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      const sessionUser = await api.session.login(username, password);
      user.value = sessionUser;
      setCsrfToken(sessionUser.csrf_token);
      return true;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '登录失败';
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    await api.session.logout().catch(() => undefined);
    user.value = null;
    error.value = null;
    setCsrfToken(undefined);
  }

  return {
    user,
    initialized,
    loading,
    error,
    signedIn,
    initialize,
    login,
    logout,
  };
});
