# 开发说明

## 目录边界

```text
backend/
  adapters/     版本化适配器、上游客户端和统一 DTO
  core/         调度、快照、告警、通知与安全基础能力
  db/           Drizzle Schema、迁移和 SQLite 连接
  routes/       Relay Monitor 管理 API
  cli/          管理员、迁移和运维命令
frontend/
  src/          Vue 管理台
shared/         前后端共享的稳定领域类型
deploy/         systemd、Windows 服务、内置 TLS 与可选反向代理样例
packaging/      原生启动器、便携包初始化与服务样例
scripts/release Windows/Linux/macOS 打包和解压 smoke test
.github/        Windows、Linux、macOS CI、artifact 与标签 Release
tests/          单元、集成和端到端测试
data/           Windows 本地数据库、主密钥和依赖缓存（不提交）
```

核心层不能引用任何 Sub2API URL 或上游字段。所有差异都必须停留在 `backend/adapters/sub2api` 中；调度、事件、通知、存储和前端只消费统一 DTO。

## Windows 启动

Windows 开发环境是一个项目、一个数据目录和一个启动命令。`data/` 保存 SQLite、主密钥与本项目依赖缓存，它不是另一套服务。

```powershell
.\scripts\dev.ps1 -SkipInstall
```

脚本默认监听 `0.0.0.0`，并在同一个终端中启动 Fastify API（端口 `8080`）和 Vite Web（端口 `5173`）。`0.0.0.0` 只是监听地址；本机访问 `http://127.0.0.1:5173`，局域网设备访问脚本打印的实际 LAN IPv4 URL。

可以分别指定监听地址、Web 端口和 API 端口：

```powershell
.\scripts\dev.ps1 -ListenAddress 0.0.0.0 -WebPort 5173 -ApiPort 8080 -SkipInstall
```

脚本将参数映射为 `HOST`、`PORT`、`RELAY_WEB_HOST`、`RELAY_WEB_PORT` 和 `RELAY_API_PORT`，Vite 代理会跟随 API 端口。按一次 `Ctrl+C` 会同时停止两个进程。只有首次缺少依赖时才去掉 `-SkipInstall`，依赖缓存仍写入 `data/pnpm-store`。

局域网访问只应用于受信开发网络。Windows 防火墙应限定专用网络和来源网段，开发端口不能直接暴露公网。生产构建不再运行 Vite：Fastify 默认在 `0.0.0.0:5173` 同时提供 Web 和 API，受信 LAN 可直接使用 HTTP，公网或不受信网络必须启用 HTTPS。

## 原生发行构建

发行工作流覆盖 Windows、Linux 和 macOS 三种操作系统，产出四套目录便携包：Windows x64、Linux x64、macOS arm64 和 macOS x64。macOS 分别使用 `macos-15` arm64 和 `macos-15-intel` x64 runner，并固定 `MACOSX_DEPLOYMENT_TARGET=15.0`；当前只把 macOS 15 作为兼容基线。每个 job 必须在目标系统上重新安装生产依赖，并在归档后重新解压执行 smoke test；`argon2`、`better-sqlite3` 等原生模块不能从其他操作系统复制。macOS 两种架构同样必须在对应架构的 runner 或机器上原生构建，不能在 Apple Silicon 上直接复制依赖拼装 Intel 包，反之亦然。

macOS 本地构建需要 Node.js 22、pnpm 11.7.0 和 Go 1.26.5 或更新版本。Apple Silicon 设为 `arm64`，Intel Mac 设为 `x64`，并保证参数与当前机器架构一致：

```bash
ARCH=arm64
VERSION=$(node -p "require('./package.json').version")
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
bash scripts/release/build-macos.sh --version "$VERSION" --arch "$ARCH" --output-dir artifacts --skip-application-build
bash scripts/release/smoke-macos.sh --archive "artifacts/relay-monitor-$VERSION-macos-$ARCH.tar.gz" --expected-version "$VERSION" --expected-arch "$ARCH" --expected-node-version 22.23.1
```

构建脚本固定下载并核对官方 Node.js 22.23.1 runtime。smoke test 必须至少核对包结构和许可证、启动器/Node/原生模块架构、数据库迁移、SQLite 完整性、`/readyz` 与 Web 页面。标签发布阶段必须确认汇总目录恰好存在四个发行包，再生成并复核 `SHA256SUMS.txt`；不得把缺包或多包的目录发布为 Release。

当前 macOS 交付物只用于命令行测试：它不是 `.app` 或 `.dmg`，不自动安装 `launchd`，也未进行 Apple Developer ID 签名或公证。安全使用和首次启动步骤见 [macOS 测试部署](deployment-macos.md)。发行构建本身不改变通知事件目录。

## 生产访问方式契约

- 初始生产监听由 `HOST` 和 `PORT` 提供，部署样例为 LAN HTTP `0.0.0.0:5173`；浏览器必须使用实际 IP/域名而不是 `0.0.0.0`。`WEB_ORIGIN` 仅是兼容旧部署的可选初始提示，不参与安全判断；未保存访问方式时，前端只把 `window.location.hostname` 作为表单建议，不自动持久化。
- 管理员在“系统设置 → 访问方式”选择 HTTP/HTTPS 和访问主机。HTTPS 必须同时提交匹配的 PEM 证书与私钥；私钥永不通过读取 API 或管理台回填，生效副本存放在 `DATA_DIR/tls` 并使用限制权限。
- 保存协议、主机或证书后需要进程重启。`MANAGED_RESTART=true` 只表示当前服务由 systemd/WinSW 等自动拉起机制托管；无法自动拉起时 API/UI 必须明确返回“需要重启”，不能假装已经生效。协议切换后要求重新登录。
- 内置 TLS 生效时始终使用 `Secure`/`__Host-` Cookie，不允许 `SESSION_COOKIE_SECURE=false` 降级。默认 `auto` 不根据 `NODE_ENV` 推断；外部 Caddy/Nginx 终止 TLS 时必须显式设为 `true`，配置精确 `TRUST_PROXY` 并转发正确的 Host/协议头。内置服务允许切回 HTTP，因此不发送持久 HSTS；只有确定入口永久保持 HTTPS 时才由外部代理配置 HSTS。显式 `false` 只用于临时 HTTP 本地诊断。
- HTTP 会明文传输管理员密码、会话和管理数据，只允许受信 LAN/VPN。公网暴露必须使用 HTTPS、防火墙和最小访问范围。
- 访问方式属于服务运行与安全配置，不新增、移除或改变 `shared/notification-events.ts` 中的任何通知事件。

## 数据规则

- 数据库时间使用 UTC RFC 3339 文本，前端按管理员时区显示。
- 倍率和金额从上游响应文本经无损 JSON 解析后立即转换为 Decimal。
- `"0.12"` 与 `"0.120"` 必须等价。
- 只有完整倍率快照才能建立或推进可信基线；部分快照不能制造归零、移除或变化事件。
- 最低/最高只在同一 `comparison_key` 内计算。

## 任务规则

产品界面和内部任务都将连通性、认证、倍率、余额作为四类可独立配置的监控。每个 `(site_id, monitor_type)` 只有一个持久化任务，同一站点的上游请求串行执行；模型实测使用独立计划，并与普通采集共享站点并发保护。

新建站点的四类普通监控统一默认间隔 `300` 秒、超时 `15` 秒、首次失败后的额外重试 `1` 次、重试间隔 `60` 秒；界面文案为“失败重试次数”和“失败重试间隔”。数据库迁移只改变新行默认值，已有配置保持原值。分组模型实测使用独立计划，间隔允许任意正整数分钟，界面不设固定分钟上限；服务端只保留防止 JavaScript 日期计算溢出的极大内部上限。新配置的单次请求超时、失败重试次数和间隔默认 `30` 秒 / `3` 次 / `60` 秒；超时可配置 `1–300` 秒，手动、自动、模型列表和每一次重试分别计时。普通监控把重试到期时间和已用次数持久化到任务调度状态，不在进程内等待；模型实测在同一逻辑运行中使用可取消的异步等待，并持续刷新运行心跳，服务停止时会中止尚未发出的尝试。重试范围仅包括临时网络不可达、单次请求超时、HTTP 429 和上游 5xx，认证凭据错误、权限拒绝和结构不兼容等终态错误不重试。超时只限制单次请求最长等待时间，不能代替重试。

只有成功或重试耗尽后的终态结果才能写入最终监控快照和故障状态。临时失败不进入事件中心；重试耗尽后的第一次终态观察直接进入 `firing`，不等待下一轮定时采样、触发确认次数或人工确认，API 和 UI 也不提供“待确认/已确认”状态。同一活动事件的重复通知仅由规则的 `repeat_interval_seconds` 和 `max_repeats` 控制。即使没有告警规则也必须记录事件；匹配规则且绑定渠道时立即创建通知队列消息，没有渠道时只记录事件。恢复按规则配置的连续正常次数自动判定，并由恢复通知设置决定是否投递。分组模型实测的每一次重试都是一次新的上游请求，可能再次消耗 Token。

Sub2API 自动创建分组实测 Key 时，`quota_limit` 和 `expires_in_seconds` 都是可选字段。额度留空表示不限额，也可填写 `0.1–10` USD；有效期留空表示永不过期，也可选择管理台提供的时长。站点向导和倍率页实测弹窗必须保持同一语义，服务端只在用户选择了限制时向适配器发送对应字段。

## 余额告警与一次性变化事件

`balance_alert_settings` 是 `id = 'global'` 的单例配置，默认启用、阈值为 `10`。余额观察按每个站点自己上报的数值和单位与全局阈值比较，不做币种换算；保存配置后把已启用的余额监控任务立即排入调度队列。新通知规则固定为 `monitor_events`，事件树包含 `balance.low` 并默认全选，不再创建参数化余额或倍率阈值规则。

`rate.changed`、`rate.added` 和 `rate.removed` 是一次性变化提醒，不参与活动故障的恢复生命周期。首个完整快照只建立静默可信基线；基线之后，新增、值/计费语义变化、移除和重新出现都由第一次观察到它们的完整快照立即接受：同一事务先更新 `rates_current`、写 `rate_history`，再评估一次告警。后续内容相同的完整快照只更新时间，不重复写历史或 Outbox；部分快照只记录质量，不能制造变化或移除。兼容列 `candidate_value`、`candidate_count` 和 `missing_count` 暂时保留，但运行时始终清空，不再参与确认。事件中心把倍率变化放入独立“变化提醒”视图，不计入“活动中”或“已恢复”，也不发送恢复通知。事件详情和通知载荷保留技术资源标识用于排查，但面向用户的标题/摘要应显示分组名以及旧倍率到新倍率；倍率列表的“平台 / 倍率类型”列以平台为主、类型为辅。本次顺序调整不改变 `shared/notification-events.ts` 的事件目录。

健康观察中的 `site.auth_expired` 和 `site.permission_denied` 共用站点级 `auth` 资源和同一活动指纹。同一站点、同一规则修订下，连通性、登录状态、余额和倍率任务报告的认证终态只推进一个认证根事件；旧版按任务资源拆出的活动事件由 `0021` 合并，其余记录保留为 `auth_root_cause_merged` 抑制历史。第一次终态只创建一条匹配规则的通知，后续重复仍由规则控制。认证事件是否外发严格取决于规则事件选择和渠道；系统 fallback 没有渠道，只负责事件持久化。

## Webhook 请求格式

新渠道支持三种请求体：

- `json`：`Content-Type: application/json`。载荷保留 Relay Monitor 标准事件对象的全部字段，并增加人类可读的顶层 `msg`、`monitor.name = "Relay Monitor"` 和 `heartbeat` 兼容字段。调用方已提供这些字段时保持原值。
- `form_data`：一个名为 `data` 的字段，值为与 `json` 模式完全相同的标准事件 JSON，boundary 由 FormData 自动生成。
- `custom`：受限 LiquidJS 输出表达式，可读取顶层 `msg`，并继续支持 `payload.msg`、`payload.monitor.name` 与其他允许的 `payload` 字段；模板和输出大小仍受限制。最终输出严格以用户模板为准，不自动注入字段。

额外 Header JSON 整体进入凭据加密信封，普通数据库列和 API 只保留 Header 名称，不返回值；`Authorization: Bearer ...` 也不得明文落库。编辑器列出已有名称，空值表示保留，填写表示替换，删除键表示移除。渠道测试与正式 Worker 共用请求构造模块。测试结果应返回结构化成功状态、HTTP 状态和经过大小限制的接收端响应正文，使管理台能展示接收端的字段校验原因；响应正文仍要执行既有大小限制和公开错误边界，且不得回显请求 Header 或其他凭据。旧 HMAC 渠道仅保留兼容投递，不再出现在新建/编辑界面。Webhook 不读取渠道级 CIDR；RFC1918 私网、`localhost` 和 IPv4/IPv6 回环默认允许，无需 `OUTBOUND_ALLOWED_CIDRS`。链路本地及云元数据、多播、保留、未指定和无效地址仍拒绝；公网生产 HTTP 默认拒绝，只有全部解析地址都在 `OUTBOUND_ALLOWED_CIDRS` 中时例外，公网 HTTPS 正常使用。该放宽只适用于 Webhook，站点适配器的严格出站策略不变。升级迁移会清空旧渠道普通列中的明文 Header 和旧渠道级 CIDR；管理员必须重新填写 Header 使其加密保存。通知投递重试保持相同的事件 ID 和幂等键，每次尝试单独记录结果；它与监控采集重试是两条独立链路。出站校验错误必须通过 Webhook 中文错误映射返回，不能把 `Outbound hostname resolves to a private or special-use address` 等内部英文直接交给用户。

顶层 `msg` 和测试响应正文属于 Webhook 传输契约与可观测性调整，不影响 `shared/notification-events.ts`：本次没有新增、移除或改变通知事件。倍率模型实测摘要统一由告警引擎补为“中转站 · 分组 · 结果”。同一规则修订、同一站点的多个 `site.recovered` 若在 `digest_window_seconds` 内相继产生，只创建第一条恢复 Outbox；后续事件仍分别转为已恢复并保留检查记录。这是站点恢复的时间窗口去重，不是事件或根因合并，倍率变化和模型实测不参与该时间窗口。模型实测另有严格的同事务批次：一次运行中同一规则修订、渠道和通知阶段产生的多项诊断 Outbox 合并为一条，payload 通过 `event_types`、`incidents` 和 `details.probe_findings` 保留各项；各 incident 生命周期不合并，规则未选择或被抑制的信号不得进入摘要。

## `0018` 迁移约束

`0018_cheerful_wrecking_crew.sql` 同时新增全局低余额单例、放宽模型实测间隔约束、安装包含 `balance.low` 的系统兜底规则 v2，并结束旧的活动倍率变化事件。重建 `rate_probe_configs` 时必须先保存 `rate_probe_runs.config_id` 映射，重建后再恢复，不能让历史实测运行脱离配置。旧倍率变化记录保留为历史，只清除活动指纹并结束生命周期；后续变化使用一次性提醒语义，不生成恢复投递。

## `0020` 迁移约束

`0020_rate_probe_timeout.sql` 只通过 `ALTER TABLE ... ADD timeout_seconds` 为模型实测配置增加默认 `30` 秒的单次请求超时和 `1–300` 秒约束。不要把它改成整表重建；单列迁移应保留 `rate_probe_runs.config_id`、调度索引和触发器。空库与旧库升级都要验证默认值、CHECK 和 `PRAGMA foreign_key_check`。

## `0021` / `0022` 迁移约束

`0021_immediate_rate_events_auth_root.sql` 清空旧倍率候选计数，并把同站点、同规则修订的登录失效/权限拒绝活动事件合并为一个认证根事件。旧候选没有足够信息安全重放外部副作用，因此迁移不得据此补写 `rate_history` 或创建 Outbox。`0022_reconcile_auth_root_events.sql` 对可能已经运行过开发中间版本 `0021` 的数据库执行同一最终状态的幂等收口；正常新库连续执行两条迁移也必须保持结果不变。

升级测试至少覆盖：候选计数归零；每个站点和规则修订最多保留一个活动认证根事件；旧任务级事件指向根事件并标记 `auth_root_cause_merged`；合并计数取最大值而不是相加；迁移前后 Outbox 数量不变；`PRAGMA foreign_key_check` 为空且 `quick_check` 为 `ok`。

## 开发环境主密钥轮换

先停止 `pnpm dev`，再执行：

```powershell
pnpm master-key:rotate -- --confirm-service-stopped
```

CLI 会把旧的单密钥文件升级为同路径的版本化 keyring，并在 SQLite `BEGIN IMMEDIATE` 事务中重加密站点凭据、通知渠道当前密钥和仍在有效期内的上一代渠道密钥。keyring 同时保留新旧版本，因此轮换中断后仍能读取任一版本；命令失败时数据库回滚并恢复原密钥文件。密钥内容不会写到终端。

确认新版本及数据库备份策略后，可再次停止服务并移除不再被数据库引用的旧密钥：

```powershell
pnpm master-key:finalize -- --confirm-service-stopped
```

`MASTER_KEY_VERSION` 只用于旧式单密钥文件。升级为 keyring 后，当前版本由文件内的 `current_key_version` 决定，不需要手工修改 `.env`。
