const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function copyPngAssets(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (!fs.existsSync(srcDir)) return
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue
    copyFile(path.join(srcDir, entry.name), path.join(destDir, entry.name))
  }
}

function copyUiFontAssets(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })
  if (!fs.existsSync(srcDir)) return
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!lower.endsWith('.ttf') && lower !== 'notice.md') continue
    copyFile(path.join(srcDir, entry.name), path.join(destDir, entry.name))
  }
}

copyFile(
  path.join(root, 'src', 'ui', 'index.html'),
  path.join(root, 'dist', 'ui', 'index.html'),
)

copyUiFontAssets(
  path.join(root, 'src', 'ui', 'fonts'),
  path.join(root, 'dist', 'ui', 'fonts'),
)

copyPngAssets(
  path.join(root, 'src', 'electron', 'assets'),
  path.join(root, 'dist', 'electron', 'assets'),
)
