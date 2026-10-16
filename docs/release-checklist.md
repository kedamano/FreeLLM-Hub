# 发布检查清单

## 代码质量

- [ ] 所有单元测试通过 (`npm test`)
- [ ] 无 TypeScript 编译错误 (`npm run typecheck`)
- [ ] ESLint 无错误 (`npm run lint`)
- [ ] Prettier 格式一致 (`npm run format`)
- [ ] 无控制台遗留敏感数据

## 功能验证

- [ ] 应用启动后显示仪表盘
- [ ] IPC 通信正常（前端和服务端）
- [ ] Gateway 健康检查通过
- [ ] 模型列表正确加载
- [ ] OAuth/API Key 配置流程正常
- [ ] 熔断器状态可重置
- [ ] 调用日志正确记录

## 安全审查

- [ ] 无硬编码凭证
- [ ] CSP 配置正确
- [ ] contextIsolation 启用
- [ ] nodeIntegration 禁用
- [ ] 凭证加密存储可用
- [ ] 日志脱敏工作正常

## 打包前置

- [ ] 图标资源为最新（`npm run gen:icons`，一次产出 `icon.ico`、`icon.png`、`icon.icns`、`tray.png` 与 `linux/<size>x<size>.png`）
- [ ] 三平台产物分别在同平台构建：macOS 的 `.app/.dmg` 无法从 Linux/Windows 交叉产出，`scripts/package.mjs` 会直接拒绝并提示改用 `macos-latest` runner
- 本地非管理员且未开启 Windows「开发者模式」时，electron-builder 解包 winCodeSign 会因无法创建符号链接而失败；CI 的 windows runner 不受影响，本地验证可临时追加 `-c.win.signAndEditExecutable=false`（会跳过 exe 图标与版本信息写入）
- CI 未配置证书时 macOS 走 `identity: null` 的 ad-hoc 签名（本机能跑，对外分发需公证）；`CSC_IDENTITY_AUTO_DISCOVERY=false` 已在 workflow 里设好，避免无证书时卡住

## 打包验证：Windows

- [ ] NSIS 安装包正常创建
- [ ] Portable 版本正常创建
- [ ] 安装后应用正常启动
- [ ] 应用退出后托盘图标正确隐藏
- [ ] 数据目录在 `%APPDATA%/FreeLLM Hub` 正确位置

## 打包验证：macOS

- [ ] `release/*.dmg` 在 x64 与 arm64 上各一份，能挂载并拖入「应用程序」
- [ ] 首次启动的 Gatekeeper 提示符合预期（未公证版本会要求右键「打开」）
- [ ] Dock 图标、菜单栏托盘图标显示正常
- [ ] `~/Library/Application Support/FreeLLM Hub` 下生成 `freellm-hub.db`、`credentials.key`、`logs/`
- [ ] Cmd+Q / 关闭主窗口后的托盘驻留行为正确

## 打包验证：Linux

- [ ] `FreeLLM Hub-<ver>-x86_64.AppImage` 在 `chmod +x` 后可直接运行（无需 FUSE 的环境用 `--appimage-extract-and-run`）
- [ ] `.deb` 安装后应用菜单图标、`freellm-hub` 可执行名正确
- [ ] `tar.gz` 解包即可运行，用于无包管理器的服务器
- [ ] 数据目录落在 `~/.config/FreeLLM Hub`（Electron `userData`）
- [ ] 窗口与托盘图标使用 PNG（`.ico` 在 Linux 下会被忽略）

## CI 产物

- [ ] `.github/workflows/ci.yml` 的 `package` job 全绿，四个 matrix 组合各自的 artifact 名称为
      `freellm-hub-{windows-x64,linux-x64,linux-arm64,macos-universal}`
- [ ] 下载产物后本地校验版本号与 `package.json` 一致
- [ ] `if-no-files-found: error` 生效：某个平台没产出文件时任务应失败，而不是给出空包

## 文档

- [ ] README 更新到最新版本
- [ ] API 文档与实际一致
- [ ] 架构文档反映当前设计
- [ ] 发布说明 (Release Notes) 完成
