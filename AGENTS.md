# AetherLog 项目 AI 维护规范

> 本文档定义 AI Agent 在开发和维护 AetherLog 项目时必须遵守的规则与约定。

---

## 📌 项目概览

- **项目名称**: AetherLog (以太日志)
- **项目类型**: Obsidian 插件 (TypeScript + Obsidian Plugin API)
- **核心功能**: 全局语音捕获、剪贴板追踪、自动化日志编排
- **技术栈**: TypeScript, Node.js, Obsidian Plugin API, ESBuild
- **仓库位置**: `c:\Users\Fancy\.trae-cn\worktrees\AetherLog\init-project-structure-AlK6MG`
- **文档仓库**: 所有项目文档存放在 `docs/` 目录下（代码仓库根目录）
- **Obsidian 笔记仓库**: `D:\学习笔记\Obsidian\FancyLin-Notes-Work\Project\aetherlog\`

---

## 🏗️ 目录结构规范

```
AetherLog/
├── AGENTS.md              # [本文件] AI 维护规范（AI 必读）
├── README.md              # 项目说明文档
├── .gitignore             # Git 忽略规则
├── docs/                  # 🔴 所有项目文档存放位置
│   ├── requirements/      # 需求文档
│   ├── design/            # 设计文档（架构、UI、数据库等）
│   ├── api/               # API 文档
│   ├── meetings/          # 会议记录
│   └── notes/             # 开发笔记、问题记录、草稿
├── src/                   # 源代码目录
│   ├── main.ts            # 插件入口
│   ├── settings.ts        # 设置面板
│   ├── services/          # 核心服务（剪贴板、语音识别等）
│   ├── utils/             # 工具函数
│   └── types/             # TypeScript 类型定义
├── styles.css             # 插件样式
├── manifest.json          # Obsidian 插件清单
├── package.json           # Node.js 依赖配置
├── tsconfig.json          # TypeScript 配置
└── esbuild.config.mjs     # ESBuild 构建配置
```

### 目录创建规则

- **禁止随意在根目录创建文件夹**，新模块代码统一放入 `src/` 下对应子目录
- **所有文档必须放入 `docs/` 目录下**，按文档类型分子目录存放
- 新增子目录前先检查是否已有对应目录，避免重复
- `docs/` 下的子目录按需创建，不强制创建空目录

---

## 📝 文档编写规范

### 文档存放位置

| 文档类型 | 存放路径 | 命名规则 |
|---------|---------|---------|
| 需求文档 | `docs/requirements/` | `YYYY-MM-DD_{需求标题}.md` |
| 设计文档 | `docs/design/` | `v{版本号}_{设计主题}.md` 或 `YYYY-MM-DD_{设计主题}.md` |
| API 文档 | `docs/api/` | `{模块名}_API.md` |
| 会议记录 | `docs/meetings/` | `YYYY-MM-DD_{会议主题}_会议记录.md` |
| 开发笔记 | `docs/notes/` | `YYYY-MM-DD_{笔记主题}.md` |
| AI 对话记录 | `docs/notes/` | `YYYY-MM-DD_{主题}_对话记录.md` |

### 文档标签体系（Obsidian 双链兼容）

在每个文档的 Frontmatter 中添加标签：

```yaml
---
tags:
  - Project/aetherlog
  - doc/{类型}          # requirement / design / api / meeting / notes
  - status/{状态}        # draft / review / done / archived
  - priority/{优先级}    # p0 / p1 / p2 / p3
  - tech/{技术名}        # 如 tech/typescript, tech/obsidian
  - domain/{领域}        # 如 domain/desktop, domain/productivity
date: YYYY-MM-DD
author: AI / FancyLin
---
```

### 文档编写要求

1. **中文为主**：面向国内开发者，统一使用中文编写文档，技术术语保留英文原文
2. **结构清晰**：使用层级标题（H1-H4），开头提供文档摘要
3. **实时更新**：代码变更后同步更新相关文档，避免文档与代码脱节
4. **关联引用**：相关文档之间使用 Obsidian 双链语法 `[[文档名]]` 互相关联
5. **版本追溯**：重大变更保留历史版本，旧版本归档至 `docs/` 对应目录的 `history/` 子目录

---

## 💻 代码编写规范

### 语言与框架

- **TypeScript 严格模式**：必须开启 `strict: true`，禁止使用 `any`（除非有充分理由并添加注释）
- **ESM 模块**：使用 ES Module 语法 (`import/export`)，不使用 CommonJS
- **Obsidian API 规范**：严格遵循 [Obsidian Plugin API](https://docs.obsidian.md/) 最佳实践

### 命名规范

| 类型 | 规范 | 示例 |
|-----|-----|------|
| 文件/文件夹 | kebab-case | `clipboard-service.ts`, `voice-capture/` |
| 类/接口/类型 | PascalCase | `ClipboardService`, `VoiceCaptureConfig` |
| 函数/方法/变量 | camelCase | `getClipboardText()`, `isRecording` |
| 常量 | UPPER_SNAKE_CASE | `MAX_CLIPBOARD_HISTORY`, `DEFAULT_OUTPUT_PATH` |
| 组件（如适用） | PascalCase | `SettingsTab`, `CaptureButton` |

### 代码风格

- 缩进：2 空格
- 行尾：无分号（或统一，以 `.prettierrc` 为准）
- 引号：优先单引号
- 行宽：建议不超过 120 字符
- **必须添加类型注解**：函数参数、返回值、类成员变量
- **JSDoc 注释**：公共 API 和复杂逻辑必须添加 JSDoc 注释说明用途、参数、返回值

### Obsidian 插件特殊规范

1. **Manifest 同步**：修改版本号时，`manifest.json` 和 `package.json` 必须同时更新
2. **资源释放**：所有 `registerXXX` 注册的资源必须在 `onunload()` 中正确释放
3. **设置持久化**：新增设置项必须：
   - 在接口中定义类型
   - 提供默认值
   - 在 SettingsTab 中添加 UI
   - 在 `loadData()` / `saveData()` 中处理
4. **Vault 操作安全**：所有文件读写操作必须使用 Obsidian 提供的 `Vault` API，禁止直接使用 Node.js `fs`

---

## 🔀 Git 工作流规范

### 分支命名

| 分支类型 | 命名格式 | 示例 |
|---------|---------|------|
| 功能开发 | `feat/{功能描述}` | `feat/clipboard-listener` |
| Bug 修复 | `fix/{问题描述}` | `fix/settings-not-saving` |
| 文档更新 | `docs/{更新主题}` | `docs/api-clipboard-service` |
| 重构 | `refactor/{模块名}` | `refactor/voice-module` |
| 热修复 | `hotfix/{版本号}` | `hotfix/v1.0.1-crash` |

### 提交信息规范（Conventional Commits）

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type 类型**：
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档变更
- `style`: 代码格式调整（不影响逻辑）
- `refactor`: 重构（非新功能也非 Bug 修复）
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具链/依赖变更

**示例**：
```
feat(clipboard): 实现剪贴板实时监听与去重过滤

- 添加系统剪贴板轮询监听机制
- 实现基于内容哈希的重复数据过滤
- 新增设置项：监听间隔、忽略白名单

Closes #12
```

---

## ✅ AI 操作检查清单

AI 在完成任何代码或文档修改后，**必须逐项自查**：

### 代码修改检查
- [ ] TypeScript 类型是否完整？有无遗漏的类型注解？
- [ ] 有无使用 `any`？是否可以替换为更精确的类型？
- [ ] 公共 API 是否已添加 JSDoc 注释？
- [ ] 新增的 `registerXXX` 是否在 `onunload()` 中释放？
- [ ] 设置项是否已更新类型、默认值、UI、持久化逻辑？
- [ ] 代码是否通过 TypeScript 编译检查 (`npm run build`)？

### 文档修改检查
- [ ] 文档是否放在了正确的子目录下？
- [ ] 文件名是否符合命名规则（日期前缀 + 中文标题）？
- [ ] Frontmatter 标签是否完整？
- [ ] 相关文档之间是否添加了双链引用？

### 提交前检查
- [ ] `.gitignore` 是否覆盖了新产生的临时/构建文件？
- [ ] 未将敏感信息（API Key、路径等）提交到代码库？
- [ ] `manifest.json` 版本号是否需要同步更新？

---

## 📚 参考资源

- [Obsidian Plugin Developer Docs](https://docs.obsidian.md/Home)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- 全局维护规范：`D:\学习笔记\Obsidian\FancyLin-Notes-Work\Project\AGENTS.md`
- 全局文档模板：`D:\学习笔记\Obsidian\FancyLin-Notes-Work\Templet\Project\`

---

**版本**: v1.0
**最后更新**: 2026-08-28
**维护者**: FancyLin + AI
