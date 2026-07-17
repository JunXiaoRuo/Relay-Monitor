<script setup lang="ts">
import { Activity, ArrowRight, Eye, EyeOff, KeyRound, ShieldAlert, UserRound } from '@lucide/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const showPassword = ref(false);
const insecureLanAccess = window.location.protocol === 'http:'
  && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

async function submit(): Promise<void> {
  if (!username.value || !password.value) return;
  if (await auth.login(username.value, password.value)) {
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.replace(redirect);
  }
}

</script>

<template>
  <main class="login-page">
    <section class="login-brand" aria-label="Relay Monitor">
      <div class="login-brand-inner">
        <span class="login-mark"><Activity :size="24" aria-hidden="true" /></span>
        <p class="product-name">Relay Monitor</p>
        <h1>看清每个中转站的真实运行状态</h1>
        <p class="product-copy">
          将连通性、认证、余额和倍率分开监控，让故障定位与通知处理保持清晰。
        </p>
        <dl class="login-signals">
          <div>
            <dt>独立监控</dt>
            <dd>连通性 · 倍率 · 余额</dd>
          </div>
          <div>
            <dt>事件闭环</dt>
            <dd>告警 · 静默 · 恢复</dd>
          </div>
        </dl>
      </div>
    </section>

    <section class="login-form-pane">
      <form class="login-form" @submit.prevent="submit">
        <div class="mobile-brand">
          <span class="login-mark"><Activity :size="20" aria-hidden="true" /></span>
          <strong>Relay Monitor</strong>
        </div>
        <header>
          <p class="login-kicker">管理控制台</p>
          <h2>登录账户</h2>
          <p>使用服务器端已创建的管理员账户。</p>
        </header>

        <div v-if="insecureLanAccess" class="notice notice-warning transport-warning" role="status">
          <ShieldAlert :size="16" aria-hidden="true" />
          当前使用 HTTP，登录信息和管理数据未加密；只应在受信局域网中使用。
        </div>

        <div v-if="auth.error" class="notice notice-danger" role="alert">
          {{ auth.error }}
        </div>

        <div class="field">
          <label for="username">用户名</label>
          <div class="login-input-wrap">
            <UserRound :size="17" aria-hidden="true" />
            <input id="username" v-model="username" class="input" autocomplete="username" autofocus required />
          </div>
        </div>

        <div class="field">
          <label for="password">密码</label>
          <div class="login-input-wrap">
            <KeyRound :size="17" aria-hidden="true" />
            <input
              id="password"
              v-model="password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              required
            />
            <button
              class="password-toggle"
              type="button"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="17" aria-hidden="true" />
              <Eye v-else :size="17" aria-hidden="true" />
            </button>
          </div>
        </div>

        <button class="btn btn-primary login-submit" type="submit" :disabled="auth.loading || !username || !password">
          {{ auth.loading ? '正在验证…' : '登录' }}
          <ArrowRight v-if="!auth.loading" :size="17" aria-hidden="true" />
        </button>

      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  grid-template-columns: minmax(330px, 0.88fr) minmax(420px, 1.12fr);
  background: var(--surface);
}

.login-brand {
  display: grid;
  place-items: center;
  padding: 56px;
  background: #18201f;
  color: #f6faf8;
}

.login-brand-inner {
  width: min(430px, 100%);
}

.login-mark {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 15%);
  border-radius: 7px;
  background: #247663;
  color: #fff;
}

.product-name {
  margin: 18px 0 28px;
  color: #91a29d;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

.login-brand h1 {
  max-width: 430px;
  margin: 0;
  font-size: 38px;
  font-weight: 680;
  line-height: 1.25;
  letter-spacing: 0;
}

.product-copy {
  max-width: 420px;
  margin: 18px 0 32px;
  color: #aebbb7;
  font-size: 15px;
  line-height: 1.8;
}

.login-signals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.login-signals div {
  padding: 13px 0;
  border-top: 1px solid rgb(255 255 255 / 13%);
}

.login-signals dt {
  color: #e9f2ef;
  font-size: 14px;
  font-weight: 680;
}

.login-signals dd {
  margin: 3px 0 0;
  color: #8f9e99;
  font-size: 13px;
}

.login-form-pane {
  display: grid;
  place-items: center;
  padding: 40px;
}

.login-form {
  width: min(420px, 100%);
}

.login-form header {
  margin-bottom: 26px;
}

.login-form header h2 {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0;
}

.login-form header > p:last-child {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 15px;
}

.login-kicker {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 750;
  text-transform: uppercase;
}

.login-form .field {
  margin-bottom: 16px;
}

.transport-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 16px;
}

.transport-warning svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.login-input-wrap {
  position: relative;
}

.login-input-wrap > svg {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 11px;
  color: var(--text-tertiary);
  transform: translateY(-50%);
}

.login-input-wrap .input {
  height: 46px;
  padding-right: 42px;
  padding-left: 38px;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: 5px;
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  transform: translateY(-50%);
  cursor: pointer;
}

.login-submit {
  width: 100%;
  min-height: 46px;
}

.mobile-brand {
  display: none;
}

@media (max-width: 820px) {
  .login-page {
    grid-template-columns: minmax(0, 1fr);
  }

  .login-brand {
    display: none;
  }

  .login-form-pane {
    padding: 30px 20px;
  }

  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 42px;
  }

  .mobile-brand .login-mark {
    width: 34px;
    height: 34px;
  }
}

@media (max-width: 430px) {
  .login-form-pane {
    align-items: start;
    padding: 24px 18px;
  }

  .mobile-brand {
    margin-bottom: 34px;
  }
}
</style>
