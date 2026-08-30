/**
 * AetherLog 设置项类型定义与默认值
 * 严格对齐 docs/api/settings_API.md v1.0（C 窗口设置面板的唯一依赖，字段不得擅自增删改名）
 */

/** 捕获内容类型选择集 */
export interface CaptureContentTypes {
  /** 纯文本（MVP 可用）：系统剪贴板 CF_TEXT 格式 */
  plainText: boolean
  /** 富文本 HTML（Phase 2）：剪贴板 CF_HTML，经 turndown 转 Markdown 落盘 */
  richTextHtml: boolean
  /** 图片（Phase 2）：剪贴板 CF_BITMAP / CF_DIB，转 PNG 存入附件文件夹 */
  image: boolean
  /** 文件路径（Phase 2）：剪贴板 CF_HDROP，记录路径列表，不移动原文件 */
  filePath: boolean
}

/** 速记面板写入存储模式 */
export type QuickNoteStorageMode =
  | 'merge-clipboard' /** 默认：并入同日剪贴板日文件，仅以 Callout 颜色区分来源 */
  | 'separate' /** 独立速记日文件夹：aetherlog/quick-notes/YYYY-MM-DD.md */
  | 'daily-notes' /** 写入 Obsidian 原生 Daily Notes，对应章节 */

/** 语音识别后端选择 */
export type VoiceBackendMode =
  | 'disabled' /** MVP 默认：Coming Soon，语音按钮灰掉 */
  | 'capswriter' /** Phase 2 推荐：本地 CapsWriter-Offline HTTP 服务 */
  | 'webspeech' /** Phase 2 备选：浏览器原生 Web Speech API（联网用 Google/系统引擎） */

/**
 * AetherLog 设置项顶级接口
 *
 * 字段命名规则：
 * - 布尔开关：{模块}Enabled / showXxx / includeXxx / autoStartXxx
 * - 路径：{模块}Path / {模块}BaseUrl
 * - 数字：{模块}Ms / {模块}Chars / xxxCount / xxxInterval
 * - 集合：{xxx}Array / {xxx}List / {xxx}Map（此处统一用数组）
 * - 枚举：xxxMode / xxxType
 *
 * ⚠️ 新增字段注意：
 *   1. 必须在 DEFAULT_SETTINGS 中提供默认值（旧用户升级自动补默认）
 *   2. 必须在 SettingsTab 中提供对应控件（或明确标注 UI Coming Soon）
 *   3. 必须在 loadData 合并逻辑中处理缺失情况
 */
export interface AetherLogSettings {
  /** S1: 剪贴板监听总开关；关闭后 PollingListener 停止 setInterval */
  clipboardEnabled: boolean
  /** S2: 剪贴板日文件输出根路径，相对于 Vault 根，不允许包含 ../ */
  clipboardOutputPath: string
  /** S4: 轮询间隔，单位毫秒；范围 50~2000，步长 50，默认 200 */
  clipboardPollingIntervalMs: number
  /** S5: 捕获内容类型开关集合；MVP 仅 plainText 可改，其他三项 UI 置灰 */
  captureContentTypes: CaptureContentTypes
  /** S3: 单条捕获内容最大字数（字符数），超限截断并追加 #type/truncated 标签；0 = 不限制（不推荐） */
  maxContentLengthChars: number

  /** S7: 速记功能总开关；关闭后 Modal/命令/快捷键全部取消注册（托盘菜单保留但 disabled） */
  quickNoteEnabled: boolean
  /**
   * S8: 速记面板全局快捷键字符串
   * 格式：Electron globalShortcut 标准格式字符串，如 'Ctrl+Alt+Space'
   * 支持修饰键：Ctrl / Alt / Shift / Super (Cmd on Mac)
   * 支持键：A-Z / 0-9 / F1-F24 / Space / Enter / Esc / 箭头方向等
   */
  quickNoteShortcut: string
  /** S9: 速记内容写入存储模式，三选一 */
  quickNoteStorageMode: QuickNoteStorageMode
  /** S9 辅助：quickNoteStorageMode === 'separate' 时的独立存储根路径 */
  quickNoteSeparatePath: string
  /** S9 辅助：quickNoteStorageMode === 'daily-notes' 时写入 Daily Notes 的段落标题，默认 '## 💡 AetherLog 速记' */
  quickNoteDailyNotesHeading: string
  /**
   * S10: 速记分类预设列表（可拖拽排序）
   * 每个字符串为中文分类名，最终转换为标签 #category/{分类名}
   * 分类名允许包含中文/英文/数字/下划线/空格，不允许 : # [ ] / \ 等 Markdown 特殊字符
   */
  quickNoteCategories: string[]

  /** 语音后端选择模式；MVP 阶段强制禁用（settings.ts 中 dropdown 全部置灰） */
  voiceBackend: VoiceBackendMode
  /** CapsWriter HTTP 服务 Base URL（含协议 + IP/域名 + 端口，不含路径） */
  capswriterBaseUrl: string
  /** 预留：若 CapsWriter 启用 API Key 鉴权，填在这里；保存时自动 base64 混淆 */
  capswriterAuthToken: string
  /** Web Speech API 语言代码，如 'zh-CN' / 'en-US'；默认跟随 Obsidian i18n 语言设置 */
  webSpeechLang: string

  /** S17: 启用系统托盘；初始化检测 Electron 不支持时，此字段会被置 false 并持久化，避免每次启动都尝试再失败一遍 */
  trayEnabled: boolean
  /** 捕获成功后是否弹系统气泡通知；剪贴板节流为 60s/次，速记/语音无限制 */
  showTrayNotification: boolean
  /** 剪贴板通知节流间隔（秒），默认 60；0 = 关闭剪贴板通知节流（不推荐刷屏） */
  clipboardNotifyThrottleSecs: number
  /** G3: 关闭主窗口时最小化到托盘（高风险，默认 false，需用户主动开启；依赖托盘功能） */
  minimizeToTrayOnClose: boolean
  /** G3: 开机自启动（Windows shell:Startup 快捷方式，默认 false） */
  autoStartOnBoot: boolean

  /** S18: Obsidian 启动加载插件后是否自动开启剪贴板监听 */
  autoStartCaptureOnLoad: boolean

  /** 长正文自动包 details 折叠的字数阈值；默认 500；0 = 永不折叠（不推荐长文刷屏） */
  foldContentThresholdChars: number
  /** 是否在日文件顶部写入统计信息头；关闭后仅写 YAML frontmatter，减少回写次数 */
  includeDailyStatsHeader: boolean
  /**
   * 记录之间的分割线字符串
   * 默认 50 个 Box drawing U+2500 '─' 字符（视觉比 --- 细且不被 Markdown 解析为标题分割）
   * 可自定义，但不能是空串（会导致记录无法区分边界）
   */
  recordSeparatorLine: string
  /** 日文件名日期格式；moment() 格式字符串，默认 'YYYY-MM-DD'；不允许包含路径分隔符 */
  dailyFileNameDateFormat: string

  /** S13: 是否启用哈希去重；关闭 = 全量存（MVP 默认 false） */
  dedupeEnabled: boolean
  /** S14: 去重回看窗口条数：只和最近 N 条的哈希对比，默认 50；0 = 和当天全量对比（性能差） */
  dedupeLookbackWindow: number
  /** S15: 来源应用黑名单（进程名，如 'Bitwarden.exe'，大小写不敏感，精确匹配） */
  sourceAppBlacklist: string[]
  /** S16: 内容关键字黑名单（支持子串匹配，含任一关键字则不存储） */
  keywordBlacklist: string[]
  /**
   * S16 辅助：关键字黑名单匹配模式
   * substring = 子串包含即命中（默认，性能好，易误伤）
   * word      = 完整词边界命中（需要英文 \b 或中文前后空白，准确率高）
   * regex     = 用户填入每个字符串都是正则表达式（高级用户，注意防 ReDoS）
   */
  keywordBlacklistMode: 'substring' | 'word' | 'regex'

  /**
   * 设置结构版本号（内部元数据，非用户设置项，SettingsTab 不提供 UI）
   * 由 migrateSettings 迁移完成后写入返回值，随 saveData 持久化到 data.json，
   * 下次启动 readVersion 直接命中，避免迁移链每次启动重复执行。
   */
  settingsVersion?: number
}

/** 设置持久化的当前结构版本号（v2：keywordBlacklist 空数组补填默认黑名单） */
export const SETTINGS_VERSION = 2

/** 单步设置迁移函数：接收迁移前设置，返回迁移后设置（类型不变仅字段调整） */
export type MigrationFn = (settings: AetherLogSettings) => AetherLogSettings

/** 一条版本迁移记录：从 from 版本升级到 to 版本时应用 fn */
export interface SettingsMigration {
  from: number
  to: number
  fn: MigrationFn
}

/**
 * 版本迁移注册表
 * v0（无版本号的旧数据）→ v1 依赖深合并补默认值即可，无需字段改名，fn 为恒等。
 * v1 → v2（B6 修复）：深合并会整体保留旧空数组 keywordBlacklist:[]，顶掉
 * DEFAULT_SETTINGS 新预置的默认值，导致存量升级用户 0 规则——迁移时空数组
 * 补填默认 3 条，非空（用户自定义）原样保留。
 */
export const MIGRATIONS: readonly SettingsMigration[] = [
  {
    from: 0,
    to: 1,
    fn: (settings: AetherLogSettings): AetherLogSettings => settings,
  },
  {
    from: 1,
    to: 2,
    fn: (settings: AetherLogSettings): AetherLogSettings => {
      const blacklist = settings.keywordBlacklist
      return {
        ...settings,
        // 空数组（含 undefined 防御）→ 填默认 3 条；非空 → 用户自定义优先原样保留
        keywordBlacklist:
          !blacklist || blacklist.length === 0
            ? [...DEFAULT_SETTINGS.keywordBlacklist]
            : blacklist,
      }
    },
  },
]

/** 默认值表（与 settings_API.md 第二节逐字段一致） */
export const DEFAULT_SETTINGS: AetherLogSettings = {
  clipboardEnabled: true,
  clipboardOutputPath: 'aetherlog/clipboard',
  clipboardPollingIntervalMs: 200,
  captureContentTypes: {
    plainText: true,
    richTextHtml: false,
    image: false,
    filePath: false,
  },
  maxContentLengthChars: 50000,

  quickNoteEnabled: true,
  quickNoteShortcut: 'Ctrl+Alt+Space',
  quickNoteStorageMode: 'merge-clipboard',
  quickNoteSeparatePath: 'aetherlog/quick-notes',
  quickNoteDailyNotesHeading: '## 💡 AetherLog 速记',
  quickNoteCategories: ['灵感', '待办', '摘抄', '想法', '备忘'],

  voiceBackend: 'disabled',
  capswriterBaseUrl: 'http://127.0.0.1:19102',
  capswriterAuthToken: '',
  webSpeechLang: 'zh-CN',

  trayEnabled: true,
  showTrayNotification: true,
  clipboardNotifyThrottleSecs: 60,
  minimizeToTrayOnClose: false,
  autoStartOnBoot: false,

  autoStartCaptureOnLoad: true,

  foldContentThresholdChars: 500,
  includeDailyStatsHeader: true,
  recordSeparatorLine: '─'.repeat(50),
  dailyFileNameDateFormat: 'YYYY-MM-DD',

  dedupeEnabled: false,
  dedupeLookbackWindow: 50,
  sourceAppBlacklist: [],
  /**
   * 关键字黑名单默认预置的正则源字符串：
   * 1. 密码强度串——命中条件：整串无空白（\S 约束）+ 大写/小写/数字/符号四类
   *    齐全 + ≥8 位（密码 / token / license key 形态）。已知权衡：无空白且四类
   *    齐全的 URL 会误拦（如 https://GitHub.com/User2/Repo），但该形态本质是
   *    凭据类内容，符合「宁可少存、不可错存」的产品原则；带空格的正常句子、
   *    纯中文、无数字 URL 均放行；
   * 2. UUID——UUID 防误存；
   * 3. 长纯数字串（16-19 位）——银行卡/卡号防误存。
   * 保留 ^$ 锚点原因：底层 matchesBlacklist 使用 regex.test 做部分匹配，
   * 锚点保证整串匹配，避免长文本中恰好包含片段时被误伤。
   */
  keywordBlacklist: [
    '^(?=\\S*$)(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^a-zA-Z\\d])\\S{8,}$',
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    '^\\d{16,19}$',
  ],
  keywordBlacklistMode: 'substring',
}

/** 校验结果：valid 为总体是否通过，errors 为逐条中文错误信息（用于 UI 标红提示） */
export interface SettingsValidationResult {
  valid: boolean
  errors: string[]
}

/** Electron globalShortcut 合法格式：至少一个修饰键 + 一个非修饰键 */
const SHORTCUT_RE = /^(?:(?:Ctrl|Alt|Shift|Super)\+)+(?:[A-Za-z0-9]|F\d{1,2}|Space|Enter|Esc|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|PrintScreen|Insert|Delete|Backspace)$/

/** URL 格式（http/https） */
const URL_RE = /^https?:\/\/\S+$/

/** 分类名非法字符：# : [ ] / \ */
const CATEGORY_INVALID_RE = /[#:\/\[\\]/

/**
 * 校验设置项合法性（对齐 settings_API.md 第六节输入验证规则）
 * 注意：数值范围的 clamp 逻辑由 SettingsTab（C 窗口）在保存前调用本函数后自行处理，
 * 此处仅做「拒绝保存 + 错误提示」级别的校验。
 * @param settings 待校验的设置对象
 * @returns 校验结果与错误列表
 */
export function validateSettings(settings: AetherLogSettings): SettingsValidationResult {
  const errors: string[] = []

  // 路径字段：不允许 ../ 或 ..\，必须为相对 Vault 的路径（不以 / 开头）
  const pathFields: Array<{ label: string; value: string }> = [
    { label: '剪贴板输出路径', value: settings.clipboardOutputPath },
    { label: '速记独立存储路径', value: settings.quickNoteSeparatePath },
  ]
  for (const f of pathFields) {
    if (f.value.includes('../') || f.value.includes('..\\')) {
      errors.push(`${f.label}不允许包含 ../（禁止路径穿越）`)
    }
    if (f.value.startsWith('/')) {
      errors.push(`${f.label}必须是相对 Vault 根的路径，不能以 / 开头`)
    }
  }

  // 数值范围
  if (!Number.isInteger(settings.clipboardPollingIntervalMs) || settings.clipboardPollingIntervalMs < 50 || settings.clipboardPollingIntervalMs > 5000) {
    errors.push('轮询间隔必须为 50~5000 之间的整数（毫秒）')
  }
  if (!Number.isInteger(settings.maxContentLengthChars) || settings.maxContentLengthChars < 0 || settings.maxContentLengthChars > 10000000) {
    errors.push('单条最大字数必须为 0~10000000 之间的整数')
  }
  if (!Number.isInteger(settings.foldContentThresholdChars) || settings.foldContentThresholdChars < 0 || settings.foldContentThresholdChars > 50000) {
    errors.push('折叠阈值必须为 0~50000 之间的整数')
  }
  if (!Number.isInteger(settings.clipboardNotifyThrottleSecs) || settings.clipboardNotifyThrottleSecs < 0 || settings.clipboardNotifyThrottleSecs > 3600) {
    errors.push('通知节流间隔必须为 0~3600 之间的整数（秒）')
  }
  if (!Number.isInteger(settings.dedupeLookbackWindow) || settings.dedupeLookbackWindow < 0 || settings.dedupeLookbackWindow > 10000) {
    errors.push('去重回看窗口必须为 0~10000 之间的整数')
  }

  // 快捷键格式
  if (!SHORTCUT_RE.test(settings.quickNoteShortcut)) {
    errors.push('全局快捷键格式非法，请输入如 Ctrl+Alt+S 的组合（至少一个修饰键 + 一个普通键）')
  }

  // 分类预设
  settings.quickNoteCategories.forEach((category: string, index: number): void => {
    if (category.trim().length === 0) {
      errors.push(`第 ${index + 1} 个分类名不能为空`)
    } else if (category.length > 20) {
      errors.push(`分类「${category}」长度超过 20 字符`)
    } else if (CATEGORY_INVALID_RE.test(category)) {
      errors.push(`分类「${category}」包含非法字符（不允许 # : [ ] / \\）`)
    }
  })

  // CapsWriter Base URL
  if (!URL_RE.test(settings.capswriterBaseUrl)) {
    errors.push('CapsWriter 服务地址必须为 http/https 开头的合法 URL')
  }

  // 来源应用黑名单
  settings.sourceAppBlacklist.forEach((app: string): void => {
    if (app.length > 255 || /[\\/]/.test(app)) {
      errors.push(`来源应用黑名单条目「${app}」非法（不允许路径分隔符，长度 ≤ 255）`)
    }
  })

  return { valid: errors.length === 0, errors }
}
