# Relay Monitor 便携发行包

此目录是完整的便携发行包，不是单文件程序。原生启动器、Node.js 22.23.1 运行时、平台原生依赖、服务端和 Web 静态文件必须保留在同一目录中；不要只复制 `RelayMonitor.exe` 或 `relay-monitor`。macOS 包也是命令行目录便携包，不是图形界面的 `.app` 或 `.dmg`。

Relay Monitor 采用 GNU General Public License v3.0（`GPL-3.0-only`）发布，完整条款见包内 `LICENSE`。保留或再分发本发行包时，不要删除许可证文件。

发行包不包含 `.env`、数据库、主密钥或任何现有凭据。首次运行：

- Windows：`powershell -ExecutionPolicy Bypass -File .\setup.ps1`
- Linux：`./setup.sh`
- macOS：`./setup.sh`

初始化脚本会从 `.env.example` 创建 `.env`、生成 32 字节随机主密钥并执行数据库迁移。已有 `.env`、数据库和主密钥不会被覆盖。

Windows 首次生成的主密钥会移除继承 ACL，仅允许运行初始化的账户、SYSTEM、本机 Administrators 完全控制，并允许包内示例使用的 Network Service 读取。如果改用专用服务账户，安装服务前必须按该账户重新授予最小读取权限。已有主密钥不会被脚本重写 ACL，应在升级或迁移前自行用 `icacls` 检查。

## 监听与访问地址

直连部署不需要填写 `WEB_ORIGIN`，初始化脚本也不会询问它。管理台会显示当前浏览器地址，并在尚未保存“系统设置 -> 访问方式”时把当前浏览器主机作为表单建议。`.env.example` 只保留注释形式的 `WEB_ORIGIN` 作为旧版本兼容提示；确需显式覆盖时，它必须是只有协议、主机和端口的完整来源，例如 `https://monitor.example.com`。

`HOST=0.0.0.0` 只表示监听全部网卡，不能在浏览器中使用 `0.0.0.0`。本机使用 `http://127.0.0.1:5173`，局域网设备使用服务器的真实 LAN 地址和端口。

## 常用命令

Windows：

```powershell
.\RelayMonitor.exe start
.\RelayMonitor.exe migrate
.\RelayMonitor.exe admin create --username admin --display-name "管理员"
.\RelayMonitor.exe admin reset-password --username admin
.\RelayMonitor.exe master-key rotate --confirm-service-stopped
.\RelayMonitor.exe master-key finalize --confirm-service-stopped
.\RelayMonitor.exe version
```

Linux 和 macOS 使用相同子命令，将程序名换成 `./relay-monitor`。不带子命令时默认执行 `start`。管理员密码采用终端隐藏输入，不会写入命令历史。

默认运行数据位于包内 `data/`。升级前必须停止服务并使用 SQLite 在线备份或一致性备份，同时单独安全备份主密钥和 `data/tls/`。不要用其他平台或其他 CPU 架构的发行包覆盖当前目录：`argon2` 和 `better-sqlite3` 是平台原生模块，Windows、Linux、macOS arm64 和 macOS x64 的生产依赖不能互相复制。

Linux x64 包以 Ubuntu 22.04 的 glibc 环境为兼容基线，不适用于 Alpine/musl；更旧的 glibc 发行版应从源码在目标平台构建。

macOS 提供两套原生包：`macos-arm64` 用于 Apple Silicon，`macos-x64` 用于 Intel Mac，当前兼容基线为 macOS 15。包内自带对应架构的 Node.js 22.23.1，不需要另装 Node；必须选择与 `uname -m` 对应的包。当前 macOS 包未使用 Apple Developer ID 签名或公证，仅供测试，也不会自动安装 `launchd` 服务。下载后先使用 Release 中的 `SHA256SUMS.txt` 核对 SHA-256。若确认来源和校验值无误后仍被 Gatekeeper 的 quarantine 属性阻止，可以只对实际解压目录执行：

```bash
xattr -dr com.apple.quarantine <解压目录>
```

不要在未核验来源的下载内容上运行该命令。完整步骤见 [macOS 测试部署](https://github.com/JunXiaoRuo/Relay-Monitor/blob/main/docs/deployment-macos.md)。

Windows/Linux 发行包中的 `service/` 提供 WinSW 和 systemd 示例。Linux 正式服务使用 `service/monitor.env.example` 作为 `/etc/relay-monitor/monitor.env` 的起点，将主密钥放到 `/etc/relay-monitor/master.key`、数据放到 `/var/lib/relay-monitor`，并以非 root 用户运行；不要把便携模式的相对路径配置直接交给 systemd。Windows WinSW 示例默认调用包内启动器，安装服务前应按实际服务账号授予包目录读取权限、数据目录读写权限，并收紧 `.env` 和主密钥权限。macOS 测试包不包含 `service/`，不提供或安装 `launchd` plist，需要时由管理员在测试完成后自行设计托管方式和权限。

Windows 发行包当前未进行商业代码签名，首次启动可能出现 SmartScreen 提示；请先核对 GitHub Release 提供的 SHA256 校验值。

上述打包和运行方式只影响部署产物，不新增、移除或改变任何通知事件。
