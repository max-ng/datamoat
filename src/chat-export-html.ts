/*
 * Chat export rendering — pure functions, no app/store imports.
 *
 * Turns captured Message[] into:
 *   - a cleaned, re-importable object (DataMoat export schema v1)
 *   - an all-in-one viewer.html (dark, DataMoat-branded, images inline)
 *   - a clean "context pack" markdown (mirrors server formatContextPackForClipboard)
 *
 * The IO (decrypting attachments, writing files/) lives in the caller; this
 * module only renders. Validated first as scripts/export-chat-demo.js.
 */
import type { Message, Session } from './types'

export const CHAT_EXPORT_FORMAT = 'datamoat-chat-export'
export const CHAT_EXPORT_FORMAT_VERSION = 1

// One attachment after it has been written into files/.
export interface ExportAsset {
  id: string
  name: string          // friendly filename inside files/
  size: number
  mediaType: string
  isImage: boolean
  dataUri: string       // non-empty only when embedded inline (images under cap)
}

export interface ExportAssets {
  list: ExportAsset[]
  byId: Record<string, ExportAsset>
  byName: Record<string, ExportAsset>
}

export function emptyAssets(): ExportAssets {
  return { list: [], byId: {}, byName: {} }
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function slugify(s: unknown): string {
  return String(s || 'chat').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat'
}

export function humanSize(bytes: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function extForAttachment(mediaType?: string, name?: string): string {
  const fromName = name && /\.([a-z0-9]{1,5})$/i.exec(name)
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/jpg': 'jpg', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json',
    'text/markdown': 'md', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv',
  }
  const mapped = map[String(mediaType || '').toLowerCase()]
  if (fromName) {
    const ext = fromName[1].toLowerCase()
    if (mapped && (ext === 'bin' || ext === 'dat' || ext === 'tmp' || ext === 'blob')) return mapped
    return ext
  }
  return mapped || 'bin'
}

function fmtDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

function stripCodexReferenceBoilerplate(text: string): string {
  return text
    .replace(/(?:^|\n)Referenced pasted text files:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
    .replace(/(?:^|\n)Referenced image files:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
}

function normalizeReadableWhitespace(text: string): string {
  return text
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanReadableExportText(value: unknown): string {
  return normalizeReadableWhitespace(stripCodexReferenceBoilerplate(String(value == null ? '' : value)))
}

// Tiny, safe markdown -> HTML. Fenced code, inline code, bold/italic, headings,
// links, lists, paragraphs. Everything is escaped first.
export function mdToHtml(src: unknown): string {
  const text = String(src == null ? '' : src)
  const parts: Array<{ t: 'md' | 'code'; v: string; lang?: string }> = []
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(text))) {
    parts.push({ t: 'md', v: text.slice(last, m.index) })
    parts.push({ t: 'code', lang: m[1].trim(), v: m[2].replace(/\n$/, '') })
    last = fence.lastIndex
  }
  parts.push({ t: 'md', v: text.slice(last) })

  const inline = (s: string): string => {
    let out = esc(s)
    out = out.replace(/`([^`]+)`/g, (_x, c) => `<code class="inline">${c}</code>`)
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return out
  }

  return parts.map(p => {
    if (p.t === 'code') {
      return `<pre class="code"${p.lang ? ` data-lang="${esc(p.lang)}"` : ''}><code>${esc(p.v)}</code></pre>`
    }
    const normalized = normalizeReadableWhitespace(p.v)
    const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
    return blocks.map(b => {
      const h = b.match(/^(#{1,4})\s+(.*)$/)
      if (h) return `<h${h[1].length + 2} class="md-h">${inline(h[2])}</h${h[1].length + 2}>`
      if (/^[-*]\s+/.test(b)) {
        const items = b.split(/\n/).filter(l => /^[-*]\s+/.test(l))
          .map(l => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')
        return `<ul class="md-ul">${items}</ul>`
      }
      return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`
    }).join('\n')
  }).join('\n')
}

// ---------------------------------------------------------------------------
// cleaning: Message[] -> export schema v1 (re-importable)
// ---------------------------------------------------------------------------
type FileResolver = (id: string | undefined) => string | null

interface CleanBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
  file?: string | null
  files?: Array<string | null>
  mediaType?: string
}

export interface RenderChatViewerOptions {
  toolDetails?: 'full' | 'summary'
  showTitle?: boolean
  documentTitle?: string
}

function cleanBlock(block: Message['content'][number], fileFor: FileResolver): CleanBlock {
  switch (block.type) {
    case 'text': return { type: 'text', text: cleanReadableExportText(block.text || '') }
    case 'thinking': return { type: 'thinking', thinking: block.thinking || '' }
    case 'tool_use': return { type: 'tool_use', name: block.name || '', input: block.input ?? null }
    case 'tool_result': {
      const out: CleanBlock = { type: 'tool_result', name: block.name || '', content: block.content ?? block.text ?? '' }
      if (Array.isArray(block.attachmentIds) && block.attachmentIds.length) {
        out.files = block.attachmentIds.map(id => fileFor(id)).filter(Boolean)
      }
      return out
    }
    case 'image': return { type: 'image', file: fileFor(block.attachmentId), mediaType: block.mediaType || '', name: block.attachmentName || '' }
    case 'file': return { type: 'file', file: fileFor(block.attachmentId), mediaType: block.mediaType || '', name: block.attachmentName || '' }
    default: return { type: 'other', content: block.content ?? block.text ?? null }
  }
}

export interface CleanExport {
  format: string
  formatVersion: number
  exportedAt: string
  source: string
  title: string
  model: string
  messageCount: number
  messages: Array<{
    role: string
    timestamp: string
    model?: string
    event?: string
    content: CleanBlock[]
  }>
}

export function buildCleanExport(session: Session, messages: Message[], fileFor: FileResolver, title: string): CleanExport {
  return {
    format: CHAT_EXPORT_FORMAT,
    formatVersion: CHAT_EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: session.source,
    title,
    model: session.model,
    messageCount: messages.length,
    messages: messages.map(msg => ({
      role: msg.role,
      timestamp: msg.timestamp,
      model: msg.model || undefined,
      event: msg.sourceEventType || undefined,
      content: (msg.content || []).map(b => cleanBlock(b, fileFor)),
    })),
  }
}

// ---------------------------------------------------------------------------
// clean markdown (mirrors server formatContextPackForClipboard)
// ---------------------------------------------------------------------------
export function renderChatMarkdown(session: Session, messages: Message[], title: string): string {
  const lines = ['# DataMoat chat export', '', `- source: ${session.source}`, `- title: ${title}`, `- model: ${session.model}`, `- messages: ${messages.length}`, '']
  messages.forEach((m, i) => {
    lines.push(`## ${i + 1}. ${m.role}`)
    const meta = [m.model && `model: ${m.model}`, m.sourceEventType && `event: ${m.sourceEventType}`, m.timestamp && `timestamp: ${m.timestamp}`].filter(Boolean) as string[]
    if (meta.length) lines.push(meta.map(x => `- ${x}`).join('\n'))
    lines.push('')
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text) lines.push(b.text, '')
      else if (b.type === 'thinking' && b.thinking) lines.push('```thinking', b.thinking, '```', '')
      else if (b.type === 'tool_use') lines.push(`### tool call${b.name ? ` (${b.name})` : ''}`, '```json', JSON.stringify(b.input ?? '', null, 2), '```', '')
      else if (b.type === 'tool_result') lines.push(`### tool result${b.name ? ` (${b.name})` : ''}`, '```', typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? b.text ?? '', null, 2), '```', '')
      else if (b.type === 'image') lines.push(`[image attachment: ${b.attachmentName || 'image'}${b.mediaType ? `, ${b.mediaType}` : ''}]`, '')
      else if (b.type === 'file') lines.push(`[file attachment: ${b.attachmentName || 'file'}${b.mediaType ? `, ${b.mediaType}` : ''}]`, '')
    }
  })
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// viewer.html — all-in-one
// ---------------------------------------------------------------------------
const ROLE_META: Record<string, { label: string; cls: string }> = {
  user: { label: 'You', cls: 'user' },
  assistant: { label: 'Assistant', cls: 'assistant' },
  tool: { label: 'Tool', cls: 'tool' },
  system: { label: 'System', cls: 'system' },
}

function fileCard(asset: ExportAsset | undefined, name: string, mediaType: string): string {
  const label = displayAttachmentName(name, asset, 'file')
  const size = asset ? humanSize(asset.size) : ''
  const type = mediaType || (asset && asset.mediaType) || ''
  const href = asset ? `files/${encodeURIComponent(asset.name)}` : '#'
  return `<a class="file-card" href="${href}" target="_blank" rel="noopener"><span class="file-ic">&#128206;</span><span class="file-main"><span class="file-name">${esc(label)}</span><span class="file-meta">${esc(type)}${size ? ` &middot; ${size}` : ''}</span></span><span class="file-open">Open &rsaquo;</span></a>`
}

function displayAttachmentName(name: string | undefined, asset: ExportAsset | undefined, fallback: string): string {
  const label = String(name || '').trim()
  if (asset && /\.(bin|dat|tmp|blob)$/i.test(label)) return asset.name
  return label || (asset && asset.name) || fallback
}

function imgTag(asset: ExportAsset, alt: string): string {
  const src = asset.dataUri || `files/${encodeURIComponent(asset.name)}`
  return `<img class="att-img" src="${src}" alt="${esc(alt)}">`
}

function toolImagesHtml(files: Array<string | null> | undefined, assets: ExportAssets): string {
  return (files || [])
    .map(f => f ? assets.byName[f] : undefined)
    .filter((a): a is ExportAsset => !!a && a.isImage)
    .map(a => `<figure class="att tool-image">${imgTag(a, a.name)}<figcaption>${esc(a.name)}</figcaption></figure>`)
    .join('')
}

function renderBlock(b: CleanBlock, assets: ExportAssets, options: RenderChatViewerOptions): string {
  if (b.type === 'text') {
    if (!String(b.text || '').trim()) return ''
    return `<div class="text">${mdToHtml(b.text)}</div>`
  }
  if (b.type === 'thinking') {
    if (!String(b.thinking || '').trim()) return ''
    return `<details class="thinking"><summary>Thinking</summary><div class="text">${mdToHtml(b.thinking)}</div></details>`
  }
  if (b.type === 'tool_use') {
    if (options.toolDetails === 'summary') {
      return `<div class="tool-card compact"><div class="tool-head"><span class="tool-ic">&#9881;</span> Tool call${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}</div></div>`
    }
    const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)
    return `<div class="tool-card"><div class="tool-head"><span class="tool-ic">&#9881;</span> Tool call${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}</div><pre class="code"><code>${esc(input || '')}</code></pre></div>`
  }
  if (b.type === 'tool_result') {
    if (options.toolDetails === 'summary') {
      const imgs = toolImagesHtml(b.files, assets)
      return `<div class="tool-card result compact"><div class="tool-head"><span class="tool-ic">&#8623;</span> Tool result${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}</div>${imgs}</div>`
    }
    const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2)
    const imgs = toolImagesHtml(b.files, assets)
    return `<div class="tool-card result"><div class="tool-head"><span class="tool-ic">&#8623;</span> Tool result${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}</div><pre class="code"><code>${esc(content || '')}</code></pre>${imgs}</div>`
  }
  if (b.type === 'image') {
    const a = b.file ? assets.byName[b.file] : undefined
    if (a && a.isImage) {
      const label = displayAttachmentName(b.name, a, 'image')
      return `<figure class="att">${imgTag(a, label)}<figcaption>${esc(label)}</figcaption></figure>`
    }
    return fileCard(a, b.name || '', b.mediaType || '')
  }
  if (b.type === 'file') return fileCard(b.file ? assets.byName[b.file] : undefined, b.name || '', b.mediaType || '')
  return `<pre class="code"><code>${esc(JSON.stringify(b.content, null, 2))}</code></pre>`
}

export function renderChatViewerHtml(clean: CleanExport, assets: ExportAssets, options: RenderChatViewerOptions = {}): string {
  const rows = clean.messages.map(msg => {
    const role = ROLE_META[msg.role] || { label: msg.role, cls: 'system' }
    const meta = [msg.model, msg.event, fmtDate(msg.timestamp)].filter(Boolean).map(esc).join(' &middot; ')
    const blocks = (msg.content || []).map(b => renderBlock(b, assets, options)).filter(Boolean).join('\n')
    return `<article class="msg ${role.cls}">
      <div class="msg-rail"></div>
      <div class="msg-body">
        <header class="msg-head"><span class="role">${esc(role.label)}</span>${meta ? `<span class="msg-meta">${meta}</span>` : ''}</header>
        ${blocks}
      </div>
    </article>`
  }).join('\n')

  const dateRange = clean.messages.length
    ? `${fmtDate(clean.messages[0].timestamp)} &ndash; ${fmtDate(clean.messages[clean.messages.length - 1].timestamp)}`
    : ''
  const nImg = assets.list.filter(a => a.isImage).length
  const nFile = assets.list.length - nImg

  const titleHtml = options.showTitle === false ? '' : `<h1>${esc(clean.title)}</h1>`
  const documentTitle = options.documentTitle || clean.title

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="DataMoat ${esc(clean.format)} v${clean.formatVersion}">
<title>${esc(documentTitle)} &mdash; DataMoat export</title>
<style>
  :root{
    --bg:#171717;--panel:#202020;--panel2:#252525;--border:#343434;--border2:#444;
    --text:rgba(255,255,255,.90);--muted:rgba(255,255,255,.46);--muted2:rgba(255,255,255,.66);
    --accent:#74b6a5;--user:#8abf9b;--tool:#c79a6b;
    --sans:"PingFang HK","PingFang TC","PingFang SC","Hiragino Sans GB","Heiti TC","Heiti SC","Songti TC","Songti SC","Microsoft JhengHei","Microsoft YaHei","Yu Gothic","Meiryo","Malgun Gothic","Noto Sans CJK TC","Noto Sans CJK SC","Noto Sans CJK JP","Noto Sans CJK KR","Noto Sans Thai","Noto Naskh Arabic","Geeza Pro","Arial Unicode MS",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"PingFang HK","PingFang TC","PingFang SC","Hiragino Sans GB","Microsoft JhengHei","Microsoft YaHei","Noto Sans CJK TC","Noto Sans CJK SC","Noto Sans CJK JP","Noto Sans CJK KR","Arial Unicode MS",monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:13.2px/1.55 var(--sans);
    -webkit-font-smoothing:antialiased;}
  a{color:var(--accent)}
  .promo{display:flex;gap:8px;align-items:center;justify-content:center;
    padding:7px 14px;font-size:12px;color:var(--muted2);
    background:linear-gradient(90deg,rgba(116,182,165,.10),rgba(116,182,165,.03));
    border-bottom:1px solid var(--border);flex-wrap:wrap;text-align:center}
  .promo b{color:var(--accent);font-weight:600}
  .promo a{text-decoration:none}
  .wrap{max-width:840px;margin:0 auto;padding:30px 22px 80px}
  header.doc{margin:14px 0 26px;padding-bottom:20px;border-bottom:1px solid var(--border)}
  header.doc h1{font-size:21px;margin:0 0 10px;font-weight:650;letter-spacing:0;overflow-wrap:anywhere}
  .doc-meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted);min-width:0;max-width:100%}
  .doc-meta span{min-width:0;max-width:100%;overflow-wrap:anywhere}
  .doc-meta b{color:var(--muted2);font-weight:600}
  .msg{display:flex;gap:14px;margin:0 0 22px}
  .msg-rail{width:3px;border-radius:3px;flex:none;background:var(--border2)}
  .msg.user .msg-rail{background:var(--user)}
  .msg.assistant .msg-rail{background:var(--accent)}
  .msg.tool .msg-rail{background:var(--tool)}
  .msg-body{min-width:0;flex:1}
  .msg-head{display:flex;align-items:baseline;gap:4px 10px;margin-bottom:7px;flex-wrap:wrap;min-width:0}
  .role{font-weight:650;font-size:13px}
  .msg.user .role{color:var(--user)}.msg.assistant .role{color:var(--accent)}.msg.tool .role{color:var(--tool)}
  .msg-meta{font-size:11px;color:var(--muted);min-width:0;max-width:100%;overflow-wrap:anywhere}
  .text{word-wrap:break-word;overflow-wrap:anywhere}
  .text p{margin:.5em 0}.text p:first-child{margin-top:0}
  .md-h{font-size:14px;margin:1em 0 .3em;color:var(--text)}
  .md-ul{margin:.4em 0;padding-left:1.3em}
  code.inline{font-family:var(--mono);font-size:.88em;background:var(--panel2);
    padding:1px 5px;border-radius:4px;border:1px solid var(--border)}
  pre.code{font-family:var(--mono);font-size:11px;line-height:1.45;background:var(--panel);
    border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;margin:.55em 0;
    scrollbar-color:var(--border2) var(--panel);scrollbar-width:thin}
  pre.code::-webkit-scrollbar{height:10px;width:10px}
  pre.code::-webkit-scrollbar-track{background:var(--panel);border-top:1px solid var(--border)}
  pre.code::-webkit-scrollbar-thumb{background:var(--border2);border-radius:999px;border:2px solid var(--panel)}
  pre.code::-webkit-scrollbar-thumb:hover{background:var(--muted)}
  pre.code code{white-space:pre}
  details.thinking{margin:.6em 0;border:1px dashed var(--border2);border-radius:8px;
    background:rgba(255,255,255,.015)}
  details.thinking summary{cursor:pointer;padding:8px 12px;color:var(--muted2);font-size:12px;
    user-select:none;font-weight:600}
  details.thinking[open] summary{border-bottom:1px dashed var(--border2)}
  details.thinking .text{padding:10px 14px;color:var(--muted2);font-size:12.6px}
  .tool-card{border:1px solid var(--border);border-radius:8px;margin:.6em 0;overflow:hidden;background:var(--panel)}
  .tool-card.result{background:rgba(116,182,165,.04)}
  .tool-card.compact .tool-head{border-bottom:0}
  .tool-head{padding:7px 12px;font-size:11.5px;color:var(--muted2);background:var(--panel2);
    border-bottom:1px solid var(--border)}
  .tool-head b{color:var(--text)}
  .tool-ic{color:var(--tool);margin-right:3px}
  .tool-card pre.code{border:0;border-radius:0;margin:0;background:transparent}
  .att{margin:.7em 0}
  .att-img{max-width:100%;max-height:520px;border-radius:8px;border:1px solid var(--border);display:block}
  figure.att{margin:.7em 0}
  figure.att figcaption{font-size:10.8px;color:var(--muted);margin-top:5px}
  .file-card{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;
    border:1px solid var(--border);border-radius:9px;padding:9px 12px;margin:.6em 0;background:var(--panel);
    transition:border-color .12s,background .12s}
  .file-card:hover{border-color:var(--accent);background:var(--panel2)}
  .file-ic{font-size:18px;flex:none}
  .file-main{display:flex;flex-direction:column;min-width:0;flex:1}
  .file-name{font-weight:600;font-size:12.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .file-meta{font-size:10.8px;color:var(--muted)}
  .file-open{color:var(--accent);font-size:11.5px;flex:none}
  footer.doc{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);
    text-align:center;font-size:11px;color:var(--muted)}
  footer.doc a{color:var(--accent);text-decoration:none}
  @media print{
    @page{size:1000px 1414px;margin:0}
    html,body{background:var(--bg)}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .wrap{max-width:840px;padding:30px 22px 60px}
    .tool-card pre.code{display:none}
    .tool-card.compact,.tool-card{break-inside:avoid}
    .tool-card .tool-head{border-bottom:0}
    .msg{break-inside:avoid}
    pre.code{overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
    pre.code code{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  }
</style>
</head><body>
  <div class="promo">Exported with <b>DataMoat</b> &mdash; your AI chats, backed up &amp; private on your own machine &middot; <a href="https://datamoat.org" target="_blank" rel="noopener">datamoat.org</a></div>
  <div class="wrap">
    <header class="doc">
      ${titleHtml}
      <div class="doc-meta">
        <span><b>Source</b> ${esc(clean.source)}</span>
        ${clean.model ? `<span><b>Model</b> ${esc(clean.model)}</span>` : ''}
        <span><b>Messages</b> ${clean.messageCount}</span>
        ${dateRange ? `<span><b>When</b> ${dateRange}</span>` : ''}
        ${(nImg || nFile) ? `<span><b>Attached</b> ${nImg} image${nImg === 1 ? '' : 's'}, ${nFile} file${nFile === 1 ? '' : 's'}</span>` : ''}
      </div>
    </header>
    ${rows}
    <footer class="doc">
      Generated by <a href="https://datamoat.org" target="_blank" rel="noopener">DataMoat</a> &middot; this is a clean, self-contained copy of your conversation.
    </footer>
  </div>
</body></html>`
}
