/**
 * 日期与路径工具
 * 日文件路径规范：{outputPath}/yyyy/MM/yyyy-MM-dd-aetherlog.md（相对 Vault 根）
 * 时间处理：使用用户本地时区（不强制 UTC）
 */

/**
 * 补齐两位数字（如 8 → '08'）
 * @param n 数字
 * @returns 两位字符串
 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 规范化目录路径：反斜杠 → 正斜杠、去除首尾分隔符、合并重复分隔符
 * @param dirPath 原始路径
 * @returns 规范化路径（可能为空字符串 = Vault 根）
 */
export function normalizeDirPath(dirPath: string): string {
  return dirPath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '')
}

/**
 * 生成本地时区 ISO 时间字符串（如 '2026-08-29T14:32:15.328+08:00'）
 * @param date 时间点，缺省为当前时间
 * @returns 带本地时区偏移的 ISO 字符串
 */
export function nowIso(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  // 将本地墙钟时间平移为 UTC 读数（本地墙钟 = UTC + 偏移），再借 toISOString 输出后拼回偏移
  const localShifted = new Date(date.getTime() + offsetMinutes * 60000)
  const iso = localShifted.toISOString()
  return `${iso.slice(0, -1)}${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`
}

/**
 * 生成 HH:mm:ss 时间字符串
 * @param date 时间点，缺省为当前时间
 * @returns 时间字符串
 */
export function nowTime(date: Date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * 生成 yyyy-MM-dd 日期字符串
 * @param date 时间点，缺省为当前时间
 * @returns 日期字符串
 */
export function formatDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 生成 yyyyMMdd-HHmmss 时间戳字符串（回收站文件夹命名用）
 * @param date 时间点，缺省为当前时间
 * @returns 时间戳字符串
 */
export function formatTimestampForFolder(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

/**
 * 生成当日捕获日文件路径（相对 Vault 根）
 * 结构：{outputPath}/yyyy/MM/yyyy-MM-dd-aetherlog.md
 * @param outputPath 输出根路径（相对 Vault 根，如 'aetherlog/clipboard'）
 * @param date 日期，缺省为今天
 * @returns 日文件路径
 * @example
 * getDayFilePath('aetherlog/clipboard', new Date('2026-08-29'))
 * // => 'aetherlog/clipboard/2026/08/2026-08-29-aetherlog.md'
 */
export function getDayFilePath(outputPath: string, date: Date = new Date()): string {
  const base = normalizeDirPath(outputPath)
  const yyyy = String(date.getFullYear()).padStart(4, '0')
  const mm = pad2(date.getMonth() + 1)
  const dd = pad2(date.getDate())
  const fileName = `${yyyy}-${mm}-${dd}-aetherlog.md`
  return base.length > 0 ? `${base}/${yyyy}/${mm}/${fileName}` : `${yyyy}/${mm}/${fileName}`
}
