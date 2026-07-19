# macOS 测试部署

Relay Monitor 为 macOS 15 提供两套原生命令行便携包：

- `relay-monitor-<版本>-macos-arm64.tar.gz`：Apple Silicon（M 系列）Mac。
- `relay-monitor-<版本>-macos-x64.tar.gz`：Intel Mac。

包内已经包含对应架构的 Node.js 22.23.1、生产依赖、原生启动器、数据库迁移和 Web/API 产物，测试机器无需另装 Node.js。当前构建和原生 smoke test 固定在 macOS 15 runner，尚未承诺兼容更早系统。它不是图形界面的 `.app` 或 `.dmg`，不包含 `service/`，不会自动安装 `launchd` 服务；当前产物也未进行 Apple Developer ID 签名或公证，仅供测试。

## 1. 选择正确架构

在终端执行：

```bash
uname -m
```

输出与包名的对应关系：

| `uname -m` | 下载包架构 |
| --- | --- |
| `arm64` | `macos-arm64` |
| `x86_64` | `macos-x64` |

可以用下面的命令生成后续步骤使用的架构变量：

```bash
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "当前 CPU 架构没有对应的 Relay Monitor macOS 包" >&2; exit 1 ;;
esac
echo "$ARCH"
```

必须使用与当前 Mac 架构一致的包。`argon2` 和 `better-sqlite3` 包含原生二进制，不能从 Windows、Linux 或另一种 Mac 架构复制 `node_modules` 后拼装使用。

## 2. 下载并核对 SHA-256

从同一个 [GitHub Release](https://github.com/JunXiaoRuo/Relay-Monitor/releases) 下载目标 `.tar.gz` 和 `SHA256SUMS.txt`。将 `<版本>` 替换为实际 Release 版本：

```bash
VERSION='1.0.1' # 替换为实际 Release 版本
PACKAGE="relay-monitor-$VERSION-macos-$ARCH.tar.gz"
EXPECTED=$(awk -v file="$PACKAGE" '$2 == file {print $1}' SHA256SUMS.txt)
ACTUAL=$(shasum -a 256 "$PACKAGE" | awk '{print $1}')

test -n "$EXPECTED" || { echo "SHA256SUMS.txt 中没有 $PACKAGE" >&2; exit 1; }
test "$ACTUAL" = "$EXPECTED" || { echo "SHA-256 校验失败，请勿运行该文件" >&2; exit 1; }
echo "SHA-256 校验通过：$PACKAGE"
```

不要跳过校验，也不要混用其他版本的 `SHA256SUMS.txt`。

## 3. 解压并检查

下面把测试实例放在当前用户目录中；可以改成其他由当前用户控制的位置：

```bash
INSTALL_ROOT="$HOME/Applications/RelayMonitor"
mkdir -p "$INSTALL_ROOT"
tar -xzf "$PACKAGE" -C "$INSTALL_ROOT"
PACKAGE_DIR="$INSTALL_ROOT/relay-monitor-$VERSION-macos-$ARCH"
cd "$PACKAGE_DIR"

file ./relay-monitor ./runtime/bin/node
./relay-monitor version
```

`file` 输出中的架构应与当前 Mac 一致，`version` 应与下载的 Release 版本一致。原生启动器、`runtime/`、`node_modules/`、`dist/` 和迁移文件需要始终保留在同一个包目录中，不能只移动 `relay-monitor`。

## 4. Gatekeeper quarantine

因为测试包尚未签名和公证，macOS 可能阻止首次运行。先确认包来自预期 Release 且上一步 SHA-256 校验已经通过，再查看解压目录是否带有 quarantine 属性：

```bash
xattr -lr "$PACKAGE_DIR"
```

只有在来源和校验值均已确认、并且运行确实被 quarantine 阻止时，才移除该解压目录的 quarantine 属性：

```bash
xattr -dr com.apple.quarantine "$PACKAGE_DIR"
```

该命令会递归放行目录中的可执行文件。不要对来源不明的下载内容、整个下载目录或主目录执行它。

## 5. 首次初始化和管理员

在包根目录运行：

```bash
./setup.sh
./relay-monitor admin create --username admin --display-name 管理员
```

`setup.sh` 会在包内创建本地 `.env`、32 字节随机主密钥和 SQLite 数据库迁移，不会覆盖已经存在的配置、数据库或主密钥。创建管理员时密码采用终端隐藏输入，不会写入命令历史，且至少需要 12 个字符。

直连测试无需设置 `WEB_ORIGIN`。默认 `HOST=0.0.0.0` 只是让服务监听全部网卡，不是浏览器访问地址。

## 6. 启动和验证

前台启动：

```bash
./relay-monitor start
```

另开一个终端验证：

```bash
curl --fail --show-error http://127.0.0.1:5173/healthz
curl --fail --show-error http://127.0.0.1:5173/readyz
```

本机浏览器访问 `http://127.0.0.1:5173`。受信局域网中的其他设备应使用这台 Mac 的实际 LAN 地址和端口；不要访问 `0.0.0.0`。HTTP 会明文传输管理员密码、会话 Cookie 和管理数据，只能用于受信 LAN/VPN；不受信网络必须在“系统设置 → 访问方式”启用内置 HTTPS，或配置受控的 HTTPS 反向代理。

测试结束后在启动终端按 `Ctrl+C` 停止服务。当前包不提供或安装 `launchd` plist，也不承诺无人值守长期运行；需要长期托管时，应先完成签名、公证、权限、持久数据目录、备份和升级回滚方案，再单独设计 `launchd` 配置。

## 7. 数据与升级

便携模式默认把 `.env`、主密钥和数据库保存在包目录及其 `data/` 中。即使只是测试，也不要提交或分享这些文件。升级前停止进程，并分别备份：

- SQLite 一致性备份；
- 与数据库匹配的主密钥或 keyring；
- `.env`；
- 启用内置 HTTPS 后的整个 `data/tls/`；
- 当前可运行的发行包版本。

不要直接用新包覆盖旧目录。解压到新目录后迁移受控配置与数据，执行迁移并验证 `/readyz`；若新版数据库迁移与旧程序不兼容，回滚时必须同时恢复升级前数据库、对应 keyring 和旧发行包。

## 8. 常见问题

- **提示 `bad CPU type in executable` 或架构不匹配**：下载了错误架构的包。Apple Silicon 使用 `macos-arm64`，Intel Mac 使用 `macos-x64`。
- **提示开发者无法验证或文件已损坏**：先重新下载并核对 Release 的 SHA-256。确认只是 quarantine 拦截后，才对实际解压目录执行本文的 `xattr` 命令。
- **`argon2` 或 `better-sqlite3` 无法加载**：确认没有复制其他系统/架构的 `node_modules`，并重新使用对应 Mac 架构的完整发行包。
- **端口已占用**：编辑包内 `.env` 的 `PORT`，或停止占用该端口的进程，然后重新启动。
- **局域网打不开**：确认浏览器使用 Mac 的实际 LAN 地址，检查 `.env` 中的 `HOST` 和 macOS 防火墙；`0.0.0.0` 不能作为访问 URL。
- **保存 HTTPS 后地址变化**：从管理台显示的新 HTTPS 地址重新登录，确保证书 SAN 覆盖实际访问主机；服务器私钥不得写入日志、工单或仓库。

macOS 便携包只扩展构建和部署目标，不新增、移除或改变任何通知事件。
