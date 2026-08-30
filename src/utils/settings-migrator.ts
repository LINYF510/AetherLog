/**
 * 设置版本迁移框架（M3.2）
 *
 * 当前结构版本 = 2（v1→v2：keywordBlacklist 空数组补填默认黑名单，B6 修复）。
 * 框架结构完整保留（from → to 链式迁移），后续升级设置结构时在
 * types/settings.types.ts 的 MIGRATIONS 中追加条目即可。
 */
import { SETTINGS_VERSION } from '../types/settings.types'
import type { AetherLogSettings, SettingsMigration } from '../types/settings.types'

/**
 * 判断值是否为普通对象（非 null / 非数组）
 * @param value 待判断值
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 递归合并单个值（深合并核心）
 * 规则（对齐 settings_API.md §3.1）：
 * - undefined / null → 用默认值补
 * - 数组直接整体替换（不合并子元素）
 * - 普通对象递归逐 key 合并（仅遍历默认值中存在的 key）
 * - 空字符串 / 0 / false 视为有效值不覆盖
 * - 类型不一致（如字符串给到数字字段）→ 用默认值
 * @param defaultValue 默认值
 * @param rawValue 用户持久化的原始值
 * @returns 合并后的值
 */
function mergeValue<T>(defaultValue: T, rawValue: unknown): T {
  if (rawValue === undefined || rawValue === null) return defaultValue
  if (Array.isArray(defaultValue)) {
    return (Array.isArray(rawValue) ? rawValue : defaultValue) as T
  }
  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(rawValue)) return defaultValue
    const result: Record<string, unknown> = { ...defaultValue }
    for (const key of Object.keys(defaultValue)) {
      result[key] = mergeValue((defaultValue as Record<string, unknown>)[key], rawValue[key])
    }
    return result as T
  }
  if (typeof defaultValue === typeof rawValue) return rawValue as T
  return defaultValue
}

/**
 * 深合并设置：DEFAULT_SETTINGS ← 用户旧 data.json
 * @param defaults 默认设置
 * @param raw 用户持久化的原始数据（可能为 null/缺字段/类型漂移）
 * @returns 补全默认值后的完整设置
 */
export function deepMergeSettings(defaults: AetherLogSettings, raw: unknown): AetherLogSettings {
  return mergeValue(defaults, raw)
}

/**
 * 读取持久化数据中携带的版本号（MVP 未持久化版本字段，缺省视为 v0）
 * @param raw 原始持久化数据
 * @returns 版本号（无版本信息时为 0）
 */
function readVersion(raw: unknown): number {
  if (isPlainObject(raw) && typeof raw.settingsVersion === 'number') {
    return raw.settingsVersion
  }
  return 0
}

/**
 * 设置迁移入口：深合并补默认值 → 按 from→to 链式执行迁移 → 达到当前版本
 * @param raw loadData() 返回的原始持久化数据
 * @param defaults 默认设置（DEFAULT_SETTINGS）
 * @param migrations 迁移注册表（MIGRATIONS）
 * @returns 迁移后的完整设置
 */
export function migrateSettings(
  raw: unknown,
  defaults: AetherLogSettings,
  migrations: readonly SettingsMigration[]
): AetherLogSettings {
  let settings = deepMergeSettings(defaults, raw)
  let version = readVersion(raw)
  // 链式迁移：v0→v1→v2…直到无可用迁移或达到当前版本（guard 防御注册表环）
  for (let guard = 0; guard < 100; guard++) {
    if (version >= SETTINGS_VERSION) break
    const migration = migrations.find((m: SettingsMigration): boolean => m.from === version)
    if (migration === undefined) break
    settings = migration.fn(settings)
    version = migration.to
  }
  // 版本号写回：迁移后的最终版本随返回值带入 settings，经调用方 saveData 持久化
  // 到 data.json，下次启动 readVersion 直接命中，迁移链不会重复执行
  // （幂等兜底：v1→v2 仅对空数组填默认，即使重跑也无副作用）
  return { ...settings, settingsVersion: version }
}
