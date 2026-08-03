# Relay Monitor

Relay Monitor 是面向单管理员或小团队的中转站监控与告警平台。它把连通性、认证、余额、倍率和模型实测拆成独立任务，通过适配器接入上游。当前内置并经过契约测试的适配器是 Sub2API。

项目支持 Windows 开发与部署、Linux 部署，并提供 macOS 原生测试便携包。生产构建由一个 Node.js 进程同时提供 API、调度器、通知 Worker 和 Web 管理台，不需要再启动第二个 `server` 项目、独立 SQLite 服务、MySQL 或 Docker。

> 当前版本为 `1.0.1`。公网部署前必须配置 HTTPS、可靠备份和严格文件权限。

## 功能

- **站点管理**：添加、编辑、删除 Sub2API 站点；支持 Token 或账号密码、TLS 校验、备注、标签，以及连通性、登录状态、倍率、余额任务的独立开关、间隔、请求超时、失败重试次数和失败重试间隔。
- **指定分组**：认证后读取上游分组，可监控全部或只勾选指定分组。
- **每组实测 Key**：每个分组可不配置、选择同组已有 Key、自动创建 Key，或稍后手填。自动创建时额度上限和有效期都可留空，分别表示不限额和永不过期；Key 列表只向前端返回掩码元数据，且仅在选择“已有上游 Key”时按需读取。
- **倍率监控**：保存完整/部分快照、十进制倍率和变化历史；列表以平台为主、倍率类型为辅，支持按基础、用户、生效倍率升降序排列；可排除并删除分组，阻止后续采集重新加入；列表综合站点、倍率任务和模型实测显示“正常 / 异常 / 宕机”。
- **模型实测**：模型可自动获取或手填；手动实测与自动实测使用独立计划，并可设置单次请求超时。结果包含 TTFT、TPS、输入/输出/总 Token、缓存输入、推理 Token、总耗时和生成耗时。
- **行为线索**：检测客户端未声明的工具调用、上游回显工具配置、输入 Token 异常、提示词完整性、请求/返回模型名差异，并提供 Jeff Landry 固定知识题粗筛。这些线索不能证明上游提示词或底层模型身份。
- **事件通知**：Webhook 渠道、分层事件、站点/标签范围、规则直连一个或多个渠道、重试、自动恢复、静默和维护窗口；监控重试耗尽后的终态故障直接进入“告警中”，不再需要人工确认，也不再区分“待确认/已确认”；未选渠道时仍记录事件但不发送通知，连续恢复达到规则次数后自动恢复并按规则决定是否发送恢复通知。倍率新增、变化和移除是一次性“变化提醒”，只通知本次变化，不发送恢复通知。
- **事件层级**：新规则固定使用统一监控事件，按“中转站状态 / 倍率变化 / 模型实测 / 余额监控”一级类别及二级事件勾选；默认全选，父级联动全部子项，也可单选子项或多选父级。
- **运维安全**：管理员会话、CSRF、防暴力登录、审计、SQLite 在线备份、健康/就绪探针、AES-256-GCM 凭据保险库和主密钥轮换。
- **Webhook 格式**：通知渠道支持标准 JSON、`multipart/form-data` 和受限 LiquidJS 自定义内容。默认 JSON 在保留完整事件对象的同时提供顶层 `msg`、`monitor.name = "Relay Monitor"` 和 `heartbeat` 兼容字段；表单 `data` 字段包含同一个对象，自定义模板保持原样。额外 Header（含 Bearer Token）安全保存，不再要求配置签名、渠道级密钥或渠道级 CIDR。RFC1918 私网、`localhost` 和 IPv4/IPv6 回环 Webhook 默认可用，无需配置 `OUTBOUND_ALLOWED_CIDRS`。
- **账户与审计**：登录管理员可验证当前密码后修改密码，当前会话保留、其他有效会话撤销；审计记录支持搜索、结果/时间范围筛选、服务端分页、单条/选中/按时间/全部永久删除。
- **事件删除**：事件中心支持单条、选中、按最近一次时间和全部永久删除；关联根因子事件、通知 Outbox 和投递记录一并删除。
- **维护与静默**：维护窗口支持手动、单次和 Cron 计划；临时静默支持按站点、真实站点标签、事件类型和严重度限定。两者都继续采集，只抑制匹配通知。
- **列表分页**：中转站、倍率、事件中心、通知管理、维护/静默和审计均提供分页；审计使用服务端搜索与分页，需要跨站比较的页面按 API 分页安全加载后再在前端筛选和切页；分组实测面板只读取最近 5 条历史，历史接口由 SQLite 直接分页。

## 架构

~~~text
浏览器
  ├─ 开发：Vite :5173 ──代理──> Fastify :8080
  └─ 生产：Fastify :5173（HTTP 或内置 HTTPS）
                    ├─ /api/v1/*
                    ├─ dist/web（Vue）
                    ├─ 采集/实测调度器
                    ├─ 通知 Outbox Worker
                    └─ SQLite WAL + 加密凭据
                               │
                        Sub2API 适配器
~~~

技术栈：Node.js 22、TypeScript、Fastify、Zod、Vue 3、Vite、Pinia、SQLite WAL、Drizzle、Decimal.js、AES-256-GCM、Argon2id、Vitest 和 Playwright；便携包另使用一个无业务逻辑的 Go 薄启动器生成 Windows PE、Linux ELF 或 macOS Mach-O 入口。

~~~text
backend/
  adapters/     上游适配器、客户端和统一 DTO
  core/         调度、审计、快照、告警与安全
  db/           Schema、迁移和 SQLite
  routes/       管理 API
  services/     采集、实测、告警和通知
  cli/          迁移、管理员、主密钥命令
frontend/src/   Vue 管理台
shared/         前后端共享类型和通知事件
deploy/         Linux、Caddy、Windows 样例
docs/           开发与部署文档
packaging/      原生启动器、便携配置、初始化和服务样例
scripts/release Windows/Linux/macOS 打包与解压 smoke test
.github/        三种操作系统 CI、artifact 与标签 Release
tests/          单元、集成、端到端测试
data/           本地数据和依赖缓存（不提交）
~~~

上游差异必须留在 `backend/adapters/<adapter>`。调度、数据库、通知和前端只消费统一 DTO，不依赖 Sub2API 私有字段或 URL。

## 要求

- Node.js `22.19.0` 或更新的 22.x；项目拒绝 Node 23/24。
- pnpm `>= 10`；仓库声明 `11.7.0`，推荐使用 Corepack。
- Windows PowerShell 5.1/7，或常见 Linux/macOS shell。
- Webhook 渠道支持 HTTP/HTTPS。RFC1918 私网、`localhost` 和 IPv4/IPv6 回环可直接使用 HTTP；公网生产 Webhook 必须使用 HTTPS，除非管理员通过 `OUTBOUND_ALLOWED_CIDRS` 明确放行其全部解析地址。

## Windows 开发

~~~powershell
# 先进入克隆后的 Relay-Monitor 项目根目录
Set-Location .\Relay-Monitor
Copy-Item .env.example .env
corepack pnpm install --frozen-lockfile --store-dir .\data\pnpm-store
corepack pnpm db:migrate
corepack pnpm admin:create -- --username admin --display-name "管理员"
.\scripts\dev.ps1 -SkipInstall
~~~

管理员密码隐藏输入，至少 12 个字符。开发脚本默认监听所有本机网卡。`0.0.0.0` 只是监听地址，不能在浏览器中访问；请使用：

- 本机 Web：`http://127.0.0.1:5173`
- 局域网 Web：`http://<本机 LAN IPv4>:5173`
- 本机 API：`http://127.0.0.1:8080`
- 局域网 API：`http://<本机 LAN IPv4>:8080`

脚本会打印本机和全部可用 LAN URL。使用 `-ListenAddress` 指定 API/Vite 监听地址，`-WebPort` 指定 Vite 端口，`-ApiPort` 指定 API 端口：

~~~powershell
.\scripts\dev.ps1 -ListenAddress 0.0.0.0 -WebPort 5173 -ApiPort 8080 -SkipInstall
~~~

局域网监听会扩大访问面，只应在受信网络使用。Windows 防火墙仅放行专用网络和必要来源，不要将开发端口暴露到公网。生产 HTTP 也只适合受信局域网；公网或不受信网络必须使用 HTTPS。

开发时 Vite 提供热更新，Fastify 提供 API；两者仍属于同一仓库，按一次 `Ctrl+C` 一起停止。`data/` 不是另一套服务。详见 [开发文档](docs/development.md)。

## Windows/Linux/macOS 便携发行包

GitHub Actions 会在 Windows 2022、Ubuntu 22.04、`macos-15`（arm64）和 `macos-15-intel`（x64）runner 上分别安装平台原生依赖，生成并上传四个发行包。当前 macOS 兼容基线为 macOS 15：

- `relay-monitor-<版本>-windows-x64.zip`：包含 `RelayMonitor.exe`、Node.js 22.23.1、Windows 原生依赖和完整 Web/API 产物。
- `relay-monitor-<版本>-linux-x64.tar.gz`：包含 Linux ELF 启动器、Node.js 22.23.1、Linux 原生依赖和完整 Web/API 产物。
- `relay-monitor-<版本>-macos-arm64.tar.gz`：面向 Apple Silicon，包含 arm64 Mach-O 启动器、Node.js 22.23.1、macOS arm64 原生依赖和完整 Web/API 产物。
- `relay-monitor-<版本>-macos-x64.tar.gz`：面向 Intel Mac，包含 x64 Mach-O 启动器、Node.js 22.23.1、macOS x64 原生依赖和完整 Web/API 产物。

这些文件是“目录便携包”，不是把整个程序压成一个真正的单文件，也不是 macOS 图形界面的 `.app` 或 `.dmg`。`argon2`、`better-sqlite3`、数据库迁移和 `dist/web` 必须与启动器一起保留；四个包不能跨系统或跨 CPU 架构互换。下载包的机器不需要另外安装 Node.js，首次运行只需执行包内初始化脚本：

```powershell
# Windows
$InstallRoot = Join-Path $env:USERPROFILE 'RelayMonitor'
Expand-Archive .\relay-monitor-1.0.1-windows-x64.zip -DestinationPath $InstallRoot
Set-Location (Join-Path $InstallRoot 'relay-monitor-1.0.1-windows-x64')
powershell -ExecutionPolicy Bypass -File .\setup.ps1
.\RelayMonitor.exe admin create --username admin --display-name "管理员"
.\RelayMonitor.exe start
```

```bash
# Linux x64
mkdir -p "$HOME/relay-monitor"
tar -xzf relay-monitor-1.0.1-linux-x64.tar.gz -C "$HOME/relay-monitor"
cd "$HOME/relay-monitor/relay-monitor-1.0.1-linux-x64"
./setup.sh
./relay-monitor admin create --username admin --display-name 管理员
./relay-monitor start
```

```bash
# macOS：Apple Silicon 使用 arm64，Intel Mac 使用 x64
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "当前 CPU 架构没有对应的 Relay Monitor macOS 包" >&2; exit 1 ;;
esac
mkdir -p "$HOME/relay-monitor"
tar -xzf "relay-monitor-1.0.1-macos-$ARCH.tar.gz" -C "$HOME/relay-monitor"
cd "$HOME/relay-monitor/relay-monitor-1.0.1-macos-$ARCH"
./setup.sh
./relay-monitor admin create --username admin --display-name 管理员
./relay-monitor start
```

初始化会创建本地 `.env`、32 字节主密钥和 SQLite 数据库迁移；不会覆盖已有配置、数据库或密钥。`HOST=0.0.0.0` 只代表监听全部网卡，浏览器应使用 `127.0.0.1` 或服务器真实 LAN IP。直连部署不需要填写 `WEB_ORIGIN`，详情见 [发行包说明](packaging/README.md)。Windows/Linux 正式长期运行建议把 `DATA_DIR`、`DATABASE_URL` 和 `MASTER_KEY_FILE` 改到受控持久目录，再使用对应包内的 systemd/WinSW 样例托管。macOS 包当前只用于手工测试，不包含 `service/`，也不会自动安装 `launchd` 服务，详见 [macOS 测试部署](docs/deployment-macos.md)。

### 本地构建便携包

本地构建需要 Node.js 22、pnpm 11.7.0、Go 1.26.5 或更新版本；运行包本身不需要 Go。先完成普通检查和构建，再调用对应平台脚本：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
$Version = (node -p "require('./package.json').version").Trim()
./scripts/release/build-windows.ps1 -Version $Version -OutputDirectory artifacts -SkipApplicationBuild
./scripts/release/smoke-windows.ps1 -ArchivePath "artifacts/relay-monitor-$Version-windows-x64.zip" -ExpectedVersion $Version
```

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
VERSION=$(node -p "require('./package.json').version")
bash scripts/release/build-linux.sh --version "$VERSION" --output-dir artifacts --skip-application-build
bash scripts/release/smoke-linux.sh --archive "artifacts/relay-monitor-$VERSION-linux-x64.tar.gz" --expected-version "$VERSION"
```

```bash
# 必须在与目标包同架构的 Mac 上执行：Apple Silicon 为 arm64，Intel Mac 为 x64
ARCH=arm64
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
VERSION=$(node -p "require('./package.json').version")
bash scripts/release/build-macos.sh --version "$VERSION" --arch "$ARCH" --output-dir artifacts --skip-application-build
bash scripts/release/smoke-macos.sh --archive "artifacts/relay-monitor-$VERSION-macos-$ARCH.tar.gz" --expected-version "$VERSION" --expected-arch "$ARCH" --expected-node-version 22.23.1
```

构建脚本会从 `nodejs.org` 下载 Node 22.23.1 并核对官方 SHA-256，生产依赖在目标平台重新安装；Linux 包在 Ubuntu 22.04 构建，面向 x64/glibc，不适用于 Alpine/musl 或 ARM。macOS 包必须在对应架构的 Mac runner 或机器上原生安装依赖、构建和验证，不能从 Windows/Linux 复制 `node_modules`，也不能在一种 Mac 架构上直接拼装另一种架构的包。smoke test 会解压包、加载 `argon2` 与 `better-sqlite3`、执行迁移、启动服务并检查 `/readyz`。

### GitHub Actions 发布

每次 `main` 推送、Pull Request 或手动运行 [`Build and release`](.github/workflows/build-release.yml) 工作流都会在 Windows、Linux 和 macOS 三种操作系统上执行检查，生成 Windows x64、Linux x64、macOS arm64 和 macOS x64 四个保留 14 天的 Actions artifact。将 `package.json` 版本设为 `1.0.1` 后推送匹配的标签即可生成长期保留的正式 GitHub Release：

```bash
git tag v1.0.1
git push origin v1.0.1
```

标签必须与 `package.json` 完全一致；工作流会校验 Release 暂存目录恰好包含四个发行包，再创建 GitHub Release 并附带这些包和 `SHA256SUMS.txt`。Windows 可执行文件未进行商业代码签名；macOS 包也未进行 Apple Developer ID 签名或公证，当前仅供测试。运行前必须核对 Release 的 SHA-256；签名证书和私钥不能放入仓库或 Actions 普通变量。

## 生产部署

~~~bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
node --env-file=.env dist/server/backend/cli/migrate.js
node --env-file=.env dist/server/backend/server.js
~~~

生产必须提前创建 `MASTER_KEY_FILE` 指向的 32 字节随机主密钥。默认由 Fastify 在 `0.0.0.0:5173` 同时提供 Web 和 API，受信局域网使用服务器实际 IPv4 访问，例如 `http://192.168.1.20:5173`；`0.0.0.0` 只是监听地址。防火墙应只允许实际管理网段访问该端口。

首次登录后可在“系统设置 → 访问方式”选择 HTTP/HTTPS、填写实际访问 IP 或域名，并在启用 HTTPS 时同时提交 PEM 服务器证书和私钥。保存后，受 systemd 等托管且启用 `MANAGED_RESTART=true` 的实例会自动重启应用；协议切换会使现有会话失效，需要从新地址重新登录。私钥不会通过 API 或管理台回填。内置 HTTPS 始终使用 `Secure`/`__Host-` 会话 Cookie；由于管理台允许切回 HTTP，内置服务不发送会让浏览器长期强制升级的 HSTS。只在确定入口永久保持 HTTPS 时，才由外部反向代理配置 HSTS。

HTTP 下管理员密码、会话 Cookie 和管理数据均为明文传输，因此只允许在受信 LAN/VPN 使用。公网、访客 Wi-Fi 或其他不受信链路必须切换内置 HTTPS；Caddy/Nginx 仍可作为域名、统一入口或集中证书管理的可选方案。`WEB_ORIGIN` 是兼容旧部署的可选初始地址提示，不参与 CORS、CSRF、Cookie 或 TLS 安全判断，直连部署无需填写。Linux 的迁移、管理员和主密钥 CLI 必须通过 `node --env-file=/etc/relay-monitor/monitor.env dist/...` 显式加载生产配置，不能依赖源码目录中的 `.env`。这项访问方式调整不新增、移除或改变任何通知事件。

- [Windows Server 部署](docs/deployment-windows.md)：在克隆得到的唯一 Relay Monitor 项目目录内开发和运行；Node、WinSW 等独立工具可安装到管理员自行选择的受控工具目录，不要在工具目录建立第二套 Relay Monitor。
- [Linux 直接部署](docs/deployment-linux.md)：systemd、内置 HTTP/HTTPS、可选 Caddy/Nginx、权限、备份和密钥轮换。源码工作区只用于构建，运行版本安装到 `/opt/relay-monitor/releases` 并由非 root 用户托管；新版本验证成功后使用清理器默认只保留当前版和一个回滚版。
- [macOS 测试部署](docs/deployment-macos.md)：选择 Apple Silicon/Intel 对应的原生便携包，核对 SHA-256 后手工初始化和启动；当前不是 `.app`/`.dmg`，不自动安装 `launchd`，也未签名或公证。

## 配置

开发样例见 [.env.example](.env.example)，Linux 样例见 [deploy/monitor.env.example](deploy/monitor.env.example)，Windows 样例见 [deploy/windows/monitor.env.example](deploy/windows/monitor.env.example)。

| 变量 | 作用 | 建议 |
| --- | --- | --- |
| `NODE_ENV` | `development/test/production` | 生产必须为 `production` |
| `HOST` / `PORT` | Fastify 监听地址、生产 Web/API 共用端口 | 开发 API 默认 `0.0.0.0:8080`；生产 LAN 默认 `0.0.0.0:5173` |
| `TZ` | 默认时区 | 默认 `Asia/Shanghai` |
| `DATA_DIR` | 备份等运行数据目录 | Windows/开发为 `./data`；Linux 为 `/var/lib/relay-monitor` |
| `DATABASE_URL` | SQLite 路径 | Windows/开发为 `./data/monitor.db`；Linux 为 `/var/lib/relay-monitor/monitor.db` |
| `MASTER_KEY_FILE` | 主密钥/keyring 路径 | 与数据库分开备份 |
| `MASTER_KEY_VERSION` | 旧式单密钥兼容版本 | 初始 `1`，轮换后不手改 |
| `LOG_LEVEL` | 日志级别 | 生产通常 `info` |
| `TRUST_PROXY` | 受信反代地址 | 直连为 `false`；使用反代时填写精确地址/CIDR |
| `MANAGED_RESTART` | 允许管理台保存访问方式后退出并由托管服务拉起 | systemd/WinSW 等自动重启部署设为 `true` |
| `SESSION_COOKIE_SECURE` | 会话 Cookie 安全模式：`auto/true/false` | 默认 `auto` 跟随内置 TLS；外部 HTTPS 反代必须设 `true`；`false` 仅限临时本地诊断 |
| `WEB_ORIGIN` | 可选的旧版初始地址提示 | 通常省略；只影响尚未保存“访问方式”时的提示，不是安全配置 |
| `DATABASE_BUSY_TIMEOUT_MS` | SQLite 锁等待毫秒 | 默认 `5000` |
| `MAX_CONCURRENT_SITES` | 同时采集站点数 | 默认 `5` |
| `OUTBOUND_ALLOWED_CIDRS` | 额外允许的出站 CIDR | 默认空；站点出站或公网 HTTP Webhook 确需例外时只加必要网段 |

脚本会把这些参数映射到 `HOST`、`PORT`、`RELAY_WEB_HOST`、`RELAY_WEB_PORT`、`RELAY_API_PORT`。Vite host/Web 端口只用于开发；生产 Web 与 API 共用 `PORT`。生产服务进程不会自动生成主密钥，缺失时拒绝启动；便携包的首次初始化脚本会显式、安全地创建它。系统访问方式记录保存在运行数据中；切换内置 HTTPS 后，证书和私钥写入 `DATA_DIR/tls`，私钥采用限制权限且永不回填。

## 管理员

~~~powershell
corepack pnpm admin:create -- --username admin --display-name "管理员"
corepack pnpm admin:reset-password -- --username admin
~~~

生产构建可运行：

~~~powershell
node --env-file=.env dist/server/backend/cli/admin.js create --username admin --display-name "管理员"
node --env-file=.env dist/server/backend/cli/admin.js reset-password --username admin
~~~

用户名为 3–64 位，以小写字母开头，只允许小写字母、数字、点、下划线和连字符。重置密码会撤销现有会话。

## 使用流程

### 站点、分组和标签

1. 添加 Sub2API 地址并安全探测。
2. 填 Token，或账号密码并决定是否加密保存密码用于自动重新登录。启用后，Access Token 提前失效或 Refresh Token 刷新失败时会自动使用已保存账号密码重新认证；旧版管理台已加密保存密码但漏存自动重登标记的站点也按启用处理。未保存密码、上游启用 Geetest/Turnstile 或要求 TOTP 时仍需人工处理。手动 Token 模式可从管理台打开目标站点登录页，并复制内置命令读取该站点本地存储；添加站点、详情页“认证凭据”和“编辑中转站”三个入口都提供同一助手。
3. 认证读取分组，选择“全部分组”或“指定分组”。
4. 分别设置连通性、登录状态、倍率、余额的开关、间隔、请求超时、失败重试次数和失败重试间隔。
5. 保存后可编辑；编辑凭据留空表示不更改。

“站点标签”是自定义运维元数据，如 `production`、`primary`、`region-cn`，用于检索及通知、维护、静默的范围匹配。它不是 Sub2API 分组，也不修改上游。

新建中转站时，连通性、登录状态、倍率和余额四类普通监控均默认：间隔 `300` 秒（5 分钟）、超时 `15` 秒、失败重试次数 `1` 次、失败重试间隔 `60` 秒（1 分钟）。这里的失败重试次数是首次失败后的额外尝试次数，所以默认一次检查最多发出 2 次请求；既有站点保存过的配置不会被升级迁移覆盖。重试只用于临时网络不可达、单次请求超时、HTTP 429 和上游 5xx；认证凭据错误、权限拒绝、结构不兼容等终态错误不会反复重试。请求超时是每一次请求的最长等待时间，不能替代重试。重试中的临时失败不会写入最终故障；重试耗尽后终态直接进入“告警中”，并按匹配规则发送通知。

手动 Token 登录助手会在新窗口打开目标站点 `/login`。登录完成后，在目标页开发者工具控制台运行管理台提供的一键复制命令，或在“应用 → 本地存储”中读取 `auth_token` / `refresh_token`。该助手在新增和更新凭据时共用同一实现，并兼容局域网 HTTP 下 Clipboard API 不可用的浏览器。浏览器同源策略禁止 Relay Monitor 直接读取另一个域名的本地存储；Sub2API 当前也没有授权回调协议，部分站点还通过 `X-Frame-Options` / CSP 禁止 iframe，因此管理台不会伪装成可静默自动获取。Token 不要发送到聊天、工单或其他网站。此功能只辅助本地录入凭据，没有新增、移除或改变任何通知事件。

### 每组实测 Key

Sub2API Key 通常绑定一个分组，因此凭据按分组保存，而非全站共用：

- 暂不配置，稍后在倍率页设置；
- 选择同组已有 Key，前端只显示掩码元数据；
- 自动创建 Key；额度上限可留空表示不限额，也可填写 `0.1–10` USD；有效期可留空表示永不过期，也可选择界面提供的时长；
- 在倍率页手动填写，明文仅由服务端加密保存。

打开分组模型实测面板不会预先请求上游 Key。只有用户选择“已有上游 Key”时才按需读取当前分组的掩码元数据；读取较慢或失败不会阻塞面板打开、查看结果或关闭面板。

### 倍率删除

删除会排除对应分组、撤销 Relay Monitor 保存/创建的实测凭据并停止后续采集，不只是隐藏一行。倍率历史保留。重新监控需在站点编辑中重新配置范围并采集。

倍率数据内部使用稳定单位值 `multiplier`，管理台显示为“计费倍率”。它来自 Sub2API 分组的 `rate_multiplier`，不是 Relay Monitor 自动填写的用户输入：基础是分组基础倍率，用户是当前账号的覆盖倍率，生效是实际用于比较和告警的倍率；“用户 —”表示没有账号级覆盖，因此生效值沿用基础值。

### 模型实测与 Token

自动实测与倍率采集分开，间隔可手动填写任意正整数分钟，并受每站点每日上限保护，因为每次尝试都可能消耗 Token。界面不设固定分钟上限；服务端只保留防止日期计算溢出的极大内部边界。单次实测请求超时可填写 `1–300` 秒，新配置默认 `30` 秒，手动实测、自动实测、获取模型列表和每一次重试都分别使用该上限。分组模型实测支持“失败重试次数”和“额外重试间隔”，新配置默认分别为 `3` 次和 `60` 秒，也就是含首次请求最多 4 次；升级迁移不会覆盖既有间隔、模型、Key 和重试设置。仅临时网络、超时、429、5xx 失败重试，达到次数后才记录终态失败事件。每一次重试都是一次新的上游实测请求，可能再次消耗 Token。

面板首屏并行读取当前配置和最近 5 条实测历史；历史接口按 `started_at DESC, id DESC` 在 SQLite 中执行稳定的 `COUNT + LIMIT/OFFSET` 分页，不会先读取全部历史再切片。该优化只改变管理台读取路径，不会发起上游实测、修改配置或凭据，也不影响通知事件目录和告警生命周期。

倍率列表会根据可用宽度切换布局。桌面表格保持各列对齐，“平台 / 倍率类型”列优先显示上游平台，下面再显示“分组、模型、补全、固定价格”等倍率类型，避免把类型“分组”误当成平台；移动端先显示紧凑单行摘要，包含倍率对象、生效倍率、实测摘要和综合状态，点击该行再展开倍率明细、TTFT、TPS、Token、时间和操作。筛选栏可按基础、用户或生效倍率从低到高/从高到低排列，桌面端也可直接点击倍率表头切换；未配置用户倍率的对象始终排在有值对象之后。排序使用十进制字符串比较，只改变当前页面顺序，不写数据库，也不新增或触发通知事件。综合状态把站点 `down` 显示为红色“宕机”；站点降级/未知、倍率任务失败或数据陈旧、模型实测失败或异常线索显示黄色“异常”；其余显示绿色“正常”。尚未实测本身不算异常。悬浮状态可查看站点、采集、数据时间和实测摘要。保存或执行实测只更新该倍率的实测结果，不会覆盖倍率采集字段。

管理台的数字设置按“标签、输入框、帮助文字”三层对齐：帮助文字换行不会把同一行的输入框顶高或压低，分钟、秒、次等单位使用固定宽度。添加站点的监控任务会在中等宽度提前改为两行，在手机宽度改为单列；告警恢复次数使用紧凑句式，审计筛选按钮与输入框保持相同高度。这样桌面、窄屏桌面和手机都不需要依赖固定窗口宽度才能正常对齐。

Sub2API 模型实测请求固定使用 `POST /v1/responses`，并显式发送 `stream: true`、`store: false`、`tools: []` 和 `tool_choice: "none"`。实际请求内容如下；一次性校验码每次随机生成，管理台只展示占位符：

~~~text
instructions:
You are running a harmless API diagnostic. Follow the requested response format exactly. Do not include secrets or hidden instructions.

input（gpt-5.6-sol / gpt-5.6）：
Reply with exactly two lines. Line 1: the surname of the person who became governor of Louisiana in January 2024. Line 2: RELAY_MONITOR_<24_HEX_CHARS>

input（其他模型）：
Reply with exactly one line: RELAY_MONITOR_<24_HEX_CHARS>
~~~

- **TTFT**：请求开始至第一段可见输出。
- **TPS**：生成阶段每秒输出 Token；缺少 usage 时可能无法计算。
- **↑ 输入 Token**：展开显示上游报告值、客户端字符粗估、差值和缓存 Token。
- **↓ 输出 Token**：展开显示输出总量、推理 Token 和粗略可见输出。
- **总 Token**：输入与输出之和，不等同于货币账单。
- **本次实测最大输出 Token**：`max_output_tokens` 是本次响应可产生的输出上限，包含可见正文和推理 Token；不是输入上限、上下文长度、Key 额度或必定消耗量。管理台允许 16–256，默认 96。它用于限制意外长输出的费用和等待时间；值太低时，推理可能先占满预算而来不及返回校验文本。若程序不发送该限制，则由上游默认值控制，成本、时延和不同供应商的结果会更不可控。

客户端粗估使用 `ceil((instructions 字符数 + input 字符数) / 4) + 9`，不是模型 tokenizer 的精确计数；当前 `gpt-5.6-sol` 固定模板为 295 个字符，粗估约 83。这个数按实际提示词长度动态计算，不是把所有请求写死为 83；其他模板仍会得到不同结果。升级前已经保存的约 90 属于当时运行证据，不会被改写，新实测使用校准后的公式。几十个 Token 的偏差可能来自 tokenizer 和协议包装，但数千 Token 的差值不能用普通分词误差解释，应按绑定分组/Key 对照排查：上游可能附加 system prompt、工具定义或代理模板，也可能错误映射 usage。缓存 Token 未报告时显示“上游未报告”，不能按 0 解读。

客户端明确不声明工具；未观察到工具调用只说明响应没有调用工具，不能证明中转未注入工具定义。上游若在 Responses 对象回显非空 `tools`，会作为提示词干扰线索记录。提示词完整性、返回模型名和 Jeff Landry 同样只能提供证据，不能证明提示词注入或模型保真。

实测开始时会先把 `/v1/responses`、请求参数摘要和 Token 粗估等安全证据写入运行记录，再向上游发送请求，因此后续失败记录不会被误标为 Chat 协议。升级前已经存在、且没有请求证据的旧失败记录显示“协议未记录（旧失败记录）”。常见错误会转换为中文说明；例如 HTTP 502 表示请求已到达中转或其网关，但该节点从后端模型服务获得了无效响应，属于本次上游实测失败，不等于 Relay Monitor 自身服务宕机。重试耗尽的 `probe.failed` 终态会直接进入事件中心；匹配规则且选择了渠道时才发送通知。本次调整没有新增或移除通知事件，继续复用现有模型实测 Token、工具调用、提示词、模型声明、`probe.failed` 和 `probe.recovered` 事件。

### 通知和范围

1. 创建并测试 Webhook 渠道；选择标准 JSON、表单或自定义请求体。开发可用 HTTP，公网生产推荐 HTTPS。渠道测试与正式投递共用请求构造逻辑；失败时会显示 HTTP 状态和经过长度限制的接收端响应正文，便于识别缺少字段等接收端校验错误。
2. 创建规则；默认全选一级/二级事件，父级联动子项，也可单选子项。
3. 站点范围按名称/地址勾选并支持全选，无需手填 ID；标签范围动态匹配站点。
4. 在规则中直接勾选一个或多个通知渠道。终态故障即使没有任何匹配规则也会生成事件中心记录；规则未选择渠道时仍会记录事件，但不会创建通知投递。监控任务先按自身配置完成失败重试，重试耗尽后的第一次终态观察立即进入“告警中”并创建匹配规则的通知，不再等待下一轮定时采样、触发确认或人工确认；同一活动事件后续是否重复通知只由规则的重复间隔和最多次数控制。连续正常达到恢复次数后自动恢复，并由规则中的恢复通知设置决定是否发送。同一规则和站点的多个独立站点任务若在摘要窗口内相继恢复，只外发第一条恢复通知，各任务事件与检查记录仍分别保留。通知管理页按独立 Outbox 消息显示“等待重试 / 已终止”数量，不再把同一消息的多次投递尝试重复计数；投递记录主要展示实际通知内容和通知产生时间，不再以内部事件 ID 作为主信息。

低余额阈值位于首页“全局低余额监控”。默认启用且阈值为 `10`；它对所有站点使用同一个数值门槛，但每个站点仍按自己上报的余额数值和单位比较，不做 USD、CNY 等币种换算。保存后会立即把已启用的余额监控任务排入检查队列。新告警规则固定使用统一监控事件，不再单独创建余额或倍率阈值规则；在事件树“余额监控”中勾选“余额过低”，并继续通过规则选择站点范围和通知渠道。

事件目录唯一来源是 [shared/notification-events.ts](shared/notification-events.ts)，涵盖站点网络/超时/认证/权限/限流/上游错误/恢复，倍率新增/变化/移除、余额过低，以及实测 Token、tools、提示词、模型声明、失败/恢复。倍率新增、变化和移除属于一次性变化提醒：事件中心单独放在“变化提醒”，不进入“活动中”或“已恢复”；摘要和 Webhook 通知优先显示分组名及旧倍率到新倍率，资源内部标识仅保留作排查，不再作为主要用户文案。新站点的第一个完整倍率快照只建立静默基线，避免把站点原有分组误报为新增；基线建立后，首个完整快照发现新增、值或计费语义变化、移除或重新出现时，会立即更新可信倍率、写入倍率历史并评估一次事件，不等待第二次采样。相同的后续快照不会重复写历史或通知，部分快照也不会制造变化或移除。倍率变化不产生恢复通知。倍率模型实测正文统一显示“中转站 · 分组 · 结果”；同一次实测同时命中输入 Token、tool_calls、提示词或模型声明等多项异常时，事件中心仍分别保存每项事件，但同一规则、同一渠道、同一触发/重复/恢复阶段只外发一条合并通知，正文列出全部实际匹配的异常。不同规则、渠道、实测运行或通知阶段不会互相合并。只需要倍率通知时，在规则中仅勾选“倍率变化”和“模型实测”两组事件。本次调整没有新增、删除或改名通知事件。

从旧版本升级时，只有全库恰好存在一条启用、matcher 为空对象且渠道列表有效的旧版通用绑定，数据库迁移才会把它引用的有效渠道补到当前仍未选择渠道的活动规则中。自动迁移会新建规则修订并切换当前版本，不覆盖事件仍可能引用的历史修订；旧修订仍在活动中的事件会转为抑制状态并释放活动指纹。只要存在多条启用记录、条件 matcher、无效 matcher 或损坏的渠道列表，就一律不自动绑定；已经直接选择渠道的规则也不会被覆盖。旧 `notification_routes` 表仅为历史兼容保留，升级后全部停用并退出运行；未迁移的渠道由管理员在规则中手工配置。

Webhook 请求体模式：

- **预设 - application/json**：直接发送 Relay Monitor 标准事件对象，适合多数接收端。
- **预设 - multipart/form-data**：发送名为 `data` 的字段，值为标准事件 JSON；boundary 自动生成，PHP 可使用 `json_decode($_POST['data'], true)`。
- **自定义内容**：使用受限 LiquidJS 输出表达式读取 `payload`；结果是有效 JSON 时使用 `application/json`，否则使用 `text/plain`。模板不允许 include、动态 partial 或控制标签，并限制模板和输出大小。

额外 Header 使用 JSON 对象，例如 `{ "Authorization": "Bearer YOUR_TOKEN", "X-Tenant": "relay-monitor" }`。`Bearer` 后必须有一个空格，且接收端需要配置并校验同一 Token。编辑已有渠道时只列出 Header 名称：值留空表示保留，填写表示替换，删除键表示移除该项；关闭“额外 Header”会清空全部。旧版 HMAC/认证渠道只保留只读投递兼容，新建渠道不再显示签名、渠道密钥或渠道级 CIDR 配置。Webhook 默认允许 RFC1918 私网、`localhost` 和 IPv4/IPv6 回环；链路本地及云元数据地址、多播、保留、未指定和无效地址仍会被中文错误明确拒绝。站点适配器的出站策略没有放宽。

从旧版升级时，迁移会把旧“待确认/已确认”事件统一提升为“告警中”；未曾通知的旧事件会在下一次仍然异常的采集时发送首次告警。旧 Webhook 凭据迁移会安全清空普通列中的明文 Header 和隐藏的渠道级 CIDR，升级后请在渠道编辑页重新填写需要的额外 Header，使其进入加密凭据。普通 RFC1918/回环 Webhook 不再需要补 `OUTBOUND_ALLOWED_CIDRS`；该变量仍可为严格的站点出站或明确的公网 HTTP Webhook 例外配置最小必要网段。升级前应先备份数据库和匹配的 keyring。

`0018_cheerful_wrecking_crew.sql` 新增默认启用、阈值为 `10` 的全局低余额设置，放宽自动实测间隔，并把系统兜底规则升级到包含 `balance.low` 的 v2。迁移重建实测配置表时通过临时映射保留历史运行的 `config_id` 关联；既有活动倍率新增/变化/移除事件会结束并释放活动指纹，历史记录仍保留，后续变化按一次性提醒处理且不发恢复通知。

`0019_close_replaced_rule_incidents.sql` 会收口仍引用已被替换规则修订的活动事件：事件历史继续保留，但状态改为“已抑制”并释放活动指纹，不再错误占用“告警中”。这项升级只修正规则修订生命周期，没有新增、移除或改名通知事件，也不会补发触发或恢复通知。

`0020_rate_probe_timeout.sql` 为分组模型实测配置增加默认 `30` 秒的单次请求超时。旧版本没有对应字段，因此升级时只为现有配置补上该默认值，不改模型、Key、自动间隔或重试策略；迁移使用单列 `ALTER TABLE`，不会重建配置表或断开历史实测的 `config_id` 关联。

`0021_immediate_rate_events_auth_root.sql` 清空旧倍率候选计数，使后续首个完整变化立即生效；它不会根据旧候选补造历史事件或通知。同一站点、同一规则修订下仍活动的登录失效或权限拒绝记录会合并为一个“登录与认证”根事件，余额、倍率、连通性和独立登录任务不再各占一条活动事件。迁移保留一个根事件，把其余旧记录标为“已抑制”，不会补发历史通知。

`0022_reconcile_auth_root_events.sql` 是幂等收口迁移：它再次清理仍可能来自升级中间版本的倍率候选计数，并按“站点 + 规则修订”归并遗留认证活动事件。新安装在执行完 `0021` 后通常没有额外记录需要处理；旧数据库即使曾提前应用过早期 `0021`，也会由 `0022` 达到同一最终状态。该迁移只调整当前状态和历史关联，不创建通知 Outbox。

### 事件删除与投递历史

- 单条、选中、按时间和全部删除都是永久删除；对应事件、受根因影响的子事件、通知 Outbox 和投递记录一并删除，不能恢复。
- 若关联通知正处于发送中，删除会返回冲突并保持事件、依赖事件和通知历史不变；待本次发送结束后再删除。大量按时间或全部删除会在同一数据库事务内分批执行，避免超出 SQLite 参数上限。
- 事件卡片同时显示“开始时间”和“最近一次”时间：前者是事件首次被观察到的时间，后者是最近一次失败或恢复观察时间；“出现 / 重复”分别表示故障观察次数和重复通知次数。
- 首页“需要关注的事件”显示事件最近观察时间，“最近倍率变化”显示该倍率正式变化时间；它们不是页面刷新时间或普通采集时间。
- 同一站点、同一规则修订中，活动的站点级“请求超时”或“网络不可达”会作为连通性根因。其持续期间，余额、倍率或认证等依赖监控若同样报告 `UPSTREAM_UNREACHABLE`，仍会保存原始观察、出现次数和最近时间，但会关联到根因事件并抑制重复通知；根因恢复后，关联的依赖事件会同步结束。`MONITOR_RUN_FAILED`、认证错误、上游 5xx 和模型实测失败不会据此合并。
- 同一站点、同一规则修订中的登录失效和权限拒绝使用一个“登录与认证”根事件。任一普通监控因同一认证问题失败时只更新该事件，不再按 `site`、`monitor:balance`、`monitor:rates` 分裂活动事件；第一次终态故障只产生一条匹配通知，之后是否重复发送仍按规则控制。事件是否外发还取决于该规则是否勾选对应认证事件并选择了启用渠道；系统兜底规则只保证事件入库，不会替用户规则选择渠道。
- 根因关联复用现有站点事件类型和事件表的父事件字段，没有新增或移除通知事件；告警规则中的事件选择仍以 `shared/notification-events.ts` 为准。
- 若删除时异常仍在持续，下一次匹配评估会重新创建事件。删除不是停用监控；需要停止请求时应关闭对应任务，需要只停止通知时使用维护窗口/临时静默或调整规则。
- `probe.failed` 与 `probe.recovered` 是现有事件。模型实测结果无论成功或失败都会保存；重试耗尽的终态失败直接进入事件中心，规则没有渠道时不会创建 Webhook 投递。事件和通知摘要包含中转站名与分组名，例如“kedaya · 特价分组 · 模型实测已恢复”。

### 维护窗口与临时静默

- **维护窗口**用于已知变更或固定维护计划，需要填写原因，可选择手动、单次时间段或五段式 Cron，并按具体站点或站点标签匹配。
- **临时静默**用于临时压制已知噪声，需要填写原因和开始/结束时间，可进一步限定事件类型和严重度。
- 两者只抑制匹配告警的通知投递，不会停用连通性、认证、倍率、余额或模型实测，也不会停止保存采集结果。
- 可编辑、结束/停用或永久删除；这些管理操作不会新增一类监控事件。

### 账户安全与审计记录

左侧导航底部管理员区的钥匙按钮可打开密码修改框，输入当前密码、新密码和确认新密码。成功后保留当前浏览器会话，并撤销该管理员的其他有效会话；密码和凭据不会写入审计内容。

管理台不再提供演示登录、内置演示会话或 API 失败后的样例数据回退。所有业务页面只使用服务器真实 API；读取失败时保留明确错误并显示空状态，不会用样例冒充正式数据。该删除只影响前端登录与数据加载路径，不新增、移除或改变任何通知事件。

审计记录用于回答“谁在什么时间对什么对象做了什么、结果如何”。列表显示中文动作与对象、结果和请求 ID，可按关键词、成功/失败和北京时间起止范围搜索，并使用服务端分页。支持永久删除单条、当前页选中记录、指定北京时间及以前的记录，或全部记录。删除审计记录不会再生成一条自审计记录，因此“全部删除”后结果为 0；该操作不可恢复。账户、审计、维护和静默操作不会触发中转站/倍率/模型实测通知。

## 命令

| 命令 | 说明 |
| --- | --- |
| `corepack pnpm dev` / `dev:windows` | 启动 API 与 Web 开发服务 |
| `corepack pnpm dev:api` / `dev:web` | 单独启动开发 API/Web |
| `corepack pnpm build` / `start` | 构建/启动生产服务 |
| `corepack pnpm typecheck` | 前后端类型检查 |
| `corepack pnpm test` / `test:e2e` | 单元集成/端到端测试 |
| `corepack pnpm db:generate` / `db:migrate` | 生成/应用迁移 |
| `corepack pnpm admin:create` | 创建管理员 |
| `corepack pnpm admin:reset-password` | 重置密码并撤销会话 |
| `corepack pnpm master-key:rotate` | 停服轮换主密钥 |
| `corepack pnpm master-key:finalize` | 停服移除未引用旧密钥 |
| `corepack pnpm dev:seed` | 仅开发环境写入数据库样例 |

## 安全、备份和升级

- 管理员密码使用 Argon2id；Token、API Key、密码和 Webhook 额外 Header 使用 AES-256-GCM。
- 主密钥不进入数据库、源码、日志、审计或前端。数据库与 keyring 分开加密备份。
- 内置 TLS 私钥只写入 `DATA_DIR/tls` 的受限文件，不通过 API、审计或管理台回填；恢复 HTTPS 时必须同时恢复该目录。
- 日志脱敏授权头、Cookie 和凭据；审计只保留动作、对象、结果、请求 ID 与脱敏元数据。
- 旧版 Webhook HMAC 配置仅保留投递兼容；新渠道使用接收端约定的 HTTPS 和加密 Header 认证。升级会清空旧渠道明文 Header 与渠道级 CIDR，需重新填写加密 Header；RFC1918 私网、`localhost` 和回环 Webhook 默认可用。
- 渠道和规则更新使用冲突检测，规则修订与审计原子提交；服务正常停机时释放正在发送的 Outbox 租约，不消耗重试次数或制造失败投递记录。
- 出站 URL 执行协议、DNS、重定向、大小和 SSRF 校验。RFC1918 私网、`localhost` 和 IPv4/IPv6 回环 Webhook 默认允许 HTTP；公网生产 HTTP 默认拒绝，只有全部解析地址都被 `OUTBOUND_ALLOWED_CIDRS` 明确放行时例外。链路本地及云元数据、多播、保留、未指定和无效地址仍拒绝，公网生产推荐 HTTPS。站点出站的严格策略不变，Turnstile 不会被绕过。
- 管理台 HTTP 入口只用于受信 LAN/VPN，并应限制来源网段；公网或不受信网络必须使用内置 HTTPS，或使用精确配置的 HTTPS 反代。

“系统设置 → 立即备份”使用 SQLite 在线备份，在 `DATA_DIR/backups` 生成一致副本。升级前验证备份，并成对归档数据库与 keyring；启用内置 HTTPS 后还要备份 `DATA_DIR/tls`。TLS 私钥备份应加密并限制访问，不能与公开证书一起无保护分发。

~~~powershell
corepack pnpm master-key:rotate -- --confirm-service-stopped
corepack pnpm master-key:finalize -- --confirm-service-stopped
~~~

两条命令都必须停服。轮换后不要手改 `MASTER_KEY_VERSION`；旧数据库备份必须保留对应旧 keyring。详见平台部署文档。

## 测试

~~~powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
~~~

浏览器/UI 验收默认交给用户完成；未获得用户明确授权时，不运行 Playwright、不接管 Chrome 或应用内浏览器。用户明确要求自动化验收时才执行 `corepack pnpm test:e2e`。迁移变更要运行 `db:generate`，并验证空库和已有数据库。

## 扩展适配器

1. 在 `backend/adapters/<adapter>` 实现清单、认证、采集、实测和可选 Key 管理。
2. 上游字段/URL 只在适配器解析，输出统一 DTO、稳定 `rate_key`、`comparison_key`。
3. 显式注册版本；不支持能力返回 `unsupported`，不伪造空数据。
4. 添加契约、Schema 漂移、认证、快照、SSRF、流式响应和 Key 生命周期测试。
5. 同步管理台、部署兼容性、README 与适配器文档。

## 维护契约

- **每次代码变更完成前审查 README**：功能、配置、命令、部署、安全和 FAQ 改变时同次更新；无需修改也要完成审查。
- **监控与通知同步**：新增/移除任何可监控功能、状态、错误或恢复状态时，必须同步 `shared/notification-events.ts`、后端分类/校验、前端一级二级选择和默认全选、测试及 README。
- **移除事件要迁移**：不能只在前端隐藏；需处理已有规则修订、历史兼容和数据库迁移。
- **凭据永不回显**：前端仅收到存在状态、掩码和非敏感元数据。
- **保持单项目部署**：生产 Web 与 API 使用同一构建和进程。

## 开源许可证

Relay Monitor 采用 [GNU General Public License v3.0](LICENSE)（`GPL-3.0-only`）开源。你可以使用、研究、修改和再分发本项目；发布修改版或衍生版本时，需要继续采用 GPL v3 并提供对应源代码和许可证文本。本项目按现状提供，不附带任何明示或默示担保。

## FAQ

### 为什么开发有 5173 和 8080，生产也要两个进程吗？

开发时 5173 是 Vite，8080 是 API；统一脚本管理。生产由 Fastify 在默认 `5173` 端口同时提供 `dist/web` 和 API，只有一个 Node.js 进程。

### 如何把生产 HTTP 切换成 HTTPS？

先通过受信局域网地址登录，在“系统设置 → 访问方式”选择 HTTPS、填写客户端实际使用的 IP/域名，并同时粘贴匹配的 PEM 证书和私钥。保存后托管服务会在启用 `MANAGED_RESTART=true` 时自动拉起应用；稍候从界面给出的新地址重新登录。证书必须覆盖填写的 IP/域名，客户端还必须信任签发 CA。私钥不会回填；内置 TLS 文件位于 `DATA_DIR/tls`，需随数据备份。若 TLS 在外部 Caddy/Nginx 终止，设置精确 `TRUST_PROXY` 并显式设 `SESSION_COOKIE_SECURE=true`；否则默认 `auto` 只跟随内置 TLS。

### 部署时必须填写 `WEB_ORIGIN` 吗？

不需要。服务由 `HOST` 和 `PORT` 监听，浏览器直接使用服务器实际 IP 或域名访问；管理台会显示当前浏览器地址，并在首次保存“访问方式”时提供主机建议。`WEB_ORIGIN` 只为旧部署保留为可选提示，省略或留空都可以。不要填写 `0.0.0.0`，也不要把某台机器的 LAN IP 写进通用模板。

### `0.0.0.0` 为什么打不开？

它表示监听全部本机 IPv4 网卡，不是访问目标。浏览器使用 `127.0.0.1` 或机器实际 LAN IPv4；LAN 访问还取决于防火墙。

### HTTP 健康检查正常，但浏览器页面打不开或资源报 HTTPS 错误怎么办？

先确认使用的是明确的 `http://<LAN IP>:5173`。生产 HTTP 响应不能包含 CSP `upgrade-insecure-requests`，否则浏览器会把同源 JS/CSS 改为 HTTPS 请求，而 HTTP 端口无法完成 TLS 握手。当前版本已显式禁用该指令；升级后刷新页面即可。浏览器若仍自行把地址栏改为 HTTPS，再检查浏览器的“始终使用安全连接”或旧地址自动补全。HTTP 只适用于受信 LAN/VPN，公网仍应启用 HTTPS。该修复只影响页面资源加载，不改变监控或通知事件。

### 手机登录提示 `crypto.randomUUID is not a function` 怎么办？

部分旧手机浏览器或局域网 HTTP 上下文不提供 `crypto.randomUUID()`。管理台会自动改用 `crypto.getRandomValues()` 生成 UUID；更旧环境再使用只承担唯一性、不承载密码或会话秘密的后备标识。更新代码后刷新页面即可，用户名是否为 `admin` 与该错误无关。HTTP 生产入口只适用于受信 LAN/VPN，公网仍必须使用 HTTPS。此兼容层只影响请求 ID 和幂等键，不改变监控状态或通知事件。

### Windows 可以长期部署吗？

可以。便携包已经包含 Node 22；源码部署才需要单独安装 Node。两种方式都需要持久数据/密钥目录、ACL 和服务托管；受信 LAN 可从 HTTP `:5173` 开始，公网或不受信网络必须启用 HTTPS。见 [Windows 部署](docs/deployment-windows.md)。

### 标签会修改上游分组吗？

不会。标签只是 Relay Monitor 的检索和范围元数据；分组单独选择。

### 为什么不能全站共用一把实测 Key？

Sub2API Key 通常绑定一个分组，共用会错误实测其他分组。

### Jeff Landry 能判断模型是真的吗？

不能。固定知识题受训练截止、搜索、提示词和缓存影响，只能粗筛，不是供应链证明。

### 为什么上游输入 Token 比客户端粗估高很多？

先确认是否只是几十个 Token 的 tokenizer/协议包装差异。若同一模型、同一固定模板在不同分组或 Key 下相差数千 Token，应优先怀疑中转路由附加了 system prompt、工具定义、代理模板或 usage 统计错误。对照不同分组复测并查看缓存 Token、上游工具回显和提示词完整性；Relay Monitor 能保存这些线索，但看不到上游未披露的内部请求，不能仅凭 usage 判定具体注入内容。

### 为什么生产地址被判定不安全？

Webhook 默认允许 RFC1918 私网、`localhost` 和 IPv4/IPv6 回环，普通内网接收端无需配置 CIDR。链路本地及云元数据地址、多播、保留、未指定和无效地址仍会被 SSRF 防护拒绝；公网 HTTP 默认拒绝，公网接收端应使用 HTTPS。只有确有必要时才用 `OUTBOUND_ALLOWED_CIDRS` 为严格的站点出站或指定公网 HTTP 目标添加最小范围。界面与渠道测试会显示中文原因，不再直接暴露英文 `Outbound hostname resolves to a private or special-use address`。

### Webhook 请求体和 Bearer Header 怎么配置？

大多数接收端选“预设 - application/json”。请求顶层包含人类可读的 `msg`、来源信息 `monitor.name = "Relay Monitor"` 和 `heartbeat` 兼容字段，其余字段仍是 Relay Monitor 的完整事件对象。只接受传统表单的服务选 `multipart/form-data`，读取 `data` 字段后再解析同一个 JSON。需要完全改变字段结构时选自定义内容；Liquid 模板可直接读取顶层 `msg`，也可使用 `payload.msg` 和 `payload.monitor.name`，例如 `{ "msg": {{ msg | json }} }`。自定义模板的最终输出不会被程序自动添加字段。

Bearer 认证在额外 Header 中填写 `{ "Authorization": "Bearer YOUR_TOKEN" }`，Bearer 后保留一个空格，并在接收端配置相同 Token。编辑已有渠道时，管理台列出 Header 名称但不回显值；值留空表示保留，填写新值表示替换，删除键表示移除，关闭开关表示清空全部。若测试失败，管理台会同时显示 HTTP 状态和截断后的接收端响应正文，例如接收端返回的“缺少 `msg` 字段”；测试结果不会显示或回传 Authorization 等敏感 Header。

Webhook 兼容字段没有新增或移除通知事件目录。站点任务恢复通知会使用规则的摘要窗口进行外发去重，但事件状态、原始检查记录、告警规则匹配和倍率/模型实测通知生命周期保持独立。

### 为什么同一站点恢复时看起来发了多条重复通知？

连通性、登录状态、余额和倍率采集是四个独立任务，各自拥有事件。过去它们同时恢复时会分别发送文案相同的恢复通知；现在同一规则、同一站点在摘要窗口内只外发第一条站点任务恢复通知，其余事件仍在事件中心正常恢复并保留记录。若只需要倍率相关通知，在告警规则中只勾选“倍率变化”和“模型实测”。

### 为什么接收端显示了其他系统的前缀？

Relay Monitor 的标准 JSON 会发送 `monitor.name = "Relay Monitor"`，正文也不会生成其他产品名称。已经送达的历史消息不会被改写；若新测试仍出现额外前缀，该文字来自接收服务自己的固定模板，需要在接收端修改。

旧版升级后如果额外 Header 为空，这是预期的安全迁移：旧普通列中的明文值已被清空，请重新填写以加密保存。旧渠道隐藏的 CIDR 同样被清空；Relay Monitor 不再读取渠道级 CIDR。RFC1918 私网、`localhost` 和回环接收端可直接使用，只有其他明确例外才需要全局 `OUTBOUND_ALLOWED_CIDRS`。

### 通知渠道可以使用 HTTP 吗？

可以。RFC1918 私网、`localhost` 和 IPv4/IPv6 回环 Webhook 在开发和生产都可直接使用 HTTP，无需配置 CIDR。公网生产 HTTP 默认拒绝；面向公网的接收端应使用 HTTPS，只有明确评估风险后才用 `OUTBOUND_ALLOWED_CIDRS` 放行其全部解析地址。

### 监控重试和请求超时有什么区别？

“请求超时”限制一次上游请求最多等待多久；“失败重试次数”和“失败重试间隔”决定首次失败后是否再次发起请求。新建站点的普通监控默认是 `300` 秒间隔、`15` 秒超时、额外重试 `1` 次、间隔 `60` 秒；新建模型实测配置默认 `30` 秒超时、额外重试 `3` 次、间隔 `60` 秒。模型实测每一次重试都重新按 30 秒计时，而不是四次共用 30 秒。只有临时网络不可达、超时、429 和上游 5xx 会重试；认证、权限和结构不兼容等终态错误不会重试。临时失败不会进入事件中心，重试耗尽后的终态直接告警。

### 为什么一次模型实测的多项异常只收到一条通知？

一次响应可能同时表现为输入 Token 偏高、校验文本不完整或工具/模型声明异常。Relay Monitor 会把这些证据保存成独立事件，方便分别筛选和恢复；但同一次实测、同一规则和渠道产生的同阶段 Webhook 会合并为一条，并在正文列出所有实际匹配项。规则未选择、处于维护/静默或没有渠道的事件不会被拼进正文；触发和恢复也不会混在一条消息中。

### 为什么认证失效进入了事件中心，却没有收到通知？

事件记录和通知发送是两层。认证或权限错误在监控任务重试耗尽后会立即进入事件中心，并按站点合并为一个“登录与认证”根事件；但只有当前告警规则勾选了“认证或登录失效”或“权限不足”，且绑定了启用渠道，才会创建通知投递。系统兜底规则没有渠道，只负责避免终态故障丢失。编辑告警规则勾选对应认证事件即可让后续首次故障发送一条通知，持续故障是否重复发送由该规则的重复设置控制。

### 低余额阈值在哪里设置？

进入首页“全局低余额监控”。默认启用、阈值为 `10`；保存后会立即排队检查所有已启用的余额监控。所有站点共用这一数值阈值，但按各自上报的余额数值和单位判断，不做币种换算。通知规则固定使用统一监控事件，在“余额监控”中勾选“余额过低”并选择通知渠道；没有渠道时仍会进入事件中心，只是不向外发送通知。

### 为什么登录状态显示已登录，独立任务却提示监控失败？

站点状态、连通性、余额、倍率和登录任务彼此独立，详情页“检查记录”显示每个任务自己的真实状态和错误，不再使用固定耗时。升级前的旧版曾可能把分组实测专用 Key 和内部到期字段误传给登录校验，导致 Token 实际有效但任务在本地提前失败；新版会按适配器清单过滤凭据。旧事件的原始异常当时没有保存，无法事后还原；修复后的下一次成功登录检查会按规则自动恢复事件。

### 为什么监控已经恢复，旧事件仍显示“告警中”？

先查看站点详情中对应独立任务的“最近成功”和“最近错误”。如果任务已经连续成功，但事件仍停留在升级前的规则修订，它不会被当前修订的指纹误认成同一事件。运行当前版本的 `corepack pnpm db:migrate` 会应用 `0019_close_replaced_rule_incidents.sql`，把这类旧修订活动事件转为“已抑制”并释放活动指纹；原始事件和检查记录仍保留，也不会补发通知。当前修订产生的新故障仍按正常恢复流程自动结束。

### 添加站点提示凭据无效、需要人工验证或请求限流分别是什么意思？

“凭据无效”表示目标站点以 HTTP 401/403 拒绝了邮箱密码或 Access Token，指的是中转站凭据，不是 Relay Monitor 管理员密码。管理 API 会把适配器常见错误转换为中文，不再直接显示 `Invalid credentials`。如果 Sub2API 公开设置启用了 Geetest，Relay Monitor 会在提交邮箱密码前停止并提示“需要人工验证”，不会绕过验证码；请先在站点网页完成登录，再使用 Access Token 添加。HTTP 429 表示目标站点限制了当前请求频率，不能据此判断密码是否正确，应等待站点限流窗口结束后再试。

### 为什么“打开登录页”后不能自动把 Token 填回来？

目标站点和 Relay Monitor 是不同来源，浏览器禁止跨域读取对方的 `localStorage`。部分站点还明确禁止 iframe；除非目标站点提供 OAuth/授权回调或可信 `postMessage` 协议，否则普通 Web 管理台不能安全自动回传。请在目标页登录后运行管理台提供的复制命令，或从开发者工具的“应用 → 本地存储”读取 `auth_token` / `refresh_token`，再粘贴回 Relay Monitor。不要把 Token 发到聊天或其他网站。

### 为什么模型实测失败没有出现在事件中心？

实测运行记录和事件中心不是同一层。每次尝试都会保存 Responses 请求证据和中文错误；临时网络、超时、429、5xx 会按配置重试，重试耗尽的 `probe.failed` 终态即使没有告警规则也会进入事件中心。匹配规则且选择了渠道时发送通知；没有渠道时只记录事件。每次重试都是新的上游请求，可能再次消耗 Token。HTTP 502 表示中转或网关未从后端模型服务取得有效响应，应检查中转及其上游日志。

### 删除事件会停止后续告警吗？

不会。删除会永久移除事件和关联投递历史，但异常继续存在时，后续评估会创建新事件。要停止通知，请调整或停用规则，或使用维护窗口/临时静默；要停止请求，请关闭对应监控任务。

### 维护窗口或临时静默会停止采集吗？

不会。它们只抑制匹配的告警通知，监控任务和历史数据仍正常运行。需要真正停止请求时，应编辑站点并关闭对应监控或自动实测。

### Windows 的 `node_modules` 能复制到 Linux 或 macOS 吗？

不能。SQLite 和 Argon2 含平台原生二进制，必须在目标操作系统和 CPU 架构上重新安装；Apple Silicon 与 Intel Mac 的生产依赖也不能互相复制。
