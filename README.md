# AetherLog 🪶

> **Omni-Trace for Obsidian**: 全局剪贴板追踪、速记面板与自动化日志归档的智能插件。

AetherLog（以太日志）是一款在后台静默运行的 Obsidian 插件，自动捕获系统剪贴板流转与全局文本操作，将碎片化数据结构化沉淀到您的 Obsidian Vault 中，让每一丝灵感与操作痕迹都能被完美追溯。

**当前版本**: v1.0.0（MVP 已交付，100/100 验收通过）

---

## ✨ 核心特性

### 📋 剪贴板追踪
- 200ms 轮询 + Focus 补采集双保险，不遗漏任何复制内容
- 自动识别 10 类内容类型（URL / Email / Code / JSON / XML / HTML / CSS / Markdown / Path / 普通文本）
- 中英混合语言检测 + 字数统计 + 来源应用识别
- 敏感内容自动拦截（密码 / UUID / 银行卡号默认黑名单）
- 双重去重：监听器层 LRU 哈希缓存 + 仓储层当日正则锚点拒绝

### 💡 速记面板
- `Ctrl+Alt+Q` 快捷键或 Ribbon 图标一键唤起，一打开即可打字（3 次重试强制聚焦）
- 5 预设分类（灵感 / 待办 / 摘抄 / 想法 / 备忘）+ 自定义
- Obsidian 原生标签搜索联想（最多 8 候选，pill chip 样式）
- Enter / Ctrl+Enter 双提交模式，Esc 丢弃，`Ctrl+Shift+C` 复制

### ⚙️ 设置面板
- 9 大分区完整 UI：状态监控 / 剪贴板 / 速记 / 语音 / 托盘 / 写入规则 / 智能去重 / 数据管理 / 关于
- 热更新：监听间隔、开关等字段修改后即时生效
- Coming Soon 灰化：未实现功能统一视觉灰化 + 悬停 Phase 标签
- 版本迁移框架：升级自动补填默认值，用户自定义不受影响

### 🔔 托盘集成
- 右键 3 菜单项：打开速记 / 打开今日日志 / 打开设置
- 未读红点 1.5s 闪烁提示
- 关闭窗口最小化到托盘（高风险功能，默认关闭，用户主动开启）
- 「退出 AetherLog」逃生通道
- Windows 开机自启动

### 🗂️ 日文件自动归档
- 按 `yyyy/MM/yyyy-MM-dd-aetherlog.md` 路由（子目录自动创建）
- 3 种 Callout 分组：剪贴板（蓝）/ 速记（绿）/ 语音（紫，Phase 2）
- 每条记录 8 字段元信息 + 结构化多级标签 + 原文独立代码块
- 新记录置顶，分组计数动态维护，空分组自动清理

### ⌨️ 全局快捷键
- Electron globalShortcut 注册，任意应用中可唤起速记面板
- 注册冲突自动提示更换组合键
- 插件卸载自动注销，不影响其他应用热键

---

## 🚀 快速开始

### 安装

1. **克隆仓库**
   ```bash
   git clone https://github.com/LINYF510/AetherLog.git
   cd AetherLog
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **构建**
   ```bash
   npm run build
   ```

4. **部署到 Obsidian**
   - 将 `dist/main.js`、`dist/styles.css`、`manifest.json` 复制到 Vault 的 `.obsidian/plugins/aetherlog/` 目录
   - 在 Obsidian 中 `设置 → 第三方插件` 启用 AetherLog
   - 建议搭配 [Hot-Reload](https://github.com/pjeby/hot-reload) 插件提升开发效率

> 也可执行 `npm run postbuild` 自动复制到默认测试 Vault。

### 使用

- **复制任意文本** → 自动写入当天日文件（蓝色 Callout 分组）
- **按 `Ctrl+Alt+Q`** → 打开速记面板，输入内容后 `Ctrl+Enter` 提交（绿色 Callout 分组）
- **右键系统托盘图标** → 打开速记 / 今日日志 / 设置
- **打开设置面板** → 自定义监听间隔、黑名单规则、托盘行为等

---

## ️ 开发指南

### 命令速查

```bash
npm install          # 安装依赖（首次克隆后执行一次）
npm run dev          # 开发模式：watch 监听源码变更并自动重新构建
npm run check        # 类型检查（tsc --noEmit，要求 0 error）
npm run build        # 完整构建 + 自动安装到 Obsidian 测试库（postbuild 钩子）
```

### 构建生效方式

在 Obsidian 中 `设置 → 第三方插件` 找到 AetherLog 卡片 → **先禁用再重新启用**（或重启 Obsidian）即可加载最新构建。

### 常见报错排查

1. **Obsidian 提示"未检测到插件 / manifest 缺失"**：检查 `.obsidian/plugins/aetherlog/` 目录下 `manifest.json` 是否存在（重新执行 `npm run build`）。
2. **改了代码但插件行为没变化**：确认执行过 `npm run build` 或 `npm run dev` 处于 watch 运行中，且 Obsidian 中已禁用再启用插件。
3. **构建失败：TypeScript 类型报错**：运行 `npm run check` 查看具体报错行；本项目 `strict: true` 禁止隐式 any，补全类型注解后重新构建。

### 技术栈

- TypeScript（strict 模式）+ Obsidian Plugin API
- ESBuild 构建（CJS 产物，~112KB）
- Electron Tray（window.require 运行时获取，零静态依赖）
- 分层架构 + Strategy/Repository 接口抽象

---

## ️ 开发路线图

### ✅ Phase 1: MVP（v1.0.0 已交付）
- [x] 项目初始化与基础架构搭建
- [x] 系统剪贴板实时监听与去重过滤
- [x] 剪贴板数据向日文件自动归档（Callout 分组 + 元信息）
- [x] 速记面板（快捷键唤起 + 分类/标签 + 双提交模式）
- [x] 设置面板（9 分区 + 热更新 + 版本迁移）
- [x] 托盘集成（菜单 + 未读红点 + 最小化 + 退出 + 开机自启）
- [x] 全局快捷键（任意应用唤起速记）
- [x] 默认黑名单（密码 / UUID / 长数字自动拦截）

### 🔜 Phase 2: 语音与增强
- [ ] 语音转写接入（CapsWriter-Offline HTTP API，接口已预留）
- [ ] 图片 / 富文本捕获
- [ ] 存储模式扩展（按周 / 月 / 自定义分割）
- [ ] 全局搜索 + 关键词索引 + 时间轴视图
- [ ] 后台节流补偿（visibilitychange 事件）

### 🔮 Phase 3: 智能分析
- [ ] AetherLog 专属检索面板
- [ ] 自动标签化（Auto-tagging）
- [ ] 数据导出（JSON / CSV）
- [ ] 统计仪表盘

---

## 📄 已知限制

| 限制 | 说明 | 计划 |
|------|------|------|
| 语音转写 | 接口已预留，未接入 | Phase 2 |
| 图片/富文本 | 仅支持纯文本 | Phase 2 |
| 移动端托盘 | 不支持（自动降级） | 不适用 |
| 来源应用识别 | 尽力而为 Unknown 兜底 | Phase 2 |
| 后台节流 | Obsidian 后台超 5 分钟轮询降到 ~1 次/分钟 | Phase 2 |

---

## 🤝 贡献与反馈

如果您有任何功能建议、架构优化意见或发现了 Bug，欢迎提交 Issue 或 Pull Request。

## 📄 开源许可

本项目采用 [MIT License](LICENSE) 开源协议。
