const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const packager = require('@electron/packager')

if (process.platform !== 'darwin') process.exit(0)

const root = path.join(__dirname, '..')
const releaseDir = path.join(root, 'release')
const iconBasePath = path.join(releaseDir, 'DataMoat')
const iconPath = path.join(releaseDir, 'DataMoat.icns')
const trayTemplatePath = path.join(releaseDir, 'DataMoatStatusTemplate.png')
const trayTemplate2xPath = path.join(releaseDir, 'DataMoatStatusTemplate@2x.png')
const bundleRoot = path.join(releaseDir, `DataMoat-darwin-${process.arch}`)
const bundlePath = path.join(bundleRoot, 'DataMoat.app')
const bundleResourcesPath = path.join(bundlePath, 'Contents', 'Resources')
const bundleHelpersPath = path.join(bundlePath, 'Contents', 'Helpers')
const appBundleId = process.env.DATAMOAT_BUNDLE_ID || 'com.datamoat.app'
const touchIdHelperAppPath = path.join(root, 'dist', 'helpers', 'DataMoatTouchID.app')

function wallMerlons(cx, cy, radius, count, width, height, fill, stroke, strokeWidth = 0) {
  const x = cx - width / 2
  const y = cy - radius - height / 2
  const rx = Math.min(width, height) / 3
  const strokeAttrs = stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ''
  return Array.from({ length: count }, (_, index) => {
    const angle = (360 / count) * index
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="${rx.toFixed(2)}" fill="${fill}"${strokeAttrs} transform="rotate(${angle.toFixed(2)} ${cx} ${cy})"/>`
  }).join('')
}

function regularPolygonPoints(cx, cy, radius, sides, rotationDeg = -22.5) {
  return Array.from({ length: sides }, (_, index) => {
    const angle = ((rotationDeg + (360 / sides) * index) * Math.PI) / 180
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    }
  })
}

function pathFromPoints(points) {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  return `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} ${rest.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')} Z`
}

function towerNodes(points, radius, fill, stroke, strokeWidth) {
  return points.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`).join('')
}

function ringRipples(cx, cy, radius, count, rx, ry, stroke, strokeWidth, opacity) {
  const y = cy - radius
  return Array.from({ length: count }, (_, index) => {
    const angle = (360 / count) * index
    return `<ellipse cx="${cx.toFixed(2)}" cy="${y.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-opacity="${opacity}" transform="rotate(${angle.toFixed(2)} ${cx} ${cy})"/>`
  }).join('')
}

function appIconSvg() {
  const merlons = wallMerlons(128, 128, 97, 10, 18, 24, 'url(#wallFace)', 'rgba(255,255,255,0.10)', 1.5)
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#08131d"/>
          <stop offset="60%" stop-color="#12273c"/>
          <stop offset="100%" stop-color="#08131b"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="42%" r="62%">
          <stop offset="0%" stop-color="#6ec6ff" stop-opacity="0.55"/>
          <stop offset="65%" stop-color="#296dff" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="#296dff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="wallFace" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#d7c19a"/>
          <stop offset="52%" stop-color="#b49266"/>
          <stop offset="100%" stop-color="#745538"/>
        </linearGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#74ddff"/>
          <stop offset="55%" stop-color="#2f87ff"/>
          <stop offset="100%" stop-color="#1543ba"/>
        </linearGradient>
        <linearGradient id="moatRing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5de0ff" stop-opacity="0.75"/>
          <stop offset="100%" stop-color="#3675ff" stop-opacity="0.22"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <circle cx="128" cy="128" r="108" fill="url(#glow)"/>
      <circle cx="128" cy="128" r="101" fill="none" stroke="url(#moatRing)" stroke-width="16"/>
      <circle cx="128" cy="128" r="83" fill="none" stroke="url(#wallFace)" stroke-width="24"/>
      <circle cx="128" cy="128" r="83" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2.5"/>
      ${merlons}
      <circle cx="128" cy="128" r="58" fill="url(#planet)" stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
      <path d="M95 111c10-14 31-23 50-19 13 2 19 10 20 16 1 6-4 11-11 13-10 2-18 10-22 21-3 9-12 13-22 12-14-1-28-11-32-22-4-9-1-16 17-21z" fill="rgba(188,255,239,0.82)"/>
      <path d="M142 139c8-5 20-7 28-3 7 3 10 9 9 15-2 10-12 18-23 19-8 1-15-2-18-9-3-7-2-15 4-22z" fill="rgba(188,255,239,0.68)"/>
      <path d="M110 163c6-2 14-1 18 4 3 4 2 9-2 12-5 4-13 5-18 2-6-3-6-13 2-18z" fill="rgba(188,255,239,0.62)"/>
      <ellipse cx="128" cy="128" rx="20" ry="58" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2.2"/>
      <ellipse cx="128" cy="128" rx="39" ry="58" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.8"/>
      <path d="M76 112c17 8 35 12 52 12s35-4 52-12" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" stroke-linecap="round"/>
      <path d="M76 145c17-8 35-12 52-12s35 4 52 12" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="128" cy="128" r="65" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.4"/>
    </svg>
  `
}

function fortressAppIconSvg() {
  const wallPath = pathFromPoints(regularPolygonPoints(128, 128, 80, 8))
  const towers = towerNodes(regularPolygonPoints(128, 128, 92, 8), 12, 'url(#stoneTower)', 'rgba(255,255,255,0.18)', 2.2)
  const ripples = ringRipples(128, 128, 104, 10, 13, 5.5, '#eefaff', 3.2, 0.7)
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#08131c"/>
          <stop offset="55%" stop-color="#132539"/>
          <stop offset="100%" stop-color="#0a1620"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="42%" r="62%">
          <stop offset="0%" stop-color="#6ec6ff" stop-opacity="0.55"/>
          <stop offset="65%" stop-color="#2d8fff" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#296dff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="waterRing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7ed8ff"/>
          <stop offset="55%" stop-color="#318dff"/>
          <stop offset="100%" stop-color="#1542bf"/>
        </linearGradient>
        <linearGradient id="stoneWall" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#c8ced6"/>
          <stop offset="48%" stop-color="#8f99a7"/>
          <stop offset="100%" stop-color="#5a6573"/>
        </linearGradient>
        <linearGradient id="stoneTower" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#d7dde4"/>
          <stop offset="50%" stop-color="#a1abb8"/>
          <stop offset="100%" stop-color="#616c79"/>
        </linearGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#74ddff"/>
          <stop offset="55%" stop-color="#2f87ff"/>
          <stop offset="100%" stop-color="#1543ba"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <circle cx="128" cy="128" r="108" fill="url(#glow)"/>
      <circle cx="128" cy="128" r="104" fill="none" stroke="url(#waterRing)" stroke-width="28"/>
      ${ripples}
      <path d="${wallPath}" fill="none" stroke="#36404a" stroke-width="34" stroke-linejoin="round"/>
      <path d="${wallPath}" fill="none" stroke="url(#stoneWall)" stroke-width="26" stroke-linejoin="round"/>
      <path d="${wallPath}" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2.8" stroke-linejoin="round"/>
      ${towers}
      <circle cx="128" cy="128" r="52" fill="url(#planet)" stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
      <path d="M95 111c10-14 31-23 50-19 13 2 19 10 20 16 1 6-4 11-11 13-10 2-18 10-22 21-3 9-12 13-22 12-14-1-28-11-32-22-4-9-1-16 17-21z" fill="rgba(188,255,239,0.82)"/>
      <path d="M142 139c8-5 20-7 28-3 7 3 10 9 9 15-2 10-12 18-23 19-8 1-15-2-18-9-3-7-2-15 4-22z" fill="rgba(188,255,239,0.68)"/>
      <path d="M110 163c6-2 14-1 18 4 3 4 2 9-2 12-5 4-13 5-18 2-6-3-6-13 2-18z" fill="rgba(188,255,239,0.62)"/>
      <ellipse cx="128" cy="128" rx="18" ry="52" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2.2"/>
      <ellipse cx="128" cy="128" rx="35" ry="52" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.8"/>
      <path d="M80 112c16 8 32 12 48 12s32-4 48-12" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" stroke-linecap="round"/>
      <path d="M80 145c16-8 32-12 48-12s32 4 48 12" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="128" cy="128" r="60" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.4"/>
    </svg>
  `
}

function draftFortressAppIconSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#09131d"/>
          <stop offset="100%" stop-color="#122236"/>
        </linearGradient>
        <radialGradient id="planetGlow" cx="50%" cy="35%" r="50%">
          <stop offset="0%" stop-color="#b8edff" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#4db1ff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#7fe3ff"/>
          <stop offset="52%" stop-color="#2e8cff"/>
          <stop offset="100%" stop-color="#1742ba"/>
        </linearGradient>
        <linearGradient id="stoneLeft" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#cfd4db"/>
          <stop offset="100%" stop-color="#8f98a5"/>
        </linearGradient>
        <linearGradient id="stoneRight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#aab3be"/>
          <stop offset="100%" stop-color="#6c7683"/>
        </linearGradient>
        <linearGradient id="towerStone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d6dbe2"/>
          <stop offset="100%" stop-color="#8c95a2"/>
        </linearGradient>
        <linearGradient id="moat" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7dd8ff"/>
          <stop offset="100%" stop-color="#1b63d7"/>
        </linearGradient>
        <linearGradient id="flag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff9aa3"/>
          <stop offset="100%" stop-color="#ff5b68"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <circle cx="128" cy="82" r="52" fill="url(#planetGlow)"/>
      <circle cx="128" cy="88" r="44" fill="url(#planet)" stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
      <path d="M97 75c10-14 32-19 49-14 10 3 17 10 18 18 1 5-4 9-10 10-8 1-16 7-19 16-3 7-11 10-19 9-15-2-28-12-31-23-2-6 1-12 12-16z" fill="rgba(197,247,244,0.78)"/>
      <path d="M141 97c8-4 18-4 24-1 6 3 8 8 7 13-2 8-10 13-19 14-8 1-14-2-16-8-2-7-1-13 4-18z" fill="rgba(197,247,244,0.65)"/>
      <ellipse cx="128" cy="88" rx="14" ry="44" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
      <ellipse cx="128" cy="88" rx="29" ry="44" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1.6"/>
      <path d="M86 78c13 6 27 9 42 9s29-3 42-9" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M86 102c13-6 27-9 42-9s29 3 42 9" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.8" stroke-linecap="round"/>
      <ellipse cx="128" cy="112" rx="26" ry="9" fill="rgba(12,24,40,0.65)" stroke="url(#moat)" stroke-width="4"/>
      <rect x="54" y="84" width="20" height="78" rx="8" fill="url(#towerStone)" stroke="#485361" stroke-width="3"/>
      <rect x="182" y="84" width="20" height="78" rx="8" fill="url(#towerStone)" stroke="#485361" stroke-width="3"/>
      <path d="M60 82 L60 50" stroke="#141b23" stroke-width="4" stroke-linecap="round"/>
      <path d="M196 82 L196 50" stroke="#141b23" stroke-width="4" stroke-linecap="round"/>
      <path d="M60 52 L36 66 L60 72 Z" fill="url(#flag)" stroke="#141b23" stroke-width="3" stroke-linejoin="round"/>
      <path d="M196 52 L220 38 L196 34 Z" fill="url(#flag)" stroke="#141b23" stroke-width="3" stroke-linejoin="round"/>
      <path d="M74 100 L104 76 L128 94 L128 226 L74 196 Z" fill="url(#stoneLeft)" stroke="#414b58" stroke-width="5" stroke-linejoin="round"/>
      <path d="M128 94 L152 76 L182 100 L182 196 L128 226 Z" fill="url(#stoneRight)" stroke="#414b58" stroke-width="5" stroke-linejoin="round"/>
      <path d="M104 76 L152 76 L182 100 L128 122 L74 100 Z" fill="rgba(216,222,229,0.88)" stroke="#414b58" stroke-width="4.5" stroke-linejoin="round"/>
      <path d="M74 100 L128 122 L182 100" fill="none" stroke="#3a4550" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 122 L128 226" stroke="#3b4550" stroke-width="4"/>
      <path d="M88 108 L88 206 M104 88 L104 216 M152 88 L152 216 M168 108 L168 206" stroke="rgba(56,64,74,0.6)" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M81 128 C97 134 113 134 128 132 M81 154 C97 160 113 160 128 158 M81 182 C97 188 113 188 128 186" fill="none" stroke="rgba(56,64,74,0.55)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M128 132 C143 134 159 134 175 128 M128 158 C143 160 159 160 175 154 M128 186 C143 188 159 188 175 182" fill="none" stroke="rgba(56,64,74,0.55)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M109 76 L128 94 L147 76" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `
}

function professionalFortressAppIconSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#09131d"/>
          <stop offset="100%" stop-color="#122236"/>
        </linearGradient>
        <radialGradient id="planetGlow" cx="50%" cy="39%" r="58%">
          <stop offset="0%" stop-color="#91ebff" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="#4db1ff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#8cecff"/>
          <stop offset="55%" stop-color="#399cff"/>
          <stop offset="100%" stop-color="#1d4ec9"/>
        </linearGradient>
        <linearGradient id="stoneLeft" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#d4d8df"/>
          <stop offset="100%" stop-color="#8a94a1"/>
        </linearGradient>
        <linearGradient id="stoneRight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#bcc3cd"/>
          <stop offset="100%" stop-color="#707a88"/>
        </linearGradient>
        <linearGradient id="stoneTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#e4e8ee"/>
          <stop offset="100%" stop-color="#b1bac5"/>
        </linearGradient>
        <linearGradient id="moat" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7fe9ff"/>
          <stop offset="100%" stop-color="#2368de"/>
        </linearGradient>
        <radialGradient id="moatGlow" cx="50%" cy="50%" r="66%">
          <stop offset="0%" stop-color="#58b9ff" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#58b9ff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="flag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff9aa3"/>
          <stop offset="100%" stop-color="#ff5b68"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <ellipse cx="128" cy="190" rx="92" ry="36" fill="url(#moatGlow)"/>
      <ellipse cx="128" cy="186" rx="86" ry="28" fill="none" stroke="url(#moat)" stroke-width="12"/>
      <ellipse cx="128" cy="186" rx="68" ry="20" fill="none" stroke="rgba(203,243,255,0.72)" stroke-width="4.5"/>
      <path d="M90 111 L90 63" stroke="#1b2430" stroke-width="4" stroke-linecap="round"/>
      <path d="M166 111 L166 61" stroke="#1b2430" stroke-width="4" stroke-linecap="round"/>
      <path d="M90 67 L63 80 L90 87 Z" fill="url(#flag)" stroke="#1b2430" stroke-width="3" stroke-linejoin="round"/>
      <path d="M166 65 L193 52 L166 47 Z" fill="url(#flag)" stroke="#1b2430" stroke-width="3" stroke-linejoin="round"/>
      <path d="M68 120 L105 94 L128 109 L128 202 L68 171 Z" fill="url(#stoneLeft)" stroke="#404a56" stroke-width="5" stroke-linejoin="round"/>
      <path d="M128 109 L151 94 L188 120 L188 171 L128 202 Z" fill="url(#stoneRight)" stroke="#404a56" stroke-width="5" stroke-linejoin="round"/>
      <path d="M105 94 L151 94 L188 120 L128 145 L68 120 Z M88 120 L128 144 L168 120 L146 100 L110 100 Z" fill="url(#stoneTop)" fill-rule="evenodd" stroke="#404a56" stroke-width="4.4" stroke-linejoin="round"/>
      <path d="M88 120 L110 100 L146 100 L168 120 L128 144 Z" fill="rgba(9,18,29,0.54)"/>
      <ellipse cx="128" cy="136" rx="26" ry="9" fill="rgba(6,14,24,0.28)"/>
      <circle cx="128" cy="109" r="40" fill="url(#planetGlow)"/>
      <circle cx="128" cy="112" r="31" fill="url(#planet)" stroke="rgba(255,255,255,0.24)" stroke-width="2.6"/>
      <path d="M108 101c8-10 22-14 34-10 8 2 14 8 14 13 0 5-3 9-9 10-7 1-12 6-14 13-2 5-8 8-14 7-10-1-19-8-21-17-1-5 2-10 10-16z" fill="rgba(202,249,248,0.78)"/>
      <path d="M137 122c6-3 13-3 18 0 5 2 7 6 6 10-1 6-7 10-13 11-6 0-10-2-12-7-1-4-1-9 1-14z" fill="rgba(202,249,248,0.54)"/>
      <path d="M108 92c7-5 16-8 27-8 12 0 22 4 29 11" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M105 112c8 3 16 4 23 4 13 0 22-3 29-8" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M128 119 L148 107 L171 121 L128 138 L85 121 Z" fill="rgba(8,18,28,0.34)"/>
      <path d="M68 120 L128 145 L188 120" fill="none" stroke="#3b4550" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 145 L128 202" stroke="#39424e" stroke-width="4"/>
      <path d="M90 128 L90 178 M108 103 L108 192 M148 103 L148 192 M166 128 L166 178" stroke="rgba(51,60,71,0.5)" stroke-width="2.3" stroke-linecap="round"/>
      <path d="M82 148 C98 154 114 154 128 152 M82 172 C98 178 114 178 128 176" fill="none" stroke="rgba(51,60,71,0.5)" stroke-width="2" stroke-linecap="round"/>
      <path d="M128 152 C142 154 158 154 174 148 M128 176 C142 178 158 178 174 172" fill="none" stroke="rgba(51,60,71,0.5)" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `
}

function trayTemplateSvg() {
  const merlons = wallMerlons(16, 16, 10.9, 8, 2.6, 3.8, '#000000')
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="12.4" fill="none" stroke="#000000" stroke-width="2.6"/>
      <circle cx="16" cy="16" r="8.8" fill="none" stroke="#000000" stroke-width="2.2"/>
      ${merlons}
      <circle cx="16" cy="16" r="5.2" fill="none" stroke="#000000" stroke-width="2"/>
      <path d="M11 14.6c1.7.9 3.3 1.3 5 1.3s3.3-.4 5-1.3" fill="none" stroke="#000000" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M11 17.4c1.7-.9 3.3-1.3 5-1.3s3.3.4 5 1.3" fill="none" stroke="#000000" stroke-width="1.6" stroke-linecap="round"/>
      <ellipse cx="16" cy="16" rx="2.6" ry="5.2" fill="none" stroke="#000000" stroke-width="1.4"/>
    </svg>
  `
}

function writeIcon(outputIcns) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datamoat-icon-'))
  const svgPath = path.join(tmpRoot, 'datamoat-icon.svg')
  const iconset = path.join(tmpRoot, 'DataMoat.iconset')
  fs.writeFileSync(svgPath, professionalFortressAppIconSvg().trim())
  fs.mkdirSync(iconset, { recursive: true })
  execFileSync('qlmanage', ['-t', '-s', '1024', '-o', tmpRoot, svgPath], { stdio: 'ignore' })
  const basePng = `${svgPath}.png`
  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, size] of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), basePng, '--out', path.join(iconset, name)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outputIcns], { stdio: 'ignore' })
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

function writeTrayTemplates(outputPng, outputPng2x) {
  const script = `
from PIL import Image, ImageDraw
import math

def polygon_points(cx, cy, radius, sides, rotation_deg=-22.5):
    pts = []
    for i in range(sides):
        angle = math.radians(rotation_deg + (360.0 / sides) * i)
        pts.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return pts

def line_points(points):
    return points + [points[0]]

def draw_icon(size, out_path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = size / 32.0
    cx = 16 * scale
    cy = 16 * scale

    moat_box = [cx - 12.0 * scale, cy - 12.0 * scale, cx + 12.0 * scale, cy + 12.0 * scale]
    globe_box = [cx - 5.0 * scale, cy - 5.0 * scale, cx + 5.0 * scale, cy + 5.0 * scale]

    draw.ellipse(moat_box, outline=(0, 0, 0, 255), width=max(2, round(2.7 * scale)))

    wall = polygon_points(cx, cy, 8.9 * scale, 8)
    draw.line(line_points(wall), fill=(0, 0, 0, 255), width=max(2, round(3.3 * scale)))

    towers = polygon_points(cx, cy, 10.3 * scale, 8)
    tower_r = 1.6 * scale
    for x, y in towers:
        draw.ellipse([x - tower_r, y - tower_r, x + tower_r, y + tower_r], fill=(0, 0, 0, 255))

    draw.ellipse(globe_box, outline=(0, 0, 0, 255), width=max(2, round(2.0 * scale)))
    draw.arc(globe_box, start=40, end=140, fill=(0, 0, 0, 255), width=max(1, round(1.5 * scale)))
    draw.arc(globe_box, start=220, end=320, fill=(0, 0, 0, 255), width=max(1, round(1.5 * scale)))

    inner_v = [cx - 1.8 * scale, cy - 5.0 * scale, cx + 1.8 * scale, cy + 5.0 * scale]
    draw.arc(inner_v, start=90, end=270, fill=(0, 0, 0, 255), width=max(1, round(1.2 * scale)))
    draw.arc(inner_v, start=-90, end=90, fill=(0, 0, 0, 255), width=max(1, round(1.2 * scale)))

    img.save(out_path)

draw_icon(16, r"${outputPng}")
draw_icon(32, r"${outputPng2x}")
`
  execFileSync('python3', ['-c', script], { stdio: 'ignore' })
}

function writeDraftTrayTemplates(outputPng, outputPng2x) {
  const script = `
from PIL import Image, ImageDraw

def draw_icon(size, out_path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = size / 32.0

    globe = [10.5 * scale, 3.5 * scale, 21.5 * scale, 14.5 * scale]
    draw.ellipse(globe, outline=(0, 0, 0, 255), width=max(2, round(1.8 * scale)))
    draw.arc(globe, start=35, end=145, fill=(0, 0, 0, 255), width=max(1, round(1.1 * scale)))
    draw.arc(globe, start=215, end=325, fill=(0, 0, 0, 255), width=max(1, round(1.1 * scale)))
    draw.ellipse([13.7 * scale, 3.5 * scale, 18.3 * scale, 14.5 * scale], outline=(0, 0, 0, 255), width=max(1, round(1.0 * scale)))
    draw.ellipse([11.5 * scale, 12.8 * scale, 20.5 * scale, 16.8 * scale], outline=(0, 0, 0, 255), width=max(1, round(1.2 * scale)))

    draw.rectangle([4.8 * scale, 10.0 * scale, 8.4 * scale, 22.2 * scale], fill=(0, 0, 0, 255))
    draw.rectangle([23.6 * scale, 10.0 * scale, 27.2 * scale, 22.2 * scale], fill=(0, 0, 0, 255))
    draw.line([(6.6 * scale, 10.0 * scale), (6.6 * scale, 4.2 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.3 * scale)))
    draw.line([(25.4 * scale, 10.0 * scale), (25.4 * scale, 4.2 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.3 * scale)))
    draw.polygon([(6.6 * scale, 5.0 * scale), (2.4 * scale, 7.5 * scale), (6.6 * scale, 8.6 * scale)], fill=(0, 0, 0, 255))
    draw.polygon([(25.4 * scale, 5.0 * scale), (29.6 * scale, 2.7 * scale), (25.4 * scale, 1.9 * scale)], fill=(0, 0, 0, 255))

    top = [(9.5 * scale, 11.2 * scale), (13.6 * scale, 8.2 * scale), (18.4 * scale, 8.2 * scale), (22.5 * scale, 11.2 * scale), (16.0 * scale, 14.2 * scale)]
    left = [(4.4 * scale, 13.2 * scale), (9.5 * scale, 11.2 * scale), (16.0 * scale, 14.2 * scale), (16.0 * scale, 28.0 * scale), (4.4 * scale, 22.3 * scale)]
    right = [(16.0 * scale, 14.2 * scale), (22.5 * scale, 11.2 * scale), (27.6 * scale, 13.2 * scale), (27.6 * scale, 22.3 * scale), (16.0 * scale, 28.0 * scale)]

    draw.polygon(left, outline=(0, 0, 0, 255), fill=None)
    draw.polygon(right, outline=(0, 0, 0, 255), fill=None)
    draw.polygon(top, outline=(0, 0, 0, 255), fill=None)

    draw.line([(16.0 * scale, 14.2 * scale), (16.0 * scale, 28.0 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.1 * scale)))
    draw.line([(8.0 * scale, 14.2 * scale), (8.0 * scale, 23.8 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.0 * scale)))
    draw.line([(12.0 * scale, 11.4 * scale), (12.0 * scale, 25.8 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.0 * scale)))
    draw.line([(20.0 * scale, 11.4 * scale), (20.0 * scale, 25.8 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.0 * scale)))
    draw.line([(24.0 * scale, 14.2 * scale), (24.0 * scale, 23.8 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.0 * scale)))

    for y in [16.8, 21.0, 25.0]:
        draw.line([(6.1 * scale, y * scale), (16.0 * scale, (y - 0.6) * scale)], fill=(0, 0, 0, 255), width=max(1, round(0.95 * scale)))
        draw.line([(16.0 * scale, (y - 0.6) * scale), (25.9 * scale, y * scale)], fill=(0, 0, 0, 255), width=max(1, round(0.95 * scale)))

    img.save(out_path)

draw_icon(16, r"${outputPng}")
draw_icon(32, r"${outputPng2x}")
`
  execFileSync('python3', ['-c', script], { stdio: 'ignore' })
}

function writeProfessionalTrayTemplates(outputPng, outputPng2x) {
  const script = `
from PIL import Image, ImageDraw

def draw_icon(size, out_path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    scale = size / 32.0

    globe = [10.6 * scale, 5.0 * scale, 21.4 * scale, 15.8 * scale]
    draw.ellipse(globe, outline=(0, 0, 0, 255), width=max(2, round(2.1 * scale)))
    draw.ellipse([14.1 * scale, 5.0 * scale, 17.9 * scale, 15.8 * scale], outline=(0, 0, 0, 255), width=max(1, round(1.1 * scale)))
    draw.arc(globe, start=205, end=335, fill=(0, 0, 0, 255), width=max(1, round(1.2 * scale)))

    top = [(9.2 * scale, 14.6 * scale), (13.2 * scale, 11.8 * scale), (18.8 * scale, 11.8 * scale), (22.8 * scale, 14.6 * scale), (16.0 * scale, 17.4 * scale)]
    left = [(6.0 * scale, 15.2 * scale), (9.2 * scale, 14.6 * scale), (16.0 * scale, 17.4 * scale), (16.0 * scale, 28.0 * scale), (6.0 * scale, 23.0 * scale)]
    right = [(16.0 * scale, 17.4 * scale), (22.8 * scale, 14.6 * scale), (26.0 * scale, 15.2 * scale), (26.0 * scale, 23.0 * scale), (16.0 * scale, 28.0 * scale)]

    draw.polygon(left, outline=(0, 0, 0, 255), fill=None, width=max(2, round(1.8 * scale)))
    draw.polygon(right, outline=(0, 0, 0, 255), fill=None, width=max(2, round(1.8 * scale)))
    draw.polygon(top, outline=(0, 0, 0, 255), fill=None, width=max(2, round(1.8 * scale)))
    draw.line([(7.7 * scale, 14.8 * scale), (9.6 * scale, 13.5 * scale), (11.5 * scale, 14.7 * scale), (13.7 * scale, 13.2 * scale), (16.0 * scale, 14.5 * scale), (18.3 * scale, 13.2 * scale), (20.5 * scale, 14.7 * scale), (22.4 * scale, 13.5 * scale), (24.3 * scale, 14.8 * scale)], fill=(0, 0, 0, 255), width=max(2, round(1.9 * scale)))
    draw.line([(16.0 * scale, 17.4 * scale), (16.0 * scale, 28.0 * scale)], fill=(0, 0, 0, 255), width=max(1, round(1.2 * scale)))

    moat = [4.6 * scale, 23.0 * scale, 27.4 * scale, 30.2 * scale]
    draw.ellipse(moat, outline=(0, 0, 0, 255), width=max(2, round(2.0 * scale)))

    img.save(out_path)

draw_icon(16, r"${outputPng}")
draw_icon(32, r"${outputPng2x}")
`
  execFileSync('python3', ['-c', script], { stdio: 'ignore' })
}

async function main() {
  fs.rmSync(releaseDir, { recursive: true, force: true })
  fs.mkdirSync(releaseDir, { recursive: true })
  writeIcon(iconPath)
  writeDraftTrayTemplates(trayTemplatePath, trayTemplate2xPath)

  await packager({
    dir: root,
    out: releaseDir,
    overwrite: true,
    platform: 'darwin',
    arch: process.arch,
    name: 'DataMoat',
    executableName: 'DataMoat',
    appBundleId,
    appCategoryType: 'public.app-category.productivity',
    icon: iconBasePath,
    prune: true,
    ignore: [
      /^\/artifacts($|\/)/,
      /^\/release($|\/)/,
      /^\/\.git($|\/)/,
      /^\/src($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.DS_Store$/,
    ],
  })

  if (!fs.existsSync(bundlePath)) {
    throw new Error(`packaged app missing at ${bundlePath}`)
  }

  fs.copyFileSync(iconPath, path.join(bundleResourcesPath, 'electron.icns'))
  fs.copyFileSync(trayTemplatePath, path.join(bundleResourcesPath, 'DataMoatStatusTemplate.png'))
  fs.copyFileSync(trayTemplate2xPath, path.join(bundleResourcesPath, 'DataMoatStatusTemplate@2x.png'))
  if (fs.existsSync(touchIdHelperAppPath)) {
    fs.mkdirSync(bundleHelpersPath, { recursive: true })
    execFileSync('ditto', [touchIdHelperAppPath, path.join(bundleHelpersPath, 'DataMoatTouchID.app')], { stdio: 'ignore' })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
