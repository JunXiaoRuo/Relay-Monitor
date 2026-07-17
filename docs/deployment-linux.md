# Linux 直接部署

Relay Monitor 生产环境只运行一个 Node.js 进程，由它同时提供 API、调度器、通知 Worker 和构建后的 Web 管理台。默认直接在 `0.0.0.0:5173` 提供 HTTP，SQLite 只允许一个应用实例写入。

受信局域网可直接访问 `http://<服务器 LAN IPv4>:5173`，再在“系统设置 → 访问方式”切换内置 HTTPS。HTTP 不加密密码、会话和管理数据，只能用于受信 LAN/VPN；公网或不受信网络必须使用 HTTPS。内置 HTTPS 始终使用 `Secure`/`__Host-` Cookie。因为管理台允许切回 HTTP，内置服务不发送持久 HSTS；只有确定入口永久保持 HTTPS 时才由外部反向代理配置 HSTS。

## 选择部署方式

普通 x64/glibc Linux 推荐下载 `relay-monitor-<版本>-linux-x64.tar.gz`。包内已经包含 Node.js 22.23.1、Linux 原生依赖、Web/API 产物和 `relay-monitor` ELF 启动器，不需要在服务器另外安装 Node、pnpm 或 Go。它在 Ubuntu 22.04 构建，不适用于 Alpine/musl、ARM 或 Windows。

快速验证可以解压后直接初始化：

```bash
sha256sum --check SHA256SUMS.txt
mkdir -p "$HOME/relay-monitor-demo"
tar -xzf relay-monitor-1.0.0-linux-x64.tar.gz -C "$HOME/relay-monitor-demo"
cd "$HOME/relay-monitor-demo/relay-monitor-1.0.0-linux-x64"
./setup.sh
./relay-monitor admin create --username admin --display-name 管理员
./relay-monitor start
```

`setup.sh` 会创建包内 `.env`、`data/master.key` 和数据库，且不会询问 `WEB_ORIGIN`。这适合首次验证；正式长期服务仍应采用下文的 `relaymon` 非 root 用户、`/etc/relay-monitor` 配置/密钥和 `/var/lib/relay-monitor` 数据布局。使用便携包时，跳过“安装 Node”和“在 Linux 构建版本”，把运行命令替换为：

```bash
sudo -u relaymon env RELAY_MONITOR_ENV_FILE=/etc/relay-monitor/monitor.env \
  /opt/relay-monitor/current/relay-monitor migrate
sudo -u relaymon env RELAY_MONITOR_ENV_FILE=/etc/relay-monitor/monitor.env \
  /opt/relay-monitor/current/relay-monitor admin create \
  --username admin --display-name 管理员
```

发行包内 `service/relay-monitor.service.example` 已调用 bundled launcher；安装到 systemd 前仍需核对路径、账号和 `ReadWritePaths`。整个发行目录必须保留，不能只复制 `relay-monitor`：`runtime`、`node_modules`、`dist/web` 和数据库迁移都是运行时组成部分。

需要修改源码、运行完整测试或为其他 glibc 基线自行构建时，再使用下文源码流程。无论选择哪条路线，SQLite 都只允许一个 Relay Monitor 实例写入。

## 目录与权限

推荐布局：

```text
/root/RelayMonitor                 可选的 root 源码/构建工作区，不作为服务目录
/opt/relay-monitor/releases/<版本> 只读运行版本
/opt/relay-monitor/current         指向当前版本的原子软链接
/var/lib/relay-monitor             SQLite、备份和运行数据
/var/lib/relay-monitor/tls         内置 TLS 证书和私钥（启用后生成，限制权限）
/etc/relay-monitor/monitor.env     非秘密运行配置，0640
/etc/relay-monitor/master.key      32 字节主密钥或版本化 keyring，0600
```

不要让 Web 服务从 `/root` 运行，也不要为了让服务访问 `/root` 而放宽 `ProtectHome` 或让 Node 以 root 身份运行。用户要求把项目放在 `/root/RelayMonitor` 时，该目录只作为源码和构建工作区；systemd 仍从 `/opt/relay-monitor/current` 运行不可变版本。

## 先决条件（源码构建）

- Debian 12、Ubuntu 22.04/24.04 或等价的 systemd Linux。
- Node.js 必须满足 `>=22.19.0 <23`；Node 23/24 会被项目拒绝。
- Corepack 和仓库声明的 `pnpm@11.7.0`。
- `ca-certificates`、`curl`、`openssl`、`build-essential`、`python3`、`sqlite3`、`rsync`。原生依赖没有预编译包时需要本机编译。

本文的 `/root/RelayMonitor` 源码方案假定上传和构建阶段使用 root shell；普通 sudo 管理员默认不能进入 `/root`，此时应把源码工作区改到其可访问目录。直接使用 root SSH 时，普通管理命令前的 `sudo` 可以去掉，但 `sudo -u relaymon ...` 不能直接删除：未安装 sudo 时应替换为 `runuser -u relaymon -- ...`，确保迁移、检查和管理员 CLI 仍以 `relaymon` 身份运行。

以 Debian/Ubuntu 为例：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl build-essential python3 sqlite3 rsync
node --version
command -v node
corepack --version
```

若使用 Node.js 官方 Linux x64 压缩包，必须同时下载 `SHASUMS256.txt` 并核对 SHA-256。安装后把 `node`、`corepack` 放入系统级路径，并确认 systemd 样例中的 `ExecStart` 与 `command -v node` 一致。不要依赖 root 用户的 nvm 路径。

```bash
sudo corepack enable pnpm --install-directory /usr/local/bin
corepack prepare pnpm@11.7.0 --activate
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm --version
```

## 首次安装

### 1. 创建服务用户和持久目录

```bash
sudo useradd --system --home-dir /var/lib/relay-monitor \
  --create-home --shell /usr/sbin/nologin relaymon
sudo install -d -m 0750 -o relaymon -g relaymon \
  /var/lib/relay-monitor /var/lib/relay-monitor/backups
sudo install -d -m 0750 -o relaymon -g relaymon /etc/relay-monitor
sudo install -d -m 0755 -o root -g root /opt/relay-monitor/releases
```

首次新建实例时，主密钥直接写入最终路径，避免先在默认权限的 `/tmp` 文件中短暂落盘：

```bash
sudo -u relaymon sh -c \
  'set -eu; test ! -e /etc/relay-monitor/master.key; umask 077; \
   openssl rand -out /etc/relay-monitor/master.key 32'
test "$(stat -c %s /etc/relay-monitor/master.key)" -eq 32
sudo stat -c '%U %G %a %s %n' /etc/relay-monitor/master.key
```

期望结果为 `relaymon relaymon 600 32`。命令在文件已经存在时直接失败，绝不覆盖已有主密钥。主密钥丢失后，数据库中的凭据无法恢复。

### 2. 上传源码

不要复制 Windows 的 `node_modules`、`dist`、开发 `.env` 或 `data`。SQLite 与 Argon2 包含平台相关原生模块，必须在目标 Linux 上安装。

```bash
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude data --exclude .env \
  ./ root@服务器:/root/RelayMonitor/
```

也可以上传排除了上述路径的归档，再解压到 `/root/RelayMonitor`。

### 3. 安装生产配置

```bash
sudo install -m 0640 -o root -g relaymon \
  /root/RelayMonitor/deploy/monitor.env.example \
  /etc/relay-monitor/monitor.env
sudo editor /etc/relay-monitor/monitor.env
```

至少确认：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=5173
DATA_DIR=/var/lib/relay-monitor
DATABASE_URL=/var/lib/relay-monitor/monitor.db
MASTER_KEY_FILE=/etc/relay-monitor/master.key
TRUST_PROXY=false
MANAGED_RESTART=true
SESSION_COOKIE_SECURE=auto
```

直连部署不需要填写 `WEB_ORIGIN`。它只是兼容旧部署的可选初始提示，不参与 CORS、CSRF、Cookie 或 TLS 判断；浏览器使用服务器实际 IP/域名访问，首次打开“系统设置 → 访问方式”时管理台会用当前浏览器主机提供建议。`MANAGED_RESTART=true` 配合样例 systemd 的 `Restart=always`，允许管理台保存访问方式后退出并由 systemd 拉起。直连模式保持 `TRUST_PROXY=false`。若改为可选外部反向代理，再把 `HOST` 改为 `127.0.0.1` 并按下文设置代理相关变量。

### 4. 在 Linux 构建版本

```bash
cd /root/RelayMonitor
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm prune --prod
```

构建成功后安装不可变运行版本：

```bash
release="/opt/relay-monitor/releases/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0750 -o root -g relaymon "$release"
sudo cp -a dist node_modules package.json pnpm-lock.yaml "$release/"
sudo chown -R root:relaymon "$release"
sudo chmod -R g-w,o-rwx "$release"
sudo ln -sfn "$release" /opt/relay-monitor/current.new
sudo mv -Tf /opt/relay-monitor/current.new /opt/relay-monitor/current
readlink -f /opt/relay-monitor/current
```

### 5. 初始化或迁移数据

生产 CLI 不会自动读取项目目录中的 `.env`。迁移和管理员命令必须显式加载 `/etc/relay-monitor/monitor.env`，并使用构建后的 JavaScript；否则可能误操作默认开发数据库。

“全新实例”和“从现有实例迁移”是互斥分支。全新实例生成新主密钥、迁移空库并创建管理员；现有实例迁移必须先安装匹配的数据库和 keyring，再针对该数据库显式运行迁移。不要先迁移空库后又用旧库覆盖。

#### 全新实例

```bash
sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/migrate.js
'
```

迁移空库后创建管理员：

```bash
sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/admin.js create \
    --username admin --display-name 管理员
'
```

默认密码输入要求真实 TTY。通过自动化 SSH 或流水线执行时，不要把密码放在参数、环境文件或日志中；使用受保护的标准输入：

```bash
read -rsp '管理员密码: ' RELAY_ADMIN_PASSWORD
echo
printf '%s' "$RELAY_ADMIN_PASSWORD" | sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/admin.js create \
    --username admin --display-name 管理员 --password-stdin
'
unset RELAY_ADMIN_PASSWORD
```

如果 `command -v node` 不是 `/usr/bin/node`，把以上命令和 systemd `ExecStart` 改成真实的绝对路径。

#### 从现有实例迁移数据

需要保留站点、规则和管理员时，不要创建新数据库。先在源实例使用“系统设置 → 立即备份”，或在停服/一致性条件下执行 SQLite `.backup`，再把备份与匹配的 `master.key`/keyring 分别安全传到目标机。源实例已启用内置 HTTPS 时，还要把其 `DATA_DIR/tls` 作为一个整体安全传输；访问方式记录与 TLS 文件缺一不可。

```bash
sudo systemctl stop relay-monitor 2>/dev/null || true
sudo rm -f /var/lib/relay-monitor/monitor.db-wal \
  /var/lib/relay-monitor/monitor.db-shm
sudo install -m 0640 -o relaymon -g relaymon monitor.backup.db \
  /var/lib/relay-monitor/monitor.db
sudo install -m 0600 -o relaymon -g relaymon matching-master.key \
  /etc/relay-monitor/master.key
# 仅在源实例启用了内置 HTTPS 时执行：
sudo install -d -m 0700 -o relaymon -g relaymon /var/lib/relay-monitor/tls
sudo cp -a matching-tls/. /var/lib/relay-monitor/tls/
sudo chown -R relaymon:relaymon /var/lib/relay-monitor/tls
sudo chmod -R go-rwx /var/lib/relay-monitor/tls
sudo -u relaymon sqlite3 /var/lib/relay-monitor/monitor.db 'PRAGMA quick_check;'
```

检查结果必须为 `ok`。数据库和主密钥必须来自同一实例；不要只复制 `monitor.db` 而忽略活动 WAL，也不要把开发 `.env` 上传为生产配置。随后针对刚安装的数据库显式运行新版本迁移：

```bash
sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/migrate.js
'
sudo -u relaymon sqlite3 /var/lib/relay-monitor/monitor.db 'PRAGMA quick_check;'
```

### 6. 安装 systemd 服务

```bash
sudo install -m 0644 /root/RelayMonitor/deploy/relay-monitor.service \
  /etc/systemd/system/relay-monitor.service
sudo systemd-analyze verify /etc/systemd/system/relay-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay-monitor
sudo systemctl is-active relay-monitor
curl --fail http://127.0.0.1:5173/readyz
```

默认 LAN 部署应看到 `0.0.0.0:5173`；只把防火墙放行范围限制在受信管理网段：

```bash
ss -ltnp 'sport = :5173'
sudo journalctl -u relay-monitor -n 100 --no-pager
```

浏览器使用服务器实际地址，例如 `http://192.168.1.20:5173`，不要访问 `0.0.0.0`。样例服务使用 `Restart=always`，因此在系统设置保存协议/证书后可以安全退出并由 systemd 自动拉起；如果自行修改服务策略，管理台会只提示“需要重启”，不会假装配置已经生效。

本文后续的 `http://127.0.0.1:5173/readyz` 命令用于初始 HTTP 配置。切换内置 HTTPS 后，应改用证书覆盖的实际主机名/IP 和 `https://...:5173/readyz`，并通过 `--cacert` 或系统信任库验证签发 CA。

## 在系统设置启用内置 HTTPS

内置 HTTPS 与 HTTP 使用同一个 `5173` 端口，不需要额外安装 Nginx/Caddy。证书必须包含“访问主机”填写的 IP 或域名 SAN，且证书和私钥必须同时提交。可使用公网 CA、组织内部 CA，或为受信 LAN 建立私有 CA。

下面示例为单个 LAN IP 建立私有 CA 和服务端证书；CA 私钥和服务器私钥只能由 root 读取，客户端只分发 `.crt` 公钥证书：

```bash
LAN_IP=192.168.1.20
sudo install -d -m 0700 -o root -g root /etc/relay-monitor/tls
sudo openssl genrsa -out /etc/relay-monitor/tls/relay-monitor-ca.key 3072
sudo openssl req -x509 -new \
  -key /etc/relay-monitor/tls/relay-monitor-ca.key \
  -sha256 -days 3650 -subj '/CN=Relay Monitor LAN CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out /etc/relay-monitor/tls/relay-monitor-ca.crt
sudo openssl genrsa -out /etc/relay-monitor/tls/relay-monitor.key 2048
sudo openssl req -new \
  -key /etc/relay-monitor/tls/relay-monitor.key \
  -subj "/CN=$LAN_IP" -addext "subjectAltName=IP:$LAN_IP" \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth' \
  -out /etc/relay-monitor/tls/relay-monitor.csr
sudo openssl x509 -req \
  -in /etc/relay-monitor/tls/relay-monitor.csr \
  -CA /etc/relay-monitor/tls/relay-monitor-ca.crt \
  -CAkey /etc/relay-monitor/tls/relay-monitor-ca.key \
  -CAcreateserial -days 825 -sha256 -copy_extensions copy \
  -out /etc/relay-monitor/tls/relay-monitor.crt
sudo chmod 0600 /etc/relay-monitor/tls/*.key
sudo chmod 0644 /etc/relay-monitor/tls/*.crt
sudo rm -f /etc/relay-monitor/tls/relay-monitor.csr \
  /etc/relay-monitor/tls/relay-monitor-ca.srl
sudo openssl verify \
  -CAfile /etc/relay-monitor/tls/relay-monitor-ca.crt \
  /etc/relay-monitor/tls/relay-monitor.crt
```

把 `relay-monitor-ca.crt` 导入 Windows“受信任的根证书颁发机构”、Android/iOS 的受信任用户 CA，或对应浏览器/操作系统的根证书存储。不要分发 `relay-monitor-ca.key` 或 `relay-monitor.key`。

随后：

1. 从受信 LAN 打开 `http://192.168.1.20:5173` 并登录。
2. 进入“系统设置 → 访问方式”，选择 HTTPS，访问主机填写 `192.168.1.20`。
3. 把 `relay-monitor.crt` 和 `relay-monitor.key` 的完整 PEM 分别粘贴到“服务器证书”和“私钥”。两者必须同时填写；私钥保存后不会回填。
4. 点击“保存并应用”。样例 systemd 会自动重启服务；稍候从 `https://192.168.1.20:5173` 重新登录。

应用把生效副本写入 `/var/lib/relay-monitor/tls` 并限制文件权限。不要把服务端私钥复制到 Web 根目录、源码、日志或聊天中。可在服务器验证：

```bash
curl --fail \
  --cacert /etc/relay-monitor/tls/relay-monitor-ca.crt \
  https://192.168.1.20:5173/readyz
sudo find /var/lib/relay-monitor/tls -maxdepth 3 -type f \
  -printf '%u %g %m %p\n'
```

Windows 自带的 `curl.exe` 使用 Schannel。私有 CA 没有公网 CRL/OCSP 时，即使证书链和 IP SAN 正确，也可能返回 `CERT_TRUST_REVOCATION_STATUS_UNKNOWN`。确认使用的是本项目公开 CA 证书后，可用下面的命令做一次性连通性验证：

```powershell
curl.exe --ssl-no-revoke --cacert .\relay-monitor-ca.crt `
  --fail https://192.168.1.20:5173/readyz
```

`--ssl-no-revoke` 只用于这个命令行验证，不等于跳过证书链校验。浏览器和日常客户端仍应导入 `relay-monitor-ca.crt`，并正常验证证书；不要使用 `-k` 或 `--insecure`。内置 HTTPS 生效后始终启用 `Secure`/`__Host-` Cookie；切回 HTTP 后恢复普通 Cookie。内置服务不发送持久 HSTS，避免浏览器在切回 HTTP 后仍强制升级；HTTP 只能继续在受信 LAN/VPN 使用。

协议切换会要求重新登录，这是有意的会话边界。若保存后显示“等待重启生效”，说明当前托管方式没有启用自动重启；手工执行 `sudo systemctl restart relay-monitor`。浏览器必须信任签发证书的 CA，不要通过修改 `NODE_ENV` 绕过 HTTPS。

访问协议、主机和证书属于服务运行配置，不新增、移除或改变任何通知事件，也不会因为重启补发告警。

## 可选的外部 HTTPS 反向代理

有正式域名、统一入口或集中证书管理需求时，仍可使用 [Caddy 样例](../deploy/Caddyfile.example) 或 [Nginx 样例](../deploy/nginx-lan-tls.conf.example)。这是内置 TLS 的替代方案，不是默认安装步骤。把环境文件改为：

```dotenv
HOST=127.0.0.1
PORT=5173
TRUST_PROXY=127.0.0.1
SESSION_COOKIE_SECURE=true
```

`SESSION_COOKIE_SECURE=true` 是外部 TLS 终止所必需的显式覆盖；默认 `auto` 只检测内置 TLS。外部代理还必须发送正确的 Host/转发协议头并自行设置 HSTS。不要把 `TRUST_PROXY` 设为无约束通配地址。反代 upstream 是 `http://127.0.0.1:5173`，应用在系统设置中保持 HTTP，证书由代理管理。

Nginx 样例把 `proxy_read_timeout` 设为 12 小时，因为手动模型实测接口会同步等待配置的请求超时和重试间隔；允许的极端配置接近 11 小时。普通监控和自动实测在后台调度，不占用该反代连接。应用与代理配置完成后验证：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://monitor.example.com/readyz
```

## 更新与回滚

1. 把新源码上传到 `/root/RelayMonitor`，在新的 release 目录完成依赖安装、测试和构建，不覆盖当前运行版本。
2. 停服前记录 `readlink -f /opt/relay-monitor/current` 作为 `previous`。
3. 停止服务，通过 SQLite `.backup` 创建升级前备份并执行 `PRAGMA quick_check`；把匹配的 keyring 和已启用的 `DATA_DIR/tls` 单独加密、异机归档。
4. 使用新 release 和生产环境文件运行迁移。
5. 原子切换 `current`，启动服务，验证 `readyz`、当前 HTTP/HTTPS 地址、日志和 `5173` 监听范围。
6. 保留至少上一版 release。验证期结束后再删除更旧版本。

示例备份：

```bash
sudo systemctl stop relay-monitor
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo -u relaymon sqlite3 /var/lib/relay-monitor/monitor.db \
  ".backup '/var/lib/relay-monitor/backups/pre-upgrade-$stamp.db'"
sudo -u relaymon sqlite3 \
  "/var/lib/relay-monitor/backups/pre-upgrade-$stamp.db" 'PRAGMA quick_check;'
```

启用内置 HTTPS 时还要把 `/var/lib/relay-monitor/tls` 作为一个整体复制到加密备份介质；服务器私钥不得进入普通源码归档。恢复时证书与私钥必须成对恢复，并保持 `relaymon` 可读、其他用户不可读的限制权限。

回滚分为两个互斥分支。如果迁移保持向后兼容，可只回滚代码：停止服务，把 `current` 原子切回 `previous`，再启动并验证。

```bash
sudo systemctl stop relay-monitor
sudo ln -sfn "$previous" /opt/relay-monitor/current.new
sudo mv -Tf /opt/relay-monitor/current.new /opt/relay-monitor/current
sudo systemctl start relay-monitor
curl --fail http://127.0.0.1:5173/readyz
```

如果新迁移不保证向后兼容，不能先启动旧服务。必须在同一次停服窗口内切回代码，并恢复升级前数据库及其匹配 keyring；把占位路径替换为同一次升级前备份：

```bash
sudo systemctl stop relay-monitor
sudo ln -sfn "$previous" /opt/relay-monitor/current.new
sudo mv -Tf /opt/relay-monitor/current.new /opt/relay-monitor/current
sudo rm -f /var/lib/relay-monitor/monitor.db \
  /var/lib/relay-monitor/monitor.db-wal \
  /var/lib/relay-monitor/monitor.db-shm
sudo install -m 0640 -o relaymon -g relaymon \
  /var/lib/relay-monitor/backups/pre-upgrade-时间戳.db \
  /var/lib/relay-monitor/monitor.db
sudo install -m 0600 -o relaymon -g relaymon \
  /安全备份位置/匹配的-master.key \
  /etc/relay-monitor/master.key
sudo -u relaymon sqlite3 /var/lib/relay-monitor/monitor.db 'PRAGMA quick_check;'
sudo systemctl start relay-monitor
curl --fail http://127.0.0.1:5173/readyz
```

两个分支只能选择一个执行。代码与数据回滚期间绝不能让旧服务先针对新 schema 启动，也不能在服务运行时删除数据库或 WAL/SHM。

不要在 Web 管理端执行任意 shell 更新命令。

## 主密钥轮换

轮换必须停服，并先验证数据库与当前 keyring 的成对备份：

```bash
sudo systemctl stop relay-monitor
sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/master-key.js rotate --confirm-service-stopped
'
sudo systemctl start relay-monitor
curl --fail http://127.0.0.1:5173/readyz
```

稳定运行并确认不再需要使用当前数据库回滚到旧密钥后，才可执行：

```bash
sudo systemctl stop relay-monitor
sudo -u relaymon sh -c '
  cd /opt/relay-monitor/current
  exec /usr/bin/node --env-file=/etc/relay-monitor/monitor.env \
    dist/server/backend/cli/master-key.js finalize --confirm-service-stopped
'
sudo systemctl start relay-monitor
```

`finalize` 会拒绝删除仍被数据库引用的密钥版本。旧数据库备份所需的旧 keyring 必须继续单独加密保存。

## 故障检查

```bash
sudo systemctl status relay-monitor --no-pager
sudo journalctl -u relay-monitor -n 100 --no-pager
curl --fail http://127.0.0.1:5173/healthz
curl --fail http://127.0.0.1:5173/readyz
sudo -u relaymon sqlite3 /var/lib/relay-monitor/monitor.db 'PRAGMA quick_check;'
```

- `readyz` 正常但浏览器无法登录：检查实际协议、主机、端口和系统中已保存的访问方式；切换协议后必须从新地址重新登录。`WEB_ORIGIN` 不参与会话校验。
- 保存 HTTPS 后服务无法启动：检查证书和私钥是否匹配、证书 SAN 是否覆盖访问主机，以及 `/var/lib/relay-monitor/tls` 权限；用 `journalctl` 查看公开错误，不要把私钥粘贴到排障记录。
- 外部 HTTPS 反代能打开但会话异常：必须显式设 `SESSION_COOKIE_SECURE=true`，同时核对精确 `TRUST_PROXY`、Host 和转发协议头；默认 `auto` 只跟随内置 TLS。
- 服务找不到 Node：检查 `command -v node` 与 systemd `ExecStart`。
- 迁移后看不到原数据：检查 CLI 是否显式加载 `/etc/relay-monitor/monitor.env`，不要继续向错误数据库写入。
- 凭据无法解密：停止服务，核对数据库和主密钥是否来自同一实例，不要重新生成主密钥覆盖旧文件。
