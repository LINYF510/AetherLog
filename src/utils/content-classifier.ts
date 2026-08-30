/**
 * 内容分类器：10 类内容类型判定 + 语言判定 + 字数统计 + 代码语言识别
 * 规则对齐 docs/design/v1.0_UI与数据格式规范.md §4（判定阈值以窗口 A 任务书为准）
 * 纯函数、零 Obsidian 依赖，可被监听服务 / B 窗口速记面板共用
 */
import type { ContentType, Language } from '../types/capture.types'

/** 内容分析结果 */
export interface ContentAnalysis {
  /** 内容类型（10 类之一） */
  contentType: ContentType
  /** 语言（chinese/english/mixed/unknown） */
  language: Language
  /** 字数统计（含中文按字计数，纯英文按空格分词计数） */
  wordCount: number
  /** 代码语言（fenced code block 标注用，15 种高频语言；非代码内容为 'text'） */
  codeLanguage: string
}

// ============================================================
// 正则规则
// ============================================================

/** 中文与全角字符（含中文标点），对齐 UI 规范 §4.3 */
const CHINESE_CHAR_RE = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g

/** 仅 CJK 统一表意文字（字数统计用，标点不计） */
const CJK_HAN_RE = /[\u4e00-\u9fa5]/g

/** 英文字母 */
const ENGLISH_LETTER_RE = /[A-Za-z]/g

/** 乱码/控制字符（U+FFFD 替换符与不可见控制符） */
const GARBAGE_RE = /[\uFFFD\u0000-\u0008\u000E-\u001F]/g

/** 邮箱：整串匹配（去除前后空白） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** URL：http(s):// 或 www. 开头，整串匹配 */
const URL_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+\.[^\s]+)$/

/** Windows 路径：盘符 + 含扩展名文件 */
const WINDOWS_PATH_RE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.[A-Za-z0-9]+$/

/** Unix 路径：以 / 开头 + 含扩展名文件 */
const UNIX_PATH_RE = /^\/(?:[^\s/]+\/)*[^\s/]+\.[A-Za-z0-9]+$/

/** Markdown 标题行 */
const MD_HEADING_RE = /^#{1,6}\s+\S/m

/** Markdown 链接 */
const MD_LINK_RE = /\[[^\]]+\]\([^)\s]+\)/

/** Markdown 列表（无序/有序） */
const MD_LIST_RE = /^ {0,3}(?:[-*+]|\d+\.)\s+\S/m

/** HTML 常见标签 */
const HTML_TAG_RE = /<\/?(?:html|head|body|div|span|p|a|script|style|ul|ol|li|table|tr|td|th|img|h[1-6]|br|form|input|button|nav|section|article|header|footer)\b/i

/** CSS 规则块（选择器 { 属性: 值; }） */
const CSS_BLOCK_RE = /(^|\n)\s*[.#]?[\w*-]+(?:\s*[>,+~]\s*[\w*-]+)*\s*\{[^{}]*\}/

/** CSS 属性赋值 */
const CSS_PROP_RE = /[\w-]+\s*:\s*[^;{}]+;/

/** XML 声明或根标签对 */
const XML_ROOT_RE = /^<([\w:.-]+)[\s\S]*<\/\1>\s*$/

/** 代码关键字集合（对齐 UI 规范 §4.1 规则 8） */
const CODE_KEYWORDS: readonly string[] = [
  'function', 'const', 'let', 'var', 'import', 'export', 'class', 'def', 'return',
  'if', 'for', 'while', 'public', 'private', 'protected', 'static', 'async',
  'await', 'new', 'package', 'fn', 'use', 'struct', 'impl', 'namespace', 'using',
  'select', 'insert', 'update', 'delete', 'typeof', 'interface', 'extends',
]

// ============================================================
// 类型判定（优先级从高到低，命中即停止）
// ============================================================

/** 整体可 JSON.parse 且以 { 或 [ 开头（避免纯数字/字符串误判为 json） */
function isJson(text: string): boolean {
  if (!(text.startsWith('{') || text.startsWith('['))) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 含 HTML 常见标签 */
function isHtml(text: string): boolean {
  return HTML_TAG_RE.test(text)
}

/** CSS 结构：选择器 + { 属性: 值; } 且不含标签 */
function isCss(text: string): boolean {
  if (/<[a-z]/i.test(text)) return false
  return CSS_BLOCK_RE.test(text) && CSS_PROP_RE.test(text)
}

/** XML：以 < 开头的根标签对或自闭合结构（排除 HTML） */
function isXml(text: string): boolean {
  if (isHtml(text)) return false
  if (text.startsWith('<?xml')) return true
  if (XML_ROOT_RE.test(text)) return true
  return /^<[\w:.-]+[^>]*\/>$/.test(text)
}

/** Markdown：含标题 且（链接或列表） */
function isMarkdown(text: string): boolean {
  return MD_HEADING_RE.test(text) && (MD_LINK_RE.test(text) || MD_LIST_RE.test(text))
}

/** 代码：围栏包裹 / 缩进+关键字 / 成对大括号+关键字 */
function isCode(text: string): boolean {
  if (/^```[\s\S]*```$/.test(text)) return true
  const lines = text.split('\n')
  const indentedLines = lines.filter((line: string): boolean => /^\s{2,}\S/.test(line)).length
  const keywordCount = CODE_KEYWORDS.reduce(
    (count: number, kw: string): number => count + (text.includes(kw) ? 1 : 0),
    0
  )
  if (indentedLines >= 2 && keywordCount >= 3) return true
  const openBraces = text.match(/\{/g)?.length ?? 0
  const closeBraces = text.match(/\}/g)?.length ?? 0
  if (openBraces > 0 && openBraces === closeBraces && keywordCount >= 1) return true
  return false
}

/**
 * 判定内容类型（10 类，优先级：json → html → css → xml → markdown → email → url → path → code → text）
 * @param text 已去除前后空白的待判定文本
 * @returns 内容类型
 */
export function detectContentType(text: string): ContentType {
  if (isJson(text)) return 'json'
  if (isHtml(text)) return 'html'
  if (isCss(text)) return 'css'
  if (isXml(text)) return 'xml'
  if (isMarkdown(text)) return 'markdown'
  if (EMAIL_RE.test(text)) return 'email'
  if (URL_RE.test(text)) return 'url'
  if (WINDOWS_PATH_RE.test(text) || UNIX_PATH_RE.test(text)) return 'path'
  if (isCode(text)) return 'code'
  return 'text'
}

// ============================================================
// 语言判定与字数统计
// ============================================================

/**
 * 判定内容语言（对齐窗口 A 任务书阈值：中文比例 > 70% → chinese；英文比例 > 70% → english；
 * 否则 mixed；乱码或无有效字符 → unknown）
 * @param text 待判定文本
 * @returns 语言标识
 */
export function detectLanguage(text: string): Language {
  const chineseCount = text.match(CHINESE_CHAR_RE)?.length ?? 0
  const englishCount = text.match(ENGLISH_LETTER_RE)?.length ?? 0
  const total = chineseCount + englishCount
  if (total === 0) return 'unknown'
  const garbageCount = text.match(GARBAGE_RE)?.length ?? 0
  if (garbageCount > 0 && garbageCount >= total) return 'unknown'
  const chineseRatio = chineseCount / total
  if (chineseRatio > 0.7) return 'chinese'
  if (chineseRatio < 0.3) return 'english'
  return 'mixed'
}

/**
 * 字数统计：含中文时按字计数（CJK 逐字 + 英文按词），纯英文按空格分词计数
 * @param text 待统计文本
 * @returns 字数
 */
export function countWords(text: string): number {
  const chineseCount = text.match(CJK_HAN_RE)?.length ?? 0
  if (chineseCount > 0) {
    const withoutChinese = text.replace(CHINESE_CHAR_RE, ' ')
    const englishWords = withoutChinese.match(/[A-Za-z0-9]+/g)?.length ?? 0
    return chineseCount + englishWords
  }
  return text.trim().match(/\S+/g)?.length ?? 0
}

// ============================================================
// 代码语言识别（对齐 UI 规范 §4.2，15 种高频语言）
// ============================================================

/**
 * 识别代码语言（用于 fenced code block 标注）
 * @param text 待识别文本（通常是 contentType === 'code' 的内容）
 * @returns 语言标识字符串，未命中返回 'text'
 */
export function detectCodeLanguage(text: string): string {
  // 类型注解是 TS 的决定性信号（JS 语法不存在类型注解）；再要求任一关键字降低对象字面量误判
  if (
    /:\s*(?:string|number|boolean|void|unknown|any)\b/.test(text) &&
    /\b(?:import|export|function|const|let|var|class|interface|return)\b/.test(text)
  ) {
    return 'typescript'
  }
  if (/\b(?:const|let)\b/.test(text) || /=>/.test(text)) return 'javascript'
  if (/\bdef\s+\w+\s*\(/.test(text) || /if\s+__name__\s*==/.test(text)) return 'python'
  if (/^#!\/bin\/(?:ba|z|)sh/.test(text) || /\$\d|\bif\s*\[|\bgrep\b|\bawk\b|\bsed\b/.test(text)) return 'bash'
  if (isJson(text)) return 'json'
  if (/^---\s*$/m.test(text) && /^\s*[\w-]+:\s/m.test(text) && !/[{}]/.test(text)) return 'yaml'
  if (isCss(text)) return 'css'
  if (/<[a-z]+[\s>]/i.test(text)) return 'html'
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY)\b/i.test(text)) return 'sql'
  if (/public\s+class\b|import\s+java\./.test(text)) return 'java'
  if (/using\s+System\b|namespace\s+\w+/.test(text)) return 'csharp'
  if (/package\s+main\b|func\s+main\(/.test(text)) return 'go'
  if (/fn\s+main\(|let\s+mut\b|use\s+std::/.test(text)) return 'rust'
  if (isMarkdown(text)) return 'markdown'
  return 'text'
}

// ============================================================
// 组合入口
// ============================================================

/**
 * 内容分析组合入口：一次调用返回类型/语言/字数/代码语言
 * @param content 原始内容（函数内部自行 trim）
 * @returns 完整分析结果
 * @example
 * const analysis = classifyContent('const x = 1')
 * // => { contentType: 'code', language: 'english', wordCount: 4, codeLanguage: 'javascript' }
 */
export function classifyContent(content: string): ContentAnalysis {
  const trimmed = content.trim()
  return {
    contentType: detectContentType(trimmed),
    language: detectLanguage(trimmed),
    wordCount: countWords(trimmed),
    codeLanguage: detectCodeLanguage(trimmed),
  }
}
