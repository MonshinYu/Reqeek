# Reqeek

Reqeek 是一个基于 Electron、React 和 TypeScript 构建的桌面抓包工具。它在本机启动一个 HTTP/HTTPS 代理，记录经过代理的请求，并提供请求列表、详情和过滤界面。

## 功能

- **HTTP 抓包**：转发明文 HTTP 请求，记录方法、URL、状态码、耗时、首字节时间（TTFB）和流量大小。
- **HTTPS 解密**：为 CONNECT 请求签发站点证书，解密后记录请求头、响应头和 body。解密握手失败的域名会自动回退为透明隧道，之后不再尝试解密。
- **WebSocket**：支持 `ws` 和解密后的 `wss` 升级请求，升级成功后按裸字节流转发并统计流量。
- **请求详情**：查看请求头和响应头、body（按 `Content-Encoding` 解码）、耗时视图。JSON 和 XML 以树形结构展示。
- **来源应用**：根据客户端源端口反查发起请求的本机应用。
- **过滤与搜索**：在界面中过滤和搜索请求列表。
- **系统代理管理**：开始抓包时自动设置系统代理，停止或退出时还原。设置前会把原配置落盘为快照；应用异常退出后，下次启动会按快照还原。
- **证书管理**：生成本地根 CA，并在界面中安装、卸载和查看信任状态。

## 平台支持

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 自动设置系统代理 | 有驱动 | 有驱动 | 无驱动 |
| 自动安装并信任根证书 | 有驱动 | 有驱动 | 无驱动 |
| 开始抓包 | 可用 | 可用 | 暂不可用 |

macOS 和 Windows 都有系统代理与证书信任的驱动实现。Linux 只有打包配置（AppImage、snap、deb）：证书信任状态恒为 `unsupported`，而开始抓包要求证书处于「已信任」状态，系统代理驱动也会直接报错，所以 Linux 上目前无法启动抓包。

## 工作原理

1. 点击「开始抓包」后，Reqeek 先检查根 CA 是否处于「已信任」状态。未信任时拒绝启动，界面会停在证书安装引导页。
2. 检查通过后，Reqeek 在 `127.0.0.1:8989` 启动代理。端口绑定成功后才修改系统代理，避免端口被占用时用户断网。
3. 明文 HTTP 请求直接转发并记录。
4. HTTPS 请求通过 `CONNECT` 进入代理。默认只对 443 端口解密；Apple 推送（`push.apple.com`、`push.services.apple.com`）和 OCSP 域名被内置排除，直接走隧道，只记录域名、流量大小和时长。
5. 停止抓包时先还原系统代理，再关闭代理服务。

监听地址固定为 `127.0.0.1`，只接受本机连接。代理端口在 `src/main/ipc/proxy.ts` 的 `PROXY_PORT` 中定义。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- pnpm 11.18.0（`package.json` 中通过 `packageManager` 指定）

### 安装依赖

```bash
pnpm install
```

`.npmrc` 把 Electron 和 electron-builder 的二进制下载源配置为 npmmirror（`electron_mirror` 和 `electron_builder_binaries_mirror` 两行），`electron-builder.yml` 的 `electronDownload.mirror` 打包时也指向 npmmirror。如果你在可以直接访问官方源的网络环境，可以删除这三处镜像配置。

### 开发

```bash
pnpm dev
```

### 类型检查

```bash
pnpm typecheck
```

### 预览构建产物

```bash
pnpm build
pnpm start
```

### 打包

```bash
pnpm build:mac     # macOS
pnpm build:win     # Windows
pnpm build:linux   # Linux
pnpm build:unpack  # 只生成未压缩的目录，用于本地检查
```

产物输出到 `dist/`（electron-builder 默认目录）。

## 使用方法

1. 启动应用，首次使用时按提示安装并信任 CA 证书。macOS 会弹出系统授权对话框，证书写入当前用户的登录钥匙串。
2. 点击「开始抓包」，或按 `Cmd/Ctrl + R`。
3. 在浏览器或其他应用中发起请求，请求会出现在列表里。
4. 选中一条请求查看请求头、响应头、body 和耗时。
5. 用完后停止抓包或直接退出，应用会还原系统代理设置。

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 开始 / 停止抓包 | `Cmd/Ctrl + R` |
| 清空记录 | `Cmd/Ctrl + K` |
| 搜索请求 | `Cmd/Ctrl + F` |

「帮助」菜单提供「在文件夹中显示 CA 证书」和「打开数据目录」。

## 项目结构

```text
src/
├── main/                   # Electron 主进程
│   ├── index.ts            # 应用入口、窗口、单实例锁、退出时还原代理
│   ├── menu.ts             # 应用菜单与快捷键
│   ├── ipc/                # 主进程与渲染进程的 IPC 通道
│   └── proxy/              # 代理核心（不依赖 electron）
│       ├── server.ts       # HTTP 代理、CONNECT 隧道、MITM、WebSocket 升级
│       ├── tunnel.ts       # 透明隧道
│       ├── filters.ts      # 解密范围过滤（端口、域名）
│       ├── capture.ts      # 请求头与 body 采集
│       ├── body-decode.ts  # 按 Content-Encoding 解码
│       ├── client-process.ts # 按源端口反查发起请求的应用
│       ├── ca/             # 根 CA 生成与各平台信任驱动
│       ├── mitm/           # TLS 解密层与回退策略
│       └── system-proxy/   # 各平台系统代理驱动与快照还原
├── preload/                # 预加载脚本，向渲染进程暴露受限 API
├── renderer/               # React 界面
│   └── src/
│       ├── components/     # 请求表、详情面板、过滤栏、JSON/XML 树等
│       ├── store/          # 请求数据状态
│       └── lib/            # 过滤、排序、分组、格式化工具
└── shared/
    └── types.ts            # 主进程与渲染进程共用的数据类型
```

代理核心只依赖 Node 内置模块，不引入 `electron`，需要时可以迁移到独立进程。

## 技术栈

- Electron 39
- React 19
- TypeScript 5.9
- electron-vite / Vite 7
- electron-builder
- `@peculiar/x509`（根 CA 与站点证书）

## 注意事项

- 根 CA 的证书和私钥保存在应用数据目录的 `ca/` 下（`ca.pem` 和 `ca.key`），可以通过「帮助 → 打开数据目录」找到。信任这张证书后，持有私钥的人可以伪造任何 HTTPS 站点，请不要分享 `ca.key`。不再使用时，请在界面中卸载证书。
- 使用证书固定（certificate pinning）的应用会拒绝被解密，这类流量只能以隧道形式记录。
- 请只在自己拥有或获得授权的设备和网络流量上使用本工具。
- 同一时间只允许运行一个实例，避免两个实例互相还原对方的系统代理设置。

## 许可证

本项目采用 [MIT License](./LICENSE)。
