const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const src = path.join(root, 'src', 'helpers', 'touchid.swift')
const outDir = path.join(root, 'dist', 'helpers')
const out = path.join(outDir, 'touchid')
const helperBundleId = process.env.DATAMOAT_TOUCHID_HELPER_BUNDLE_ID
  || `${process.env.DATAMOAT_BUNDLE_ID || 'com.datamoat.app'}.touchid-helper`
const helperAppPath = path.join(outDir, 'DataMoatTouchID.app')
const helperContentsPath = path.join(helperAppPath, 'Contents')
const helperMacOSPath = path.join(helperContentsPath, 'MacOS')
const helperExecutableName = 'DataMoatTouchID'
const helperExecutablePath = path.join(helperMacOSPath, helperExecutableName)

fs.mkdirSync(outDir, { recursive: true })

if (process.platform !== 'darwin') {
  if (fs.existsSync(out)) process.exit(0)
  console.warn('[datamoat] skipping Touch ID helper build on non-macOS')
  process.exit(0)
}

fs.rmSync(helperAppPath, { recursive: true, force: true })
fs.mkdirSync(helperMacOSPath, { recursive: true })

const compiler = spawnSync('xcrun', [
  'swiftc',
  src,
  '-framework', 'LocalAuthentication',
  '-framework', 'Security',
  '-o', out,
], {
  cwd: root,
  stdio: 'inherit',
})

if (compiler.status !== 0) {
  process.exit(compiler.status || 1)
}

fs.copyFileSync(out, helperExecutablePath)
fs.writeFileSync(path.join(helperContentsPath, 'PkgInfo'), 'APPL????')
fs.writeFileSync(path.join(helperContentsPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${helperExecutableName}</string>
    <key>CFBundleIdentifier</key>
    <string>${helperBundleId}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>DataMoatTouchID</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSBackgroundOnly</key>
    <true/>
  </dict>
</plist>
`)
