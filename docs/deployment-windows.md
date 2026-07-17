# Windows 部署

Relay Monitor 支持“GitHub Release 便携包”和“源码构建”两种 Windows 部署方式。两者只能选择一种作为当前运行实例，不能同时启动或混用不同平台的 `node_modules`。

这台开发机器的源码部署示例使用 `E:\github\Relay-Monitor`。便携包可以解压到管理员自行选择的应用目录，且已经包含 Node.js 运行时，不要求系统安装 Node。

`E:\server` 只用于独立运行时和服务工具，例如 Node.js、WinSW 或反向代理。不要把 Relay Monitor 源码、数据库或另一套可运行副本放进 `E:\server`。

生产构建只启动一个 Node.js 进程；Fastify 同时提供 API、调度器、通知 Worker 和构建后的 Vue 管理台。

## 0. 选择部署方式

推荐普通用户从 GitHub Actions artifact 或 GitHub Release 下载 `relay-monitor-<版本>-windows-x64.zip`。先核对 Release 中 `SHA256SUMS.txt`，再解压并初始化：

~~~powershell
$Archive = '.\relay-monitor-0.1.0-windows-x64.zip'
$InstallRoot = Join-Path $env:USERPROFILE 'RelayMonitor'
(Get-FileHash -Algorithm SHA256 $Archive).Hash
Expand-Archive $Archive -DestinationPath $InstallRoot
Set-Location (Join-Path $InstallRoot 'relay-monitor-0.1.0-windows-x64')
powershell -ExecutionPolicy Bypass -File .\setup.ps1
.\RelayMonitor.exe admin create --username admin --display-name "管理员"
.\RelayMonitor.exe start
~~~

初始化脚本从 `.env.example` 创建 `.env`、生成 32 字节主密钥并执行数据库迁移；已有文件不会被覆盖。它不会询问 `WEB_ORIGIN`，直连部署也不需要填写该变量。浏览器本机访问 `http://127.0.0.1:5173`，局域网访问服务器真实 IPv4；`0.0.0.0` 只能写入监听配置，不能作为浏览器地址。

便携包中的 `RelayMonitor.exe` 是原生 Windows 启动入口，但整个目录仍是一个完整应用，不能只复制 EXE。包内 `runtime`、`node_modules`、`dist` 和迁移文件必须一起保留。首次启动可能出现 SmartScreen“未知发布者”，应先核对 SHA-256；不要为了消除提示而关闭系统安全功能。

长期运行时可使用包内 `service\relay-monitor-service.xml.example` 和 WinSW。安装前把服务 XML 中的账号、路径和日志目录按实际目录校正，并限制 `.env`、`data\master.key`、`data\tls` 和数据库 ACL。更新时先停止服务并备份 `.env`、数据库、主密钥和 TLS 目录，再解压新版本、迁移并切换服务路径；不要用新包覆盖仍在运行的目录。

需要修改源码、执行完整测试或自行生成发行包时，再使用下面的源码部署流程。源码构建仍使用唯一项目目录，`E:\server` 只放独立 Node、Go、WinSW 等工具，不放第二套 Relay Monitor。

## 1. 目录边界

~~~text
E:\github\Relay-Monitor\       唯一项目目录
  .env                          项目配置
  backend\ / frontend\          源码
  node_modules\                 当前 Windows 安装的依赖
  dist\                         生产构建产物
  data\                         项目运行数据
    monitor.db                  SQLite 数据库
    master.key                  主密钥或版本化 keyring
    backups\                    在线或离线备份
    tls\                        内置 HTTPS 证书和私钥（启用后生成）
    logs\                       服务日志
    pnpm-store\                 本项目依赖缓存

E:\server\                     独立环境和工具，不是第二个项目
  nodejs\                       可选的 Node.js 22 运行时
  WinSW\                        可选的 Windows 服务包装器
~~~

开发和生产托管都使用 `E:\github\Relay-Monitor`，不能再建立 `current`、`releases` 或另一套 Relay Monitor 项目目录。备份文件可以放到单独的受控备份介质，但不能作为同时运行的第二套服务。

准备项目数据目录：

~~~powershell
$ProjectRoot = 'E:\github\Relay-Monitor'
New-Item -ItemType Directory -Force -Path `
  "$ProjectRoot\data", `
  "$ProjectRoot\data\backups", `
  "$ProjectRoot\data\logs", `
  "$ProjectRoot\data\pnpm-store" | Out-Null
~~~

## 2. 环境要求

- Windows Server 或 Windows 10/11。
- Node.js `22.19.0` 或更新的 22.x；不能使用 Node 23/24。
- Corepack 和 pnpm `>= 10`；仓库锁定 pnpm `11.7.0`。
- 配置服务、ACL 和防火墙时使用管理员 PowerShell。

~~~powershell
node -v
corepack pnpm -v
~~~

若需要新安装 Node.js 或 WinSW，把这些独立工具安装到 `E:\server`；不要把项目移动过去。安装 Node 后执行 `corepack enable`，确保项目脚本内再次调用 `pnpm` 时仍使用同一个 Node 22 环境。

## 3. 创建主密钥

生产模式不会自动创建主密钥。若 `data\master.key` 尚不存在，执行：

~~~powershell
$KeyPath = 'E:\github\Relay-Monitor\data\master.key'
$Key = New-Object byte[] 32
$Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $Rng.GetBytes($Key)
  [System.IO.File]::WriteAllBytes($KeyPath, $Key)
} finally {
  $Rng.Dispose()
  [Array]::Clear($Key, 0, $Key.Length)
}
~~~

不要用 GUID、密码、Base64 文本、源码常量或可读字符串代替 32 字节随机文件，也不要输出密钥内容。数据库和主密钥虽然都归属项目 `data` 目录，但备份时必须分别加密保存。

## 4. 配置环境文件

~~~powershell
Set-Location E:\github\Relay-Monitor
Copy-Item .\deploy\windows\monitor.env.example .\.env
notepad .\.env
~~~

Windows 样例使用相对项目根目录的路径，不再硬编码第二个安装目录：

~~~dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=5173
TZ=Asia/Shanghai
DATA_DIR=./data
DATABASE_URL=./data/monitor.db
MASTER_KEY_FILE=./data/master.key
MASTER_KEY_VERSION=1
LOG_LEVEL=info
TRUST_PROXY=false
MANAGED_RESTART=true
SESSION_COOKIE_SECURE=auto
DATABASE_BUSY_TIMEOUT_MS=5000
MAX_CONCURRENT_SITES=5
OUTBOUND_ALLOWED_CIDRS=
~~~

默认生产由 Fastify 在 `0.0.0.0:5173` 同时提供管理台和 API，受信 LAN 使用服务器实际 IPv4，例如 `http://192.168.1.20:5173`。`0.0.0.0` 只是监听地址，不能作为浏览器 URL。HTTP 不加密密码、Cookie 和管理数据，只能用于受信 LAN/VPN；公网或不受信网络必须在系统设置启用内置 HTTPS，或使用下文外部 HTTPS 反代。

直连部署不需要填写 `WEB_ORIGIN`。它只是兼容旧部署的可选初始提示，不参与 CORS、CSRF、Cookie 或 TLS 判断；首次打开“系统设置 → 访问方式”时，管理台会把当前浏览器主机作为建议。若旧自动化仍写入该变量，留空或保留合法 HTTP(S) Origin 都兼容。

直连保持 `TRUST_PROXY=false`。`MANAGED_RESTART=true` 仅适用于能够自动重新拉起进程的 WinSW 等托管方式；前台手工运行时保存访问方式后仍需手工重新启动。内置 HTTPS 始终使用 `Secure`/`__Host-` Cookie。因为管理台允许切回 HTTP，内置服务不发送持久 HSTS；只有确定入口永久保持 HTTPS 时才由外部代理配置 HSTS。外部 TLS 终止时必须显式设置 `SESSION_COOKIE_SECURE=true`，并填写精确代理地址。RFC1918 私网、`localhost` 和 IPv4/IPv6 回环 Webhook 默认可用，不需要写入 `OUTBOUND_ALLOWED_CIDRS`。该变量仍用于严格的站点出站例外，或管理员明确接受风险的公网 HTTP Webhook；只添加最小必要网段，不能使用无约束放行。

## 5. 权限

服务账号需要读取项目代码、构建产物、`.env` 和主密钥，并修改 `data` 中的数据库与日志。下面以 Network Service 为例，只追加必要权限，不重置整个源码目录的现有所有者：

~~~powershell
$ProjectRoot = 'E:\github\Relay-Monitor'
icacls $ProjectRoot /grant '*S-1-5-20:(OI)(CI)RX'
icacls "$ProjectRoot\data" /grant '*S-1-5-20:(OI)(CI)M'
icacls "$ProjectRoot\.env" /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-20:R'
icacls "$ProjectRoot\data\master.key" /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-20:R'
New-Item -ItemType Directory -Force "$ProjectRoot\data\tls" | Out-Null
icacls "$ProjectRoot\data\tls" /inheritance:r
icacls "$ProjectRoot\data\tls" /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)M'
icacls "$ProjectRoot\data\tls"
~~~

- `S-1-5-18`：Local System
- `S-1-5-20`：Network Service
- `S-1-5-32-544`：本机 Administrators

使用专用服务账号时替换 Network Service，并授予“作为服务登录”。Node 的 `chmod` 不能替代 NTFS ACL；启用或更换证书后应再次用 `icacls "$ProjectRoot\data\tls"` 确认没有普通用户或其他非预期主体。`data\tls` 中包含服务器私钥，备份也必须使用同等级别的访问控制和加密。

## 6. 安装、检查和构建

必须在目标 Windows 机器的唯一项目目录中安装依赖，不能复制 Linux 或其他机器生成的 `node_modules`：

~~~powershell
Set-Location E:\github\Relay-Monitor
corepack enable
corepack pnpm install --frozen-lockfile --store-dir .\data\pnpm-store
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node --env-file=.env dist\server\backend\cli\migrate.js
~~~

构建产物仍在本项目的 `dist`：

- `dist\server\backend\server.js`：生产入口
- `dist\server\backend\cli\*.js`：生产运维 CLI
- `dist\server\backend\db\migrations`：数据库迁移
- `dist\web`：管理台

## 7. 创建管理员

~~~powershell
Set-Location E:\github\Relay-Monitor
node --env-file=.env dist\server\backend\cli\admin.js create --username admin --display-name "管理员"
~~~

终端会隐藏密码并要求确认，密码至少 12 个字符。不要把密码写进命令参数、脚本或 CI 日志。

重置密码：

~~~powershell
node --env-file=.env dist\server\backend\cli\admin.js reset-password --username admin
~~~

重置会撤销该管理员现有会话。

## 8. 前台验证

~~~powershell
Set-Location E:\github\Relay-Monitor
node --env-file=.env dist\server\backend\server.js
~~~

另开终端：

~~~powershell
Invoke-RestMethod http://127.0.0.1:5173/healthz
Invoke-RestMethod http://127.0.0.1:5173/readyz
~~~

应分别返回 `ok` 和 `ready`。本机访问 `http://127.0.0.1:5173` 验证生产页面，其他受信 LAN 设备使用服务器实际 IPv4；确认后按 `Ctrl+C` 停止，再配置服务托管。

本文后续的 `http://127.0.0.1:5173/readyz` 命令用于初始 HTTP 配置。切换内置 HTTPS 后，应改用证书覆盖的实际主机名/IP 和 `https://...:5173/readyz`，并让当前 Windows 信任签发 CA；不要用跳过证书校验代替正确证书。

如果监听 `0.0.0.0`，本机仍使用 `127.0.0.1`，其他设备使用服务器实际 IPv4。

## 9. 使用 WinSW 托管

[WinSW](https://github.com/winsw/winsw) 是外部服务工具，可以放在 `E:\server\WinSW`，但它只负责启动唯一项目目录中的 Node 进程。

1. 从 WinSW 官方发行页取得适合当前架构的可执行文件并核对发布信息。
2. 放到 `E:\server\WinSW`，重命名为 `relay-monitor-service.exe`。
3. 把 [WinSW XML 样例](../deploy/windows/relay-monitor-service.xml.example) 复制到同一目录并命名为 `relay-monitor-service.xml`。
4. 核对 XML：项目工作目录必须是 `E:\github\Relay-Monitor`；Node 路径必须指向实际 Node.js 22，例如 `E:\server\nodejs\node.exe`。

~~~powershell
Set-Location E:\server\WinSW
.\relay-monitor-service.exe install
.\relay-monitor-service.exe start
.\relay-monitor-service.exe status
Invoke-RestMethod http://127.0.0.1:5173/readyz
~~~

停止、重启或卸载：

~~~powershell
.\relay-monitor-service.exe stop
.\relay-monitor-service.exe restart
.\relay-monitor-service.exe status
.\relay-monitor-service.exe uninstall
~~~

样例使用 Network Service、延迟自动启动、失败重启和滚动日志。WinSW 要求 EXE 与同名 XML 放在一起，配置语义以 [WinSW 官方 XML 文档](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md) 为准。

## 10. 任务计划程序替代

任务计划程序的生命周期和优雅停止能力不如 WinSW，仅在无法使用服务包装器时采用：

~~~powershell
$Node = 'E:\server\nodejs\node.exe'
$ProjectRoot = 'E:\github\Relay-Monitor'
$Arguments = '--env-file="E:\github\Relay-Monitor\.env" "dist\server\backend\server.js"'
$Action = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\NetworkService' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Relay Monitor' -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings
Start-ScheduledTask -TaskName 'Relay Monitor'
~~~

~~~powershell
Get-ScheduledTaskInfo -TaskName 'Relay Monitor'
Invoke-RestMethod http://127.0.0.1:5173/readyz
~~~

更新、离线备份或轮换密钥前先停止任务，并确认 Node 子进程已经退出。

## 11. 访问方式、HTTPS 和防火墙

首次从受信 LAN 打开 `http://<服务器 IPv4>:5173`。登录后可在“系统设置 → 访问方式”选择 HTTPS、填写客户端实际使用的 IP/域名，并同时粘贴 PEM 服务器证书和私钥。证书必须包含该 IP/域名 SAN；两项必须同时提交。保存后私钥不会回填；默认配置把生效副本写入 `data\tls`，并限制文件权限。

使用 WinSW 且 `MANAGED_RESTART=true` 时，保存会让服务自动重新拉起；稍候从界面给出的 `https://<主机>:5173` 重新登录。前台或不支持自动拉起的托管方式会显示“等待重启生效”，此时手工重启服务。协议切换要求重新登录；内置 HTTPS 始终使用 `Secure`/`__Host-` Cookie。内置服务不发送持久 HSTS，以保证管理员仍可按设置切回 HTTP。

访问协议、主机和证书属于服务运行配置，不新增、移除或改变任何通知事件，也不会因为重启补发告警。

若仅在受信 LAN 直连，可只为专用网络和实际来源网段放行端口。以下示例只允许 `192.168.1.0/24`：

~~~powershell
New-NetFirewallRule -DisplayName 'Relay Monitor LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -Profile Private -RemoteAddress 192.168.1.0/24
~~~

不要在公网或不受信 Wi-Fi 上使用 HTTP。服务器证书可以来自公网 CA、组织 CA 或受信 LAN 私有 CA；使用私有 CA 时，每个客户端必须导入并信任公开 CA 证书，绝不能分发服务器私钥。

如需用 Caddy/Nginx 统一管理域名和证书，可把应用改为 `HOST=127.0.0.1`、`PORT=5173`，设置精确 `TRUST_PROXY`，并显式设置 `SESSION_COOKIE_SECURE=true`。默认 `auto` 只跟随内置 TLS；外部代理还必须转发正确的 Host/协议头并自行发送 HSTS。反代 upstream 为 `http://127.0.0.1:5173`，应用在系统设置中保持 HTTP。不要同时让应用和代理争用同一端口，也不要把 `TRUST_PROXY` 设为任意来源。

## 12. 备份与恢复

### 在线备份

登录管理台，在“系统设置”点击“立即备份”。SQLite 在线备份会写入 `E:\github\Relay-Monitor\data\backups`。服务运行时不要只复制 `monitor.db` 而忽略 WAL。

需要分别归档：

- 一致的数据库备份；
- 当时匹配的 `data\master.key` 或 keyring；
- `.env`；
- 对应应用版本或构建产物；
- 启用内置 HTTPS 后的 `data\tls` 整个目录；
- WinSW 与可选反向代理配置。

数据库和主密钥应放到不同的加密备份介质。TLS 私钥备份同样必须加密并限制访问，不能与公开证书一起无保护分发。丢失主密钥后凭据无法恢复；丢失 TLS 私钥后需重新签发或重新配置证书。

### 离线备份

~~~powershell
Set-Location E:\server\WinSW
.\relay-monitor-service.exe stop
$ProjectRoot = 'E:\github\Relay-Monitor'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$ProjectRoot\data\monitor.db" "$ProjectRoot\data\backups\offline-$Stamp.db"
if (Test-Path "$ProjectRoot\data\tls") {
  Compress-Archive -Path "$ProjectRoot\data\tls" -DestinationPath "$ProjectRoot\data\backups\tls-$Stamp.zip"
}
.\relay-monitor-service.exe start
Invoke-RestMethod http://127.0.0.1:5173/readyz
~~~

主密钥和包含服务器私钥的 TLS 归档必须另行复制到受控加密备份位置；示例 ZIP 本身没有加密，不能直接当作异机安全归档。

### 恢复

1. 停止服务并保留故障现场副本。
2. 恢复互相匹配的数据库和 keyring；启用内置 HTTPS 的实例同时恢复成对的 `data\tls`。
3. 恢复兼容的项目版本及 `.env`。
4. 在 `E:\github\Relay-Monitor` 显式运行迁移。
5. 启动并验证当前 HTTP/HTTPS `/readyz`、登录、凭据读取和通知。

不要混用新数据库和旧主密钥，也不要混用旧数据库和已经删除旧版本的 keyring。

## 13. 原地更新与回滚

项目始终在 `E:\github\Relay-Monitor` 原地更新，不建立第二套运行目录：

1. 创建并验证数据库备份，单独归档当前 keyring、`.env`、当前应用版本，以及启用内置 HTTPS 后的 `data\tls`。
2. 停止 WinSW 或任务计划程序，确认 Node 进程退出。
3. 在原项目目录更新源码或发布文件。
4. 在当前 Windows 机器重新执行依赖安装、类型检查、测试和构建。
5. 显式执行数据库迁移。
6. 启动并检查 `/readyz`、登录、调度器、适配器和通知投递。

包含新版 Webhook 凭据迁移的升级会清空旧渠道普通列中的明文 Header 和旧渠道级 CIDR。升级完成后，在通知渠道中重新填写所需 Header，使其进入加密凭据；不要尝试恢复隐藏的渠道级 CIDR。普通 RFC1918 私网、`localhost` 和回环接收端可直接使用，只有严格的站点出站或明确的公网 HTTP 例外才需要全局 `OUTBOUND_ALLOWED_CIDRS`。

`0018_cheerful_wrecking_crew.sql` 会新增默认启用、阈值为 `10` 的全局低余额设置，放宽模型自动实测间隔，安装包含低余额事件的系统兜底规则 v2，并结束旧的活动倍率变化事件。迁移重建实测配置表时会保留历史运行的 `config_id` 关联；不要拆分、跳过或手工改写该迁移。升级后倍率新增/变化/移除作为一次性“变化提醒”，不会进入活动故障或发送恢复通知。

`0019_close_replaced_rule_incidents.sql` 会把仍引用已替换规则修订的活动事件转为“已抑制”并释放活动指纹，避免已经恢复的旧事件继续显示为“告警中”。历史记录保留，迁移不会补发通知；不要只更新应用文件而跳过数据库迁移。

`0020_rate_probe_timeout.sql` 为模型实测配置增加默认 `30` 秒的单次请求超时。旧配置此前没有该字段，因此都会取得 30 秒默认值；模型、Key、自动间隔、重试设置和历史实测关联保持不变。

`0021_immediate_rate_events_auth_root.sql` 清空旧倍率候选计数，使首个完整的后续变化立即生效；旧候选不会被补造为历史事件或通知。同一站点和规则修订下重复的登录失效/权限拒绝活动事件会保留一个“登录与认证”根事件，其余记录转为“已抑制”。迁移不补发通知；认证事件是否发送仍取决于告警规则是否勾选对应事件并绑定渠道。

`0022_reconcile_auth_root_events.sql` 对从开发中间版本升级的数据库执行同一套幂等收口：清理残留倍率候选计数，并再次按站点和规则修订归并认证活动事件。正常新安装通常不会产生额外变化；迁移不创建 Outbox，也不会因为升级补发认证通知。

全局低余额阈值在首页设置，所有站点按各自上报的数值和单位比较，不做币种换算；保存后会立即排队余额检查。通知规则固定使用统一监控事件，在“余额监控”中勾选“余额过低”，不再创建参数化余额/倍率阈值规则。分组模型实测间隔可填写任意正整数分钟，单次请求超时默认 `30` 秒，失败重试默认 `3` 次、间隔 `60` 秒；自动创建分组 Key 时额度和有效期都可留空，分别表示不限额和永不过期。

应用文件可以从备份恢复，但数据库迁移不一定可逆。若旧应用与新 Schema 不兼容，必须同时恢复升级前数据库、匹配 keyring 和旧应用版本，不能直接手工逆改 SQLite Schema。

## 14. 主密钥轮换

轮换前备份数据库并单独加密归档当前密钥。必须停服：

~~~powershell
Set-Location E:\server\WinSW
.\relay-monitor-service.exe stop
Set-Location E:\github\Relay-Monitor
node --env-file=.env dist\server\backend\cli\master-key.js rotate --confirm-service-stopped
Set-Location E:\server\WinSW
.\relay-monitor-service.exe start
Invoke-RestMethod http://127.0.0.1:5173/readyz
~~~

稳定运行且确认不再回滚旧数据库后，可以停服执行：

~~~powershell
Set-Location E:\server\WinSW
.\relay-monitor-service.exe stop
Set-Location E:\github\Relay-Monitor
node --env-file=.env dist\server\backend\cli\master-key.js finalize --confirm-service-stopped
Set-Location E:\server\WinSW
.\relay-monitor-service.exe start
~~~

`finalize` 会验证全部密文，并拒绝删除仍被引用的旧密钥。旧数据库备份所需的 keyring 仍要在其他受控位置保留。

## 15. 排错

~~~powershell
Invoke-RestMethod http://127.0.0.1:5173/healthz
Invoke-RestMethod http://127.0.0.1:5173/readyz
Get-Service RelayMonitor
Get-ChildItem E:\github\Relay-Monitor\data\logs
~~~

- **服务立即退出**：检查 Node 是否为 22.19+ 的 22.x、`.env`、主密钥、工作目录和 WinSW 日志。
- **数据库只读或无法创建 WAL**：服务账号需要修改整个 `data` 目录。
- **前端 404 或只显示 API JSON**：重新构建并确认 `dist\web\index.html` 存在。
- **Cookie/CSRF 异常**：核对当前访问协议、主机、端口和系统中已保存的访问方式；协议切换后从新地址重新登录。`WEB_ORIGIN` 不参与会话校验。
- **保存 HTTPS 后服务退出**：检查证书与私钥是否匹配、证书 SAN 是否覆盖访问主机，以及服务账号是否可读取 `data\tls`；私钥不要粘贴到日志或工单。
- **外部 HTTPS 反代会话异常**：显式设置 `SESSION_COOKIE_SECURE=true`，并核对精确 `TRUST_PROXY`、Host 和转发协议头；默认 `auto` 只跟随内置 TLS。
- **LAN 无法访问**：确认使用实际 IPv4，而不是 `0.0.0.0`；检查监听地址和 Windows 防火墙。
- **私网 Webhook 被拦截**：RFC1918、`localhost` 和回环默认允许；若仍失败，检查目标是否实际解析到链路本地、云元数据、多播、保留、未指定或无效地址，这些地址不会因私网便利策略而放行。错误会以中文显示。
- **内网上游被拦截**：站点适配器的严格出站策略没有放宽，只添加必要的 `OUTBOUND_ALLOWED_CIDRS`，不能用 `0.0.0.0/0` 绕过 SSRF。
- **公网 HTTP Webhook 被拒绝**：生产公网接收端应改用 HTTPS；只有明确评估风险后，才把目标的全部解析地址加入最小 `OUTBOUND_ALLOWED_CIDRS`。
- **原生模块失败**：在当前 Windows 机器的项目目录重新安装依赖，不能复制其他平台的 `node_modules`。
- **服务找不到 Node**：在 XML 或任务计划中使用实际 Node.js 22 绝对路径，并检查服务账号权限。
