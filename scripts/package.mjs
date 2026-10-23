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

fs.rmSync(outFile, { force: true })
execFileSync('zip', ['-r', '-q', outFile, ...INCLUDE], { cwd: stageDir })

const size = fs.statSync(outFile).size
fs.rmSync(stageDir, { recursive: true, force: true })

console.log(`  ✓ ${path.relative(root, outFile)}  ${(size / 1024).toFixed(1)} KB`)
console.log('可直接上传至 Chrome Web Store 开发者后台。')
