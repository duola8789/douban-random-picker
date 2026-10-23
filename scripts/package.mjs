/**
 * 打包成可直接上传 Chrome Web Store 的 zip。
 *
 * 只打运行期需要的文件：manifest.json、src/、icons/。
 * 测试、文档、脚本、openspec 都不进包，避免无谓的体积和审核疑问。
 *
 * 用法：npm run package
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const distDir = path.join(root, 'dist')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
const version = manifest.version

const outFile = path.join(distDir, `douban-random-picker-${version}.zip`)
const stageDir = path.join(distDir, 'stage')

fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })

const INCLUDE = ['manifest.json', 'src', 'icons']
for (const entry of INCLUDE) {
  const from = path.join(root, entry)
  if (!fs.existsSync(from)) {
    console.error(`缺少 ${entry}，先跑 npm run icons`)
    process.exit(1)
  }
  fs.cpSync(from, path.join(stageDir, entry), { recursive: true })
}

/*
 * 换成生产配置：本地开发用 src/lib/config.js（1 分钟冷却、开发面板），
 * 生产包用 src/lib/config.prod.js（10 分钟冷却），然后把源文件删掉。
 */
const prodConfigPath = path.join(root, 'src/lib/config.prod.js')
const stagedConfigPath = path.join(stageDir, 'src/lib/config.js')
fs.copyFileSync(prodConfigPath, stagedConfigPath)
fs.rmSync(path.join(stageDir, 'src/lib/config.prod.js'))

/** 删掉标记为 dev-only 的区块（行首到 end 标记行） */
function stripDevOnly(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.includes('dev-only:start')) {
      inside = true
      continue
    }
    if (line.includes('dev-only:end')) {
      inside = false
      continue
    }
    if (!inside) out.push(line)
  }
  fs.writeFileSync(file, out.join('\n'))
}

function walkFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (/\.(js|html|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

for (const file of walkFiles(stageDir)) stripDevOnly(file)

fs.rmSync(outFile, { force: true })
execFileSync('zip', ['-r', '-q', outFile, ...INCLUDE], { cwd: stageDir })

const size = fs.statSync(outFile).size
fs.rmSync(stageDir, { recursive: true, force: true })

console.log(`  ✓ ${path.relative(root, outFile)}  ${(size / 1024).toFixed(1)} KB`)
console.log('可直接上传至 Chrome Web Store 开发者后台。')
