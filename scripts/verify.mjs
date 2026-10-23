/**
 * 静态自检：在没有浏览器的情况下尽可能早地发现装配错误。
 *
 * 检查项：
 *   1. manifest.json 引用的文件都存在
 *   2. 权限集合与设计一致（不多要，尤其不能有 cookies）
 *   3. 所有相对 import 都能解析
 *   4. 侧边栏 HTML 引用的本地资源存在
 *   5. 没有出现被禁用的 API
 *
 * 用法：node scripts/verify.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const problems = []
const notes = []

const manifestPath = path.join(root, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error('找不到 manifest.json')
  process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

// 1. 引用文件
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.options_page,
  manifest.options_ui?.page,
].filter(Boolean)

for (const rel of referenced) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`manifest 引用了不存在的文件：${rel}`)
}
notes.push(`manifest 引用 ${referenced.length} 个文件，均存在`)

// 2. 权限
const ALLOWED = new Set(['storage', 'sidePanel', 'declarativeNetRequest'])
for (const perm of manifest.permissions ?? []) {
  if (!ALLOWED.has(perm)) problems.push(`出现设计之外的权限：${perm}`)
}
const hosts = manifest.host_permissions ?? []
for (const host of hosts) {
  if (!/^https:\/\/\*\.(douban|doubanio)\.com\/\*$/.test(host)) {
    problems.push(`host_permissions 超出允许范围：${host}`)
  }
}
if (manifest.action?.default_popup) {
  problems.push('存在 default_popup —— 设计上点击图标应直接打开侧边栏')
}
notes.push(`权限：${(manifest.permissions ?? []).join(', ') || '无'}；host：${hosts.join(', ') || '无'}`)

// 2b. declarativeNetRequest 规则
for (const resource of manifest.declarative_net_request?.rule_resources ?? []) {
  const rulesPath = path.join(root, resource.path)
  if (!fs.existsSync(rulesPath)) {
    problems.push(`DNR 规则文件不存在：${resource.path}`)
    continue
  }
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
    if (!Array.isArray(rules) || rules.length === 0) problems.push('DNR 规则为空')
    else notes.push(`DNR 规则 ${rules.length} 条（用于放行豆瓣图床的 Referer 校验）`)
  } catch (err) {
    problems.push(`DNR 规则不是合法 JSON：${resource.path}`)
  }
}

// 3 & 5. 源码检查
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const jsFiles = walk(path.join(root, 'src'))
const FORBIDDEN = [/chrome\.cookies/, /document\.cookie/]

for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file)

  for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1])
    if (!fs.existsSync(target)) problems.push(`${rel} 的 import 无法解析：${match[1]}`)
  }

  for (const pattern of FORBIDDEN) {
    if (pattern.test(code)) problems.push(`${rel} 命中了被禁用的 API：${pattern}`)
  }
}

notes.push(`源码 ${jsFiles.length} 个文件，import 与被禁用 API 检查通过`)

// 4. 侧边栏 HTML 的本地资源
const panelHtml = manifest.side_panel?.default_path
if (panelHtml) {
  const full = path.join(root, panelHtml)
  const html = fs.readFileSync(full, 'utf8')
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
    const target = path.resolve(path.dirname(full), match[1])
    if (!fs.existsSync(target)) problems.push(`侧边栏引用了不存在的资源：${match[1]}`)
  }
  notes.push('侧边栏 HTML 的本地资源均存在')
}

for (const note of notes) console.log(`  ✓ ${note}`)

if (problems.length) {
  console.error('\n发现问题：')
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

console.log('\n静态自检通过。仍需在 chrome://extensions 手动加载一次确认运行期无报错。')
