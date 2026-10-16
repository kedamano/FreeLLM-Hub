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

- [ ] 图标资源为最新（`npm run gen:icons` 重新生成 `resources/icons/icon.ico|icon.png|tray.png`）
- 本地非管理员且未开启 Windows「开发者模式」时，electron-builder 解包 winCodeSign 会因无法创建符号链接而失败；CI 的 windows runner 不受影响，本地验证可临时追加 `-c.win.signAndEditExecutable=false`（会跳过 exe 图标与版本信息写入）

## 打包验证

- [ ] NSIS 安装包正常创建
- [ ] Portable 版本正常创建
- [ ] 安装后应用正常启动
- [ ] 应用退出后托盘图标正确隐藏
- [ ] 数据目录在 AppData 正确位置

## 文档

- [ ] README 更新到最新版本
- [ ] API 文档与实际一致
- [ ] 架构文档反映当前设计
- [ ] 发布说明 (Release Notes) 完成
