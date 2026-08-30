# Changelog

All notable changes to the AetherLog project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] - 2026-08-31

### Fixed
- 🐛 **托盘单击无响应（G3·修复）**：修复最小化到托盘后左键单击托盘图标无法恢复 Obsidian 主窗口的问题（原实现只注册了右键菜单，Electron 在 Windows 上不会因左键点击自动恢复窗口；现显式监听托盘 `click` / `double-click` 事件调用 `showMainWindow()`，destroy 时精确移除监听保持幂等）
- 🐛 **来源应用始终 Unknown（M2·修复）**：修复剪贴板捕获记录的来源应用字段恒为 `Unknown` 的问题。两层根因：① 原实现经 `requireFn('electron').remote` 获取聚焦窗口，`electron.remote` 在 Electron 14+ 已移除（Obsidian 现为 Electron 39），该解析链从未生效；② 即使修好，`BrowserWindow.getFocusedWindow()` 只能看到 Obsidian 自身窗口——外部应用复制时 Obsidian 不聚焦，必然返回 `Unknown`。现剪贴板捕获改用异步主力解析链：Windows 下经 PowerShell 查询 Win32 剪贴板所有者进程（`GetClipboardOwner` → `GetWindowThreadProcessId` → `Get-Process`），所有者为最后一次写入剪贴板的窗口、与当前焦点无关，可可靠识别真实来源应用（纯子进程方案，无 native addon 依赖）；失败降级到原同步链（已同步修复为 `@electron/remote` 优先）

### Changed
- 来源应用显示为进程名（如 `chrome` / `WeChat` / `Obsidian`），不做友好名映射；每次捕获新内容会启动一次 PowerShell 子进程（约 0.3~1s，异步不阻塞 UI）

---

## [1.0.0] - 2026-08-29

### Added（MVP · Phase 1 完整交付）
- 📋 **剪贴板监听（M2）**：200ms 轮询 + focus 补采集双保险；自动识别 10 类内容类型（URL / Email / Code / JSON / XML / HTML / CSS / Markdown / Path / 普通文本）与中英混合语言；8 字段元信息落盘（timestamp / appName / hash / wordCount / contentType / language / category / tags）
- 💡 **速记面板（M5）**：Modal 模态框 600×480；「3 次重试强制聚焦」一打开即可打字（rAF + setTimeout 指数退避双保险）；5 预设分类下拉 + 自定义；Obsidian 原生 MetadataCache 标签搜索联想（最多 8 候选，pill 样式 chip）；Enter / Ctrl+Enter 双提交模式；Esc 丢弃 + Ctrl+Shift+C 复制；Phase 2 语音按钮占位（NotImplemented Notice）
- ⚙️ **设置面板（M6）**：9 个 Section 完整 UI（状态监控 / 剪贴板 / 速记 / 语音-Coming Soon / 托盘 / 写入规则 / 智能去重 / 数据管理 / 关于）；动态热更新（改监听间隔/开关即时生效）+ 冷重启提示（路径/格式类）；Coming Soon 灰化（opacity:0.6 + grayscale + 悬停 Phase 标签 + NotImplemented Notice）；滑杆 clamp 保护
- 🔔 **托盘集成（M7）**：Electron 原生 Tray（含非桌面端环境自动降级不抛错，零静态/动态 import electron，window.require 模式完全绕开 esbuild external 问题）；3 菜单项（打开速记 / 打开今日日志 / 打开设置）顺序正确；未读红点 1.5s 闪烁（默认 + 徽标两态 16×16 RGBA PNG base64 内嵌）；200ms 轮询检测新记录
- 🗂️ **日文件写入（M3）**：按 `yyyy/MM/yyyy-MM-dd-aetherlog.md` 路由（子目录自动 createFolder）；3 种 Callout 分组（Clipboard 蓝 note / QuickNote 绿 tip / Voice 紫 example，Phase 2 占位）；元信息 8 字段 + 原文独立代码块；空分组自动移除；分组 N 计数动态维护；双重 Vault 原子写入（process + modify 双路径兜底）
- ♻️ **双重去重（S13）**：监听器层 LRU 哈希缓存（1800s TTL）+ 仓储层当日正则锚点拒绝；重复内容不重复写日文件
- 🧹 **一键清空（S17）**：软删除到 Vault 根下 `aetherlog_trash_YYYYMMDD_HHMMSS/` 文件夹备份（真删除需用户手动清空，防止误操作）
- 🌱 **脚手架与类型（M1）**：完整 6 层目录；7 份 TypeScript 接口（含 5 大核心服务 Strategy/Repository 接口抽象）；tsconfig strict:true + esbuild CJS 产物；.gitignore 全量覆盖；settings 版本迁移框架（migrateSettings 深合并 + MIGRATIONS 数组可扩展）
- ⌨️ **全局快捷键（S8）**：Electron globalShortcut 唤起速记面板，任意应用中可触发（注册成功后 OS 级拦截，Obsidian 聚焦时 addCommand 同款热键不会重复触发，属预期行为）；注册冲突 Notice 提示更换；onunload 自动注销（仅注销本插件组合键，严禁 unregisterAll）；设置面板热更新经 app.aetherlog.reloadGlobalShortcut 桥接生效
- 🚫 **默认黑名单（S16）**：预置密码 / UUID / 长数字 3 条正则（防密码、UUID、银行卡号等敏感内容误存）
- 🚪 **最小化到托盘 + 退出 + 自启（G3）**：关闭窗口最小化到托盘（高风险功能，默认关闭，用户主动开启；拦截器动态读取设置，关闭开关即时恢复默认关窗行为）；托盘菜单新增「退出 AetherLog」逃生通道（confirm 确认后真关闭 Obsidian）；开机自启动（Windows shell:Startup 快捷方式，PowerShell 创建/删除，设置成功才持久化开关）

### Fixed
- 🐛 **托盘（C5）**：修复 Menu 校验 typeof 断言错误导致托盘永久降级的问题
- 🐛 **托盘设置跳转（G1）**：修复托盘「设置」菜单项点击无反应的问题（设置 Modal 未挂载时 openTabById 不生效，须先 setting.open() 再切 Tab）
- 🩹 **日文件 callout 分块（G2）**：修复剪贴板与速记 Callout 分组之间空行不足导致 Obsidian 渲染为同一 callout 块的问题（新分组前后各保留 2 个空行，空分组首条记录后补 1 个空行）
- 🐛 **最小化到托盘不生效（G3·二次修复）**：修复关闭窗口直接整个 Obsidian 退出的问题（v1 经 @electron/remote 注册的 close 回调经异步 IPC 转发，preventDefault 为时已晚；改为渲染进程 beforeunload 同步拦截 + remote close 事件转发做关闭意图预检，区分窗口关闭与页面 reload（切换 vault / Ctrl+R 不误拦）；托盘菜单「速记 / 今日日志 / 设置」动作前自动恢复主窗口）
- 🐛 **最小化到托盘仍全退（G3·三次修复）**：v2 的 beforeunload 拦截被 closeIntent 预检门控，而该标志依赖的 remote close 事件转发在 Electron 39 上晚于 beforeunload 分发（甚至不转发），拦截被跳过。对齐社区已验证方案（Synaphi/background-tray，Obsidian 1.12 / Electron 39 实测）：beforeunload 开关开启即无条件拦截（preventDefault + returnValue=false + 同步 hide），remote close 事件降级为兜底层（Electron 39 上其 preventDefault 实测被忽略）
- 🩹 **设置面板（B6）**：修复黑名单设置控件误标 Coming Soon 的问题
- 🔁 **默认黑名单（B6·二）**：修复默认黑名单对存量升级用户不生效的问题（深合并保留旧空数组顶掉默认值，新增 v1→v2 Migration 空数组补填 + settingsVersion 写回持久化）；修复密码正则误伤含空格正常句子的问题（加 \S 无空白约束）

### Changed
- 项目从「无结构草稿」迁移为 AGENTS.md 规范的标准 Obsidian Plugin 工程（按 AGENTS.md v1.0 约束落地）

### Known Limitations（MVP 阶段已知限制，Phase 2/3 修复）
- 🎙️ 语音转写功能 Phase 2 推出（已预留 IVoiceCapture 接口占位 + CapsWriter-Offline HTTP API 方案，Settings 语音后端选择项 Coming Soon 灰化）
- 🖼️ 图片/富文本捕获 Phase 2 推出（MVP 仅支持纯文本剪贴板 + 速记）
- 📱 移动端 Obsidian 无托盘功能（TrayManager.init 检测非桌面端自动返回 false，不会抛错，无需外层 try/catch）
- 🔍 全局搜索 + 关键词索引 + 时间轴视图 Phase 2 推出（当前仅日文件倒序浏览 + Vault 原生全文搜索）
- 📊 来源应用识别为「尽力而为 Unknown 兜底」策略（Win 下受限 Obsidian 沙箱，不引入 native addon）
- 🔗 快捷方式录制在 Settings Tab 中为自定义实现（MVP 暂未接 Obsidian 原生 addHotkey 录制控件；预设 Mod+Alt+Q 已通过命令注册表正确工作）
