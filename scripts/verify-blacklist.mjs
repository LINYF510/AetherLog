#!/usr/bin/env node
/**
 * B6 黑名单修复本地验证脚本（不依赖 Obsidian，node 直接运行）
 *
 * 验证内容：
 * 1. 正则行为矩阵：DEFAULT_SETTINGS.keywordBlacklist 三条正则的命中/放行语义
 * 2. Migration 用例：migrateSettings v1→v2 空数组补填 / 非空保留 / v2 不重复迁移
 *
 * 为避免「脚本内复制正则字符串造成两份漂移」，本脚本用项目自带 esbuild 把
 * src/types/settings.types.ts 与 src/utils/settings-migrator.ts 打包为临时
 * ESM 产物后动态 import，直接测试真实源码。
 *
 * 用法：在项目根目录执行 node scripts/verify-blacklist.mjs
 * 退出码：0 = 全部 PASS；1 = 存在 FAIL
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
let failed = 0

/**
 * 单项断言：输出 PASS/FAIL 并累计失败数
 * @param id 用例编号
 * @param name 用例描述
 * @param cond 断言条件
 */
function check(id, name, cond) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${id}. ${name}`)
  if (!cond) failed++
}

/**
 * 用 esbuild 打包真实源码为临时 ESM 产物并动态 import
 * @returns 打包产物的模块命名空间（DEFAULT_SETTINGS / MIGRATIONS / SETTINGS_VERSION / migrateSettings）
 */
async function loadRealModules() {
  const result = await build({
    stdin: {
      contents: [
        "export { DEFAULT_SETTINGS, MIGRATIONS, SETTINGS_VERSION } from '../src/types/settings.types'",
        "export { migrateSettings } from '../src/utils/settings-migrator'",
      ].join('\n'),
      resolveDir: scriptDir,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'aetherlog-verify-'))
  const bundlePath = join(tmpDir, 'bundle.mjs')
  writeFileSync(bundlePath, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(bundlePath).href)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const mod = await loadRealModules()
const defaults = mod.DEFAULT_SETTINGS

/** 两个字符串数组逐项深度相等（长度 + 每项严格相等） */
const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])

console.log('== B6 黑名单修复验证（正则源字符串与迁移逻辑均取自真实源码） ==')

// ---------- 正则行为矩阵 ----------
// 与 clipboard-listener matchesBlacklist 同语义：regex.test 部分匹配（正则自带 ^$ 锚点保证整串匹配）
const patterns = defaults.keywordBlacklist.map((source) => new RegExp(source))
const hit = (text) => patterns.some((regexp) => regexp.test(text))

console.log('-- 正则行为矩阵 --')
check(1, "'Abc12345!' → 密码正则命中", hit('Abc12345!') === true)
check(2, "UUID 'a1b2c3d4-1234-5678-9abc-def012345678' → UUID 正则命中", hit('a1b2c3d4-1234-5678-9abc-def012345678') === true)
check(3, "'6222020200112233445' → 长纯数字正则命中", hit('6222020200112233445') === true)
check(4, "含空格中文句子 → 三条全不命中（放行）", hit('今天开会讨论 AetherLog v2 方案 `https://github.com`') === false)
check(5, "含空格中英混排句子 → 三条全不命中（放行）", hit('Mk7vQr2026 会议纪要正常文本 Alpha9 版本') === false)
check(6, "纯中文句子 → 三条全不命中（放行）", hit('今天下午三点开会') === false)
check(7, "反引号包裹 URL → 三条全不命中（放行）", hit('`https://github.com/FancyLin/AetherLog`') === false)

// ---------- Migration 用例（真实 migrateSettings / MIGRATIONS） ----------
console.log('-- Migration 用例 --')
const out8 = mod.migrateSettings({ settingsVersion: 1, keywordBlacklist: [] }, defaults, mod.MIGRATIONS)
check(8, 'v1 + 空数组 → 补填默认 3 条且 version=2', out8.keywordBlacklist.length === 3 && sameList(out8.keywordBlacklist, defaults.keywordBlacklist) && out8.settingsVersion === mod.SETTINGS_VERSION)

const out9 = mod.migrateSettings({ settingsVersion: 1, keywordBlacklist: ['^custom_'] }, defaults, mod.MIGRATIONS)
check(9, "v1 + ['^custom_'] → 用户自定义保留不被覆盖", sameList(out9.keywordBlacklist, ['^custom_']) && out9.settingsVersion === mod.SETTINGS_VERSION)

// v2 数据不得重复迁移：对 v1→v2 fn 插桩，若被调用即 FAIL
let migrated = false
const instrumented = mod.MIGRATIONS.map((m) =>
  m.from === 1 ? { ...m, fn: (s) => { migrated = true; return m.fn(s) } } : m
)
const out10 = mod.migrateSettings({ settingsVersion: 2, keywordBlacklist: [...defaults.keywordBlacklist] }, defaults, instrumented)
check(10, 'v2 + 3 条 → 不重复迁移（v1→v2 fn 未被调用）', migrated === false && out10.settingsVersion === mod.SETTINGS_VERSION && sameList(out10.keywordBlacklist, defaults.keywordBlacklist))

// 附加：真实存量用户场景（data.json 无 settingsVersion 字段 → 视为 v0，链式 0→1→2）
const outBonus = mod.migrateSettings({ keywordBlacklist: [] }, defaults, mod.MIGRATIONS)
check('附', 'v0（无版本字段，data.json 现状）+ 空数组 → 链式补填 3 条且 version=2', outBonus.keywordBlacklist.length === 3 && sameList(outBonus.keywordBlacklist, defaults.keywordBlacklist) && outBonus.settingsVersion === mod.SETTINGS_VERSION)

console.log(`\n结果：${failed === 0 ? '10/10 全部 PASS' : `${failed} 项 FAIL`}`)
process.exit(failed === 0 ? 0 : 1)
