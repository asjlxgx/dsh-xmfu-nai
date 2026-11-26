/**
 * dsh-xmfu-nai —— XMFU 公共 API 出图插件 · DSH 宿主侧
 *
 * 凭据：pst-xmfu- 开头的个人 API Key（同一把 Key 支持下面全部公共接口）。
 *
 *   GET  /v1/models                    可用模型（验证 Key）
 *   GET  /api/v1/capabilities          站点模型能力表（验证 Key，只读）
 *   POST /v1/images/generations        文生图，返回 202 + taskId + pollUrl
 *   POST /v1/images/edits              GPT Image 参考图编辑，返回同上
 *   GET  /v1/tasks/{taskId}            轮询，succeeded 时 data[0].b64_json
 *
 * 注意：站点网页版 /api/v1/generations 系列是登录会话接口，API Key 会返回
 * INVALID_SESSION，本插件不再调用它。公共 API 没有余额/报价接口，锅巴守卫
 * 使用本地估算 + 一次性确认码，而不是实时报价。
 *
 * 默认线路：https://api.xmfu.cn
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as pathResolve, dirname, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

function loadDefineTool() {
  const candidates = []
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p) }
  try {
    const argv1 = process.argv[1] ? String(process.argv[1]).replace(/\\/g, '/') : ''
    if (argv1) {
      const nm = argv1.lastIndexOf('/node_modules/')
      if (nm >= 0) push(join(argv1.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      const i = argv1.lastIndexOf('/')
      if (i >= 0) push(join(argv1.slice(0, i), '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    push(join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      push(join(home, 'profiles', profile, 'package.json'))
      push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  push(join(process.cwd(), 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  return null
}

const hostDefineTool = loadDefineTool()
const defineTool = typeof hostDefineTool === 'function'
  ? hostDefineTool
  : ((tool) => tool)

export const name = 'xmfu-nai'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'xmfu-nai')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const MEDIA_DIR = join(DSH_HOME, 'media', 'xmfu-nai')
const CRED_PATH = join(DSH_HOME, '.credentials.yaml')
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_PREFIX = '/api/xmfu-nai'

const ROUTES = {
  cn: 'https://api.xmfu.cn',
  cc: 'https://api.xmfu.cc',
  esa: 'https://esaapi.xmfu.cn',
}
const ROUTE_IDS = Object.keys(ROUTES)

const NOVELAI_MODELS = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-full-medium',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-furry-3',
]
const GPT_MODELS = ['gpt-image-2.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']
const SAMPLERS = [
  'k_euler', 'k_euler_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral',
  'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'ddim', 'ddim_v3',
]
const SCHEDULES = ['native', 'karras', 'exponential', 'polyexponential']
const DEFAULT_NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, watermark'

const DEFAULT_CONFIG = {
  enabled: true,
  route: 'cn',
  baseUrl: ROUTES.cn,
  apiKeyEnv: 'XMFU_API_KEY',
  apiKey: '',
  provider: 'novelai',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 23,
  scale: 7,
  sampler: 'k_euler_ancestral',
  noise_schedule: 'karras',
  includeAdvanced: false,
  qualityPresetId: 'standard',
  qualityToggle: true,
  ucPreset: 3,
  resolution: '832x1216',
  negativePrompt: DEFAULT_NEGATIVE,
  promptSuffix: '',
  seed: 0,
  count: 1,
  quoteGuard: true,
  member: false,
  pollMs: 2000,
  timeoutMs: 600000,
}

let config = { ...DEFAULT_CONFIG }
let configMtime = 0
let logger = () => {}
let lastGeneration = null
let PKG_VERSION = '0.0.0'
try { PKG_VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || PKG_VERSION } catch { /* ignore */ }
const bridge = { lastSeen: null, count: 0, build: 'v' + PKG_VERSION, lastHost: '' }

// ---- log / config -------------------------------------------------------

function log(message) {
  try { logger(`[xmfu-nai] ${message}`) } catch { /* ignore */ }
}

function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof DEFAULT_CONFIG[key] === 'boolean') out[key] = Boolean(value)
    else if (typeof DEFAULT_CONFIG[key] === 'number') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = n
    } else if (typeof value === 'string') out[key] = value
  }
  if (!ROUTE_IDS.includes(out.route)) out.route = 'cn'
  out.baseUrl = normalizeOrigin(out.baseUrl) || ROUTES[out.route]
  return out
}

function normalizeOrigin(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  s = s.replace(/\/api\/v1$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
  return /^https?:\/\/[^/]+$/.test(s) ? s : ''
}

function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return
    config = normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
    try { configMtime = statSync(CONFIG_PATH).mtimeMs } catch { /* ignore */ }
  } catch { /* ignore broken config */ }
}

function maybeReloadConfig() {
  try {
    const m = statSync(CONFIG_PATH).mtimeMs
    if (m !== configMtime) loadConfig()
  } catch { /* ignore */ }
}

function saveConfig() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(tmp, CONFIG_PATH)
    try { configMtime = statSync(CONFIG_PATH).mtimeMs } catch { /* ignore */ }
    try { chmodSync(CONFIG_PATH, 0o600) } catch { /* Windows */ }
  } catch (error) {
    log('写配置失败：' + String((error && error.message) || error))
  }
}

function masked(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 12) return s.slice(0, 4) + '…'
  return s.slice(0, 10) + '…' + s.slice(-4)
}

function publicConfig() {
  maybeReloadConfig()
  return {
    ...config,
    apiKey: '',
    apiKeyMasked: masked(config.apiKey),
    hasApiKey: Boolean(config.apiKey),
  }
}

function applyConfig(body = {}, opts = {}) {
  maybeReloadConfig()
  const next = { ...config }
  const stringKeys = ['route', 'baseUrl', 'apiKeyEnv', 'apiKey', 'provider', 'model', 'sampler', 'noise_schedule', 'qualityPresetId', 'resolution', 'negativePrompt', 'promptSuffix']
  const numberKeys = ['width', 'height', 'steps', 'scale', 'cfg_rescale', 'ucPreset', 'seed', 'count', 'pollMs', 'timeoutMs']
  const boolKeys = ['enabled', 'qualityToggle', 'quoteGuard', 'includeAdvanced', 'member']
  for (const key of stringKeys) {
    if (typeof body[key] === 'string') next[key] = body[key]
  }
  for (const key of numberKeys) {
    if (body[key] !== undefined) {
      const n = Number(body[key])
      if (Number.isFinite(n)) next[key] = n
    }
  }
  for (const key of boolKeys) {
    if (typeof body[key] === 'boolean') next[key] = body[key]
  }
  if (opts.clearApiKey === true) next.apiKey = ''
  if (!ROUTE_IDS.includes(next.route)) next.route = 'cn'
  next.baseUrl = normalizeOrigin(next.baseUrl) || ROUTES[next.route]
  next.width = clampInt(next.width, 64, 1600, 832)
  next.height = clampInt(next.height, 64, 1600, 1216)
  next.steps = clampInt(next.steps, 1, 50, 23)
  next.count = clampInt(next.count, 1, 4, 1)
  next.pollMs = clampInt(next.pollMs, 500, 10000, 2000)
  next.timeoutMs = clampInt(next.timeoutMs, 60000, 1800000, 600000)
  config = next
  saveConfig()
  return publicConfig()
}

function parseCredentialRefs() {
  const out = {}
  try {
    if (!existsSync(CRED_PATH)) return out
    const lines = readFileSync(CRED_PATH, 'utf8').split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (/^refs\s*:\s*$/.test(line)) { inRefs = true; continue }
      if (/^\S/.test(line)) {
        if (inRefs && !/^refs\s*:/.test(line)) inRefs = false
      }
      if (!inRefs) continue
      const m = line.match(/^\s{2,}([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/)
      if (!m) continue
      let value = m[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      out[m[1]] = value
    }
  } catch { /* ignore */ }
  return out
}

async function credentials() {
  maybeReloadConfig()
  const envName = String(config.apiKeyEnv || 'XMFU_API_KEY').trim() || 'XMFU_API_KEY'
  if (process.env[envName]) return { token: String(process.env[envName]).trim(), source: 'env', envName }
  const refs = parseCredentialRefs()
  if (refs[envName]) return { token: String(refs[envName]).trim(), source: '.credentials.yaml', envName }
  if (config.apiKey) return { token: String(config.apiKey).trim(), source: 'config', envName }
  return { token: '', source: '', envName }
}

// ---- helpers ------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function pickNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unwrap(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if ('data' in data && !('error' in data)) return data.data
  }
  return data
}

function describeError(status, data, text = '') {
  const err = data && typeof data === 'object' ? (data.error || data) : null
  const code = err && (err.code || err.type) ? String(err.code || err.type) : ''
  const message = err && err.message ? String(err.message) : ''
  const parts = [`HTTP ${status}`]
  if (code) parts.push(code)
  if (message) parts.push(message.slice(0, 400))
  if (!message && text) parts.push(String(text).slice(0, 400))
  return parts.join(' · ')
}

function apiOrigin() {
  maybeReloadConfig()
  return normalizeOrigin(config.baseUrl) || ROUTES[config.route] || ROUTES.cn
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function safeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function sniffImageExt(buf) {
  if (!buf || buf.length < 8) return 'png'
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return 'png'
}

function imageInlineMd(filePath) {
  const host = bridge.lastHost || '127.0.0.1:43129'
  return '![生成图](http://' + host + API_PREFIX + '/file?path=' + encodeURIComponent(String(filePath)) + ')'
}

function outputPaths(value) {
  const paths = Array.isArray(value && value.paths) ? value.paths : []
  const lines = []
  const units = value && value.units !== undefined ? value.units : (value && value.estimatedUnits)
  const costText = value && value.member
    ? ' · 会员 · 不扣锅巴'
    : units !== undefined ? ' · 估算 ' + units + ' 锅巴' : ''
  lines.push(`✓ 出了 ${paths.length} 张 · ${value?.provider || 'novelai'} · ${value?.model || ''}${costText}`)
  for (const item of paths) lines.push('  ' + item)
  if (value && value.partial) lines.push('⚠ 部分失败：' + value.partial)
  if (paths.length > 0) {
    lines.push('对话内直接显示请原样使用：')
    for (const item of paths) lines.push(imageInlineMd(item))
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function errorOutput(value, fallback) {
  return [{ type: 'text', text: '✗ ' + String((value && value.message) || fallback) }]
}

// ---- HTTP ---------------------------------------------------------------

async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    token = '',
    timeoutMs = 60000,
    headers: extraHeaders = {},
    raw = false,
    retries = 1,
  } = options
  const headers = { ...extraHeaders }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let attempt = 0
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(apiOrigin() + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (raw) {
        const buffer = Buffer.from(await resp.arrayBuffer())
        return {
          ok: resp.ok,
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          buffer,
          text: '',
          data: null,
        }
      }
      const text = await resp.text()
      let data = null
      if (text !== '') {
        try { data = JSON.parse(text) } catch { data = null }
      }
      return { ok: resp.ok, status: resp.status, contentType: resp.headers.get('content-type') || '', buffer: null, text, data }
    } catch (error) {
      const message = String((error && error.message) || error)
      const transient = error && error.name === 'AbortError'
        ? true
        : /fetch failed|ECONNRESET|socket hang up|network/i.test(message)
      if (attempt >= retries || !transient) {
        throw new Error(`${path} 请求失败：${message}（API ${apiOrigin()}）`)
      }
      attempt += 1
      await sleep(400 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }
}

function readLocalImage(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('没有收到图片')
  if (raw.startsWith('data:')) return raw
  if (/^[A-Za-z0-9+/=\r\n]{120,}$/.test(raw) && !raw.includes(':') && !raw.includes('\\')) {
    return 'data:image/png;base64,' + raw.replace(/\s+/g, '')
  }
  const filePath = pathResolve(raw)
  if (!existsSync(filePath)) throw new Error('图片文件不存在：' + filePath)
  const ext = extname(filePath).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,` + readFileSync(filePath).toString('base64')
}

// ---- request body -------------------------------------------------------

function novelaiSize(width, height) {
  let w = clampInt(Math.round(Number(width) / 64) * 64, 64, 1600, 832)
  let h = clampInt(Math.round(Number(height) / 64) * 64, 64, 1600, 1216)
  while (w * h > 3145728) {
    w = Math.max(64, w - 64)
    h = Math.max(64, h - 64)
  }
  return `${w}x${h}`
}

function gptSize(width, height) {
  const w = clampInt(Math.round(Number(width) / 16) * 16, 256, 3840, 832)
  const h = clampInt(Math.round(Number(height) / 16) * 16, 256, 3840, 1216)
  return `${w}x${h}`
}

function isGptModel(model) {
  return /^gpt-image/i.test(String(model || ''))
}

function buildRequestBody(args = {}) {
  maybeReloadConfig()
  const provider = String(pickFirst(args.provider, config.provider, 'novelai'))
  const model = String(pickFirst(args.model, config.model, 'nai-diffusion-4-5-full'))
  const gpt = isGptModel(model) || provider === 'gpt-image'
  const actualModel = gpt && !isGptModel(model) ? GPT_MODELS[0] : model
  const width = clampInt(pickFirst(args.width, config.width, 832), 64, 3840, 832)
  const height = clampInt(pickFirst(args.height, config.height, 1216), 64, 3840, 1216)
  const promptSuffix = String(config.promptSuffix || '')
  const prompt = String(pickFirst(args.prompt, '') || '')
  const finalPrompt = promptSuffix ? promptSuffix + ', ' + prompt : prompt
  if (!finalPrompt.trim()) throw new Error('提示词不能为空')

  const body = {
    model: actualModel,
    prompt: finalPrompt.slice(0, 4000),
    size: gpt ? gptSize(width, height) : novelaiSize(width, height),
    n: 1,
    response_format: 'b64_json',
  }

  if (gpt) {
    const background = String(pickFirst(args.background, 'auto'))
    if (['transparent', 'opaque', 'auto'].includes(background)) body.background = background
    return { body, provider, model: actualModel, gpt: true, edit: false }
  }

  const negative = String(pickFirst(args.negative, args.negative_prompt, config.negativePrompt, DEFAULT_NEGATIVE))
  const steps = clampInt(pickFirst(args.steps, config.steps, 23), 1, 50, 23)
  const scale = pickNumber(pickFirst(args.scale, config.scale, 7), 7)
  const seedInput = pickFirst(args.seed, config.seed, 0)
  const seed = Number(seedInput) > 0 ? Math.trunc(Number(seedInput)) : 0
  const novelai = { negative_prompt: negative.slice(0, 4000), steps, scale }
  if (seed > 0) novelai.seed = Math.min(seed, 4294967295)
  if (config.includeAdvanced === true) {
    novelai.sampler = String(pickFirst(args.sampler, config.sampler, 'k_euler_ancestral'))
    novelai.noise_schedule = String(pickFirst(args.noise_schedule, config.noise_schedule, 'karras'))
  }
  body.novelai = novelai
  return { body, provider, model: actualModel, gpt: false, edit: false }
}

function buildEditBody(args = {}, action = 'img2img') {
  maybeReloadConfig()
  const image = readLocalImage(pickFirst(args.image, args.image_path, args.base64))
  const promptSuffix = String(config.promptSuffix || '')
  const rawPrompt = String(pickFirst(args.prompt, '') || '')
  const prompt = promptSuffix ? promptSuffix + ', ' + rawPrompt : rawPrompt
  if (!prompt.trim()) throw new Error('提示词不能为空')
  const width = clampInt(pickFirst(args.width, config.width, 832), 256, 3840, 832)
  const height = clampInt(pickFirst(args.height, config.height, 1216), 256, 3840, 1216)
  const model = String(pickFirst(args.model, 'gpt-image-2.5'))
  const body = {
    model: isGptModel(model) ? model : GPT_MODELS[0],
    prompt: prompt.slice(0, 4000),
    size: gptSize(width, height),
    image,
    n: 1,
    response_format: 'b64_json',
  }
  const background = String(pickFirst(args.background, 'auto'))
  if (['transparent', 'opaque', 'auto'].includes(background)) body.background = background
  return { body, provider: 'gpt-image', model: body.model, gpt: true, edit: true, action }
}

// ---- cost estimate + confirmation guard --------------------------------

function estimateUnits(info, count = 1) {
  maybeReloadConfig()
  if (config.member === true) return 0
  const model = String(info.model || '')
  const size = String(info.body && info.body.size || '832x1216')
  const [w, h] = size.split('x').map((v) => Number(v) || 0)
  const large = w * h > 1024 * 1024
  let per = 8
  let flat = false
  if (/^nai-diffusion-5-full-medium/.test(model)) per = large ? 72 : 42
  else if (/^nai-diffusion-5-/.test(model)) per = large ? 120 : 70
  else if (/^nai-diffusion-4-5-/.test(model)) { per = 20; flat = true }
  else if (/^nai-diffusion-4-/.test(model)) per = large ? 40 : 8
  else if (/^nai-diffusion-3|^nai-diffusion-furry-3/.test(model)) per = large ? 20 : 5
  else if (/^gpt-image/.test(model)) { per = 15; flat = true }
  const steps = info.body && info.body.novelai && Number(info.body.novelai.steps)
  if (!flat && steps && steps > 28) per += 30
  if (info.edit) per = Math.max(per, 15)
  return per * clampInt(count, 1, 4, 1)
}

const paidConfirms = new Map()

function makePaidCode() {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000))
    if (!paidConfirms.has(code)) {
      paidConfirms.set(code, { expiresAt: Date.now() + 5 * 60 * 1000, used: false })
      return code
    }
  }
}

function consumePaidCode(code) {
  const c = String(code || '').trim()
  const entry = paidConfirms.get(c)
  if (!entry) return false
  if (entry.used || Date.now() > entry.expiresAt) {
    paidConfirms.delete(c)
    return false
  }
  paidConfirms.delete(c)
  return true
}

function prunePaidCodes() {
  const now = Date.now()
  for (const [code, entry] of paidConfirms) {
    if (entry.used || now > entry.expiresAt) paidConfirms.delete(code)
  }
}

function enforceConfirm(args, info, estimated, count) {
  maybeReloadConfig()
  if (config.member === true) {
    log('会员通道：不扣锅巴，跳过确认守卫')
    return
  }
  if (config.quoteGuard === false) return
  prunePaidCodes()
  if (args && args.paid_code && consumePaidCode(args.paid_code)) {
    log(`锅巴守卫：确认码有效，放行 ${estimated} 锅巴（估算）`)
    return
  }
  const code = makePaidCode()
  const invalidCode = args && args.paid_code ? '\n⚠ 上次确认码无效或过期（一次性、5 分钟内有效），已重新生成。' : ''
  const b = info.body
  const params = `${info.provider} · ${info.model} · ${b.size} · ${b.novelai ? b.novelai.steps + ' 步 · CFG ' + b.novelai.scale : info.edit ? '参考图编辑' : 'GPT Image'} · ${count} 张`
  throw new Error(
    `⛔ 本次 XMFU 出图会消耗锅巴，按用户要求先拦下，没有提交任何任务。\n` +
    `估算消耗：约 ${estimated} 锅巴（公共 API 没有实时报价接口，实际以站点结算为准）。\n` +
    `参数：${params}。${invalidCode}\n` +
    `【必须先问用户】把下面这段原样发给用户，等用户明确同意后再继续：\n` +
    `  「这次 XMFU 出图预计花约 ${estimated} 锅巴。确认付费请回复确认码 ${code}（5 分钟内有效，只能用一次）；不想花钱就改小图/低步数/1 张。」\n` +
    `只有用户明确回复了这个确认码，才允许再次调用本工具并传 paid_code:${code}。不要自行猜测或替用户决定。\n` +
    `（关闭守卫：设置页关掉 quoteGuard；不推荐）`,
  )
}

// ---- task submit / poll / decode ---------------------------------------

async function submitTask(info, token) {
  const path = info.edit ? '/v1/images/edits' : '/v1/images/generations'
  const r = await apiRequest(path, {
    method: 'POST',
    body: info.body,
    token,
    timeoutMs: 120000,
    headers: { 'Idempotency-Key': randomUUID() },
  })
  const data = r.data && typeof r.data === 'object' ? r.data : {}
  if (!r.ok || data && data.error) {
    throw new Error('提交任务失败：' + describeError(r.status, data, r.text))
  }
  const taskId = pickFirst(data.taskId, data.task_id, data.id)
  if (!taskId) throw new Error('提交成功但没拿到 taskId：' + JSON.stringify(data).slice(0, 500))
  const pollUrl = String(pickFirst(data.pollUrl, data.poll_url, `/v1/tasks/${taskId}`))
  return { taskId: String(taskId), pollUrl: pollUrl.startsWith('/') ? pollUrl : '/' + pollUrl }
}

async function waitForTask(task, token) {
  maybeReloadConfig()
  const deadline = Date.now() + config.timeoutMs
  const pollMs = config.pollMs
  while (Date.now() < deadline) {
    const r = await apiRequest(task.pollUrl, { token, timeoutMs: 30000 })
    const data = r.data && typeof r.data === 'object' ? r.data : {}
    const status = String(pickFirst(data.status, data.state, '')).toLowerCase()
    if (r.ok && status === 'succeeded') return data
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) {
      const message = pickFirst(data.error && data.error.message, data.errorMessage, data.error, data.reason, status)
      throw new Error('任务失败：' + String(typeof message === 'object' ? JSON.stringify(message) : message))
    }
    if (!r.ok && r.status >= 400 && !data.status) {
      throw new Error('查询任务失败：' + describeError(r.status, data, r.text))
    }
    await sleep(pollMs)
  }
  throw new Error(`任务 ${task.taskId} 等待超时（${Math.round(config.timeoutMs / 1000)}s），任务可能仍在继续；请用 taskId 查询，不要重复提交`)
}

function decodeImages(result) {
  const data = Array.isArray(result && result.data) ? result.data : []
  const buffers = []
  for (const item of data) {
    const b64 = typeof item === 'string' ? item : pickFirst(item && item.b64_json, item && item.b64, item && item.image)
    if (typeof b64 !== 'string' || b64.length < 100) continue
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length > 32) buffers.push(buffer)
  }
  return buffers
}

function writeImages(buffers, prefix) {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const at = stamp()
  const paths = []
  buffers.forEach((buffer, index) => {
    const ext = sniffImageExt(buffer)
    let file = join(MEDIA_DIR, `${prefix}-${at}-${index}.${ext}`)
    let n = 0
    while (existsSync(file)) {
      n += 1
      file = join(MEDIA_DIR, `${prefix}-${at}-${index}-r${n}.${ext}`)
    }
    writeFileSync(file, buffer)
    paths.push(file)
  })
  return paths
}

async function runOne(info, token, prefix, index) {
  const task = await submitTask(info, token)
  const done = await waitForTask(task, token)
  const buffers = decodeImages(done)
  if (buffers.length === 0) {
    throw new Error('任务成功但没有图片数据：' + JSON.stringify(done).slice(0, 500))
  }
  return { paths: writeImages(buffers, prefix), taskId: task.taskId }
}

// ---- public entry points ------------------------------------------------

async function runGenerate(args = {}) {
  maybeReloadConfig()
  if (config.enabled === false) throw new Error('插件已禁用：在设置 → XMFU NAI 打开 enabled。')
  const { token } = await credentials()
  if (!token) {
    throw new Error('没有 XMFU API Key。去 https://www.xmfu.cc/app#studio → API 密钥创建 pst-xmfu- 开头的 Key，填进设置页；或在 ~/.dsh/.credentials.yaml 的 refs 里写 XMFU_API_KEY。')
  }
  const info = buildRequestBody(args)
  const count = clampInt(pickFirst(args.count, config.count, 1), 1, 4, 1)
  const estimated = estimateUnits(info, count)

  if (args.quote === true) {
    return {
      ok: true,
      member: config.member === true,
      quote: {
        estimatedUnits: estimated,
        note: config.member === true
          ? '会员通道，不扣锅巴'
          : '公共 API 无实时报价接口，v4.5 full 按 20 锅巴/张估算，实际以站点结算为准',
      },
      units: estimated,
      estimatedUnits: estimated,
      payableUnits: estimated,
      estimated: true,
      provider: info.provider,
      model: info.model,
      count,
    }
  }

  enforceConfirm(args, info, estimated, count)

  const prefix = safeName(args.name) || 'xmfu'
  const paths = []
  const taskIds = []
  let firstError = null

  for (let index = 0; index < count; index += 1) {
    try {
      const one = clone(info)
      if (one.body && one.body.novelai && one.body.novelai.seed) {
        one.body.novelai.seed = (Number(one.body.novelai.seed) + index) % 4294967295
      }
      const written = await runOne(one, token, prefix, index)
      paths.push(...written.paths)
      taskIds.push(written.taskId)
    } catch (error) {
      if (!firstError) firstError = error
    }
  }

  if (paths.length === 0) throw firstError || new Error('生成失败，没有拿到图片')
  const result = {
    ok: true,
    paths,
    count: paths.length,
    taskIds,
    member: config.member === true,
    units: estimated,
    estimatedUnits: estimated,
    provider: info.provider,
    model: info.model,
    mediaDir: MEDIA_DIR,
  }
  if (firstError) result.partial = String((firstError && firstError.message) || firstError)
  lastGeneration = {
    at: new Date().toISOString(),
    paths,
    taskIds,
    estimatedUnits: estimated,
    provider: info.provider,
    model: info.model,
  }
  return result
}

async function runEdit(args = {}, action = 'img2img') {
  maybeReloadConfig()
  if (config.enabled === false) throw new Error('插件已禁用：在设置 → XMFU NAI 打开 enabled。')
  const { token } = await credentials()
  if (!token) throw new Error('没有 XMFU API Key。')
  let info
  try {
    info = buildEditBody(args, action)
  } catch (error) {
    throw error
  }
  if (args.quote === true) {
    const estimated = estimateUnits(info, 1)
    return { ok: true, units: estimated, estimatedUnits: estimated, estimated: true, provider: info.provider, model: info.model, count: 1 }
  }
  const estimated = estimateUnits(info, 1)
  enforceConfirm(args, info, estimated, 1)
  const prefix = safeName(args.name) || (action === 'infill' ? 'xmfu-infill' : 'xmfu-edit')
  const written = await runOne(info, token, prefix, 0)
  const paths = written.paths
  return {
    ok: true,
    paths,
    count: paths.length,
    taskIds: [written.taskId],
    units: estimated,
    estimatedUnits: estimated,
    provider: info.provider,
    model: info.model,
    mediaDir: MEDIA_DIR,
  }
}

async function listModels(token = '') {
  const r = await apiRequest('/v1/models', { token, timeoutMs: 30000 })
  const data = r.data && typeof r.data === 'object' ? r.data : {}
  if (!r.ok) return { ok: false, error: describeError(r.status, data, r.text), models: [], providers: [] }
  const models = Array.isArray(data.data) ? data.data.map((m) => ({ id: m.id, owned_by: m.owned_by })) : []
  let providers = []
  try {
    const cr = await apiRequest('/api/v1/capabilities', { token, timeoutMs: 30000 })
    const cd = cr.data && typeof cr.data === 'object' ? cr.data : {}
    if (cr.ok && Array.isArray(cd.providers)) providers = cd.providers
  } catch { /* capabilities 是辅助，失败不影响 Key 有效性 */ }
  return { ok: true, models, providers }
}

async function runStatus() {
  const cred = await credentials()
  const out = {
    ok: true,
    api: apiOrigin() + '/v1',
    keySource: cred.source,
    envName: cred.envName,
    hasKey: Boolean(cred.token),
    mediaDir: MEDIA_DIR,
    config: publicConfig(),
    lastGeneration,
    creditsNote: '公共 API Key 没有余额查询接口；锅巴余额请在 XMFU 网页端查看。',
  }
  if (!cred.token) {
    out.keyValid = false
    out.message = '没有 API Key'
    return out
  }
  try {
    const r = await apiRequest('/v1/models', { token: cred.token, timeoutMs: 30000 })
    out.keyValid = r.ok
    if (r.ok) {
      const data = r.data && typeof r.data === 'object' ? r.data : {}
      out.modelCount = Array.isArray(data.data) ? data.data.length : 0
    } else {
      out.keyError = describeError(r.status, r.data, r.text)
    }
  } catch (error) {
    out.keyValid = undefined
    out.keyError = String((error && error.message) || error)
  }
  try {
    const caps = await listModels(cred.token)
    out.capabilitiesOk = caps.ok
    out.providers = caps.providers || []
    out.models = (caps.models || []).map((m) => m.id)
    if (!caps.ok) out.capabilitiesError = caps.error
  } catch (error) {
    out.capabilitiesOk = false
    out.capabilitiesError = String((error && error.message) || error)
  }
  return out
}

// ---- DSH plugin apply ---------------------------------------------------

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolvePromise({})
      try { resolvePromise(JSON.parse(text)) } catch { resolvePromise({}) }
    })
    req.on('error', () => resolvePromise({}))
  })
}

function sendFile(res, file) {
  const ext = extname(file).toLowerCase()
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  const buffer = readFileSync(file)
  res.statusCode = 200
  res.setHeader('content-type', types[ext] || 'application/octet-stream')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.end(buffer)
}

export function apply(ctx) {
  logger = (message) => { try { ctx.logger?.info?.(message) } catch { /* ignore */ } }
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
  try { mkdirSync(MEDIA_DIR, { recursive: true }) } catch { /* ignore */ }
  loadConfig()

  try {
    const registerPrompt = (sc) => {
      sc.effect(() => {
        try {
          return sc.systemPrompt.context({
            name: 'xmfu-nai:inline-display',
            order: 205,
            text: () =>
              '当 xmfu_nai_image / xmfu_nai_img2img / xmfu_nai_infill 成功返回图片，并给出「对话内直接显示」的 Markdown 图片链接（形如 ![生成图](http://127.0.0.1:.../api/xmfu-nai/file?path=...)）时，把这些链接原样放进回复里，让图片直接内嵌显示。\n' +
              '【XMFU 锅巴守卫】用户原则是尽量不花钱。XMFU 公共 API 没有实时报价接口，工具会给出「估算消耗约 N 锅巴」和一次性确认码。必须先把那段提示原样展示给用户，等用户本人明确回复确认码后，才允许带 paid_code 重试一次。不要自行猜测确认码，不要绕开守卫。',
          })
        } catch { return () => {} }
      })
    }
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], registerPrompt)
    else if (ctx.systemPrompt) registerPrompt(ctx)
  } catch { /* ignore */ }

  try {
    ctx.tools.register(defineTool({
      name: 'xmfu_nai_image',
      description:
        '用 XMFU 公共 API 生成图片（NovelAI / GPT Image）。会先给出锅巴估算，默认拦下需要付费的请求并要求本人确认码。生成后图片保存到本机 media/xmfu-nai 并返回绝对路径与可内嵌链接。quote=true 只估算不提交任务。',
      parameters: {
        prompt: { type: 'string', required: true, description: '正面提示词。NovelAI 建议英文 tag，逗号分隔。' },
        negative: { type: 'string', description: '负面提示词；留空用设置页默认值。' },
        provider: { type: 'string', description: 'novelai | gpt-image；留空用设置页默认。' },
        model: { type: 'string', description: '模型 ID，例如 nai-diffusion-4-5-full / gpt-image-2.5；留空用设置页默认。' },
        width: { type: 'number', description: '宽 64–1600（NovelAI 取 64 倍数），留空用设置页默认。' },
        height: { type: 'number', description: '高 64–1600（NovelAI 取 64 倍数），留空用设置页默认。' },
        steps: { type: 'number', description: '采样步数 1–50，留空用默认 23。' },
        scale: { type: 'number', description: 'CFG，常用 3–7。' },
        seed: { type: 'number', description: '种子；留空随机。' },
        count: { type: 'number', description: '张数 1–4，默认 1。每次提交独立任务，张数越多消耗越多锅巴。' },
        background: { type: 'string', description: 'GPT Image 专用：transparent | opaque | auto。' },
        name: { type: 'string', description: '文件名前缀。' },
        quote: { type: 'boolean', description: 'true = 只估算锅巴，不提交任务。' },
        paid_code: { type: 'string', description: '锅巴付费确认码。仅当用户明确同意并把码发给助手后填写。绝不要猜测。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          if (v.ok === false) return errorOutput(v, '生成失败')
          if (v.quote) {
            return [{ type: 'text', text: v.member
              ? `✓ 会员通道，不扣锅巴 · ${v.provider || ''} · ${v.model || ''} · ${v.count} 张`
              : `✓ 估算 ${v.units} 锅巴（无实时报价接口，以站点结算为准） · ${v.provider || ''} · ${v.model || ''} · ${v.count} 张` }]
          }
          return outputPaths(v)
        },
      },
      async execute(args) {
        try { return await runGenerate(args || {}) }
        catch (error) { return { ok: false, message: String((error && error.message) || error) } }
      },
    }))
    log('工具 xmfu_nai_image 已挂上')
  } catch (error) { log('注册 xmfu_nai_image 失败：' + String((error && error.message) || error)) }

  try {
    ctx.tools.register(defineTool({
      name: 'xmfu_nai_img2img',
      description: 'XMFU 参考图编辑：给本地图片绝对路径或 data URL，加目标提示词生成新图。走公共 API /v1/images/edits（GPT Image），会先估算锅巴并走确认码守卫。',
      parameters: {
        image: { type: 'string', required: true, description: '本地图片绝对路径或 data URL。' },
        prompt: { type: 'string', required: true, description: '目标提示词。' },
        model: { type: 'string', description: 'gpt-image-2.5 等；留空默认。' },
        width: { type: 'number' }, height: { type: 'number' },
        background: { type: 'string', description: 'transparent | opaque | auto。' },
        name: { type: 'string' }, paid_code: { type: 'string' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          return v.ok === false ? errorOutput(v, '图生图失败') : outputPaths(v)
        },
      },
      async execute(args) {
        try { return await runEdit(args || {}, 'img2img') }
        catch (error) { return { ok: false, message: String((error && error.message) || error) } }
      },
    }))
    log('工具 xmfu_nai_img2img 已挂上')
  } catch (error) { log('注册 xmfu_nai_img2img 失败：' + String((error && error.message) || error)) }

  try {
    ctx.tools.register(defineTool({
      name: 'xmfu_nai_infill',
      description: 'XMFU 局部重绘。公共 API 不支持遮罩字段，本工具把底图作为参考图交给 /v1/images/edits，用提示词描述要改的区域；需要精确遮罩请用 XMFU 网页版。会先估算锅巴并走确认码守卫。',
      parameters: {
        image: { type: 'string', required: true, description: '底图本地路径或 data URL。' },
        mask: { type: 'string', description: '遮罩路径（公共 API 不上传，仅记录用途）。' },
        prompt: { type: 'string', required: true, description: '描述要改的区域和结果。' },
        model: { type: 'string' },
        width: { type: 'number' }, height: { type: 'number' },
        name: { type: 'string' }, paid_code: { type: 'string' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          return v.ok === false ? errorOutput(v, '局部重绘失败') : outputPaths(v)
        },
      },
      async execute(args) {
        try { return await runEdit(args || {}, 'infill') }
        catch (error) { return { ok: false, message: String((error && error.message) || error) } }
      },
    }))
    log('工具 xmfu_nai_infill 已挂上')
  } catch (error) { log('注册 xmfu_nai_infill 失败：' + String((error && error.message) || error)) }

  try {
    ctx.tools.register(defineTool({
      name: 'xmfu_nai_status',
      description: '查看 XMFU 公共 API 通道状态：API Key 是否有效、可用模型、默认参数、最近一次生成。锅巴余额需去网页端看。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } },
        render(_args, value) {
          const v = value && typeof value === 'object' ? value : {}
          if (v.ok === false) return errorOutput(v, '状态读取失败')
          const lines = [`API：${v.api || ''}`, `凭据：${v.hasKey ? `有（${v.keySource} / ${v.envName}）` : '无 Key'}${v.keyValid === true ? ' · 有效' : v.keyValid === false ? ' · 无效' : ''}`]
          if (v.modelCount !== undefined) lines.push('模型数：' + v.modelCount)
          if (v.keyError) lines.push('凭据错误：' + v.keyError)
          if (v.creditsNote) lines.push('余额：' + v.creditsNote)
          if (Array.isArray(v.providers)) {
            const summary = v.providers.map((p) => `${p.id || p.name || '?'} (${(p.models || []).length})`).join(', ')
            lines.push('模型能力：' + (summary || '无'))
          }
          if (v.lastGeneration) lines.push(`最近一次：${v.lastGeneration.at} · ${(v.lastGeneration.paths || []).length} 张 · 估算 ${v.lastGeneration.estimatedUnits || 0} 锅巴`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        try { return await runStatus() }
        catch (error) { return { ok: false, message: String((error && error.message) || error) } }
      },
    }))
    log('工具 xmfu_nai_status 已挂上')
  } catch (error) { log('注册 xmfu_nai_status 失败：' + String((error && error.message) || error)) }

  const registerRoutes = (webCtx) => {
    const connection = webCtx.get ? webCtx.get('connection') : null
    try {
      webCtx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const send = (status, payload, type = 'application/json; charset=utf-8') => {
            res.statusCode = status
            res.setHeader('content-type', type)
            res.setHeader('cache-control', 'no-store')
            res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
          }
          try {
            const rejection = connection && typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : undefined
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.setHeader('content-type', 'text/plain')
              return res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            }
          } catch { /* ignore */ }

          let route = '/'
          let search = new URLSearchParams()
          try {
            const parsed = new URL(req.url || '/', 'http://127.0.0.1')
            route = parsed.pathname.slice(API_PREFIX.length) || '/'
            search = parsed.searchParams
          } catch { /* ignore */ }

          try {
            bridge.lastSeen = new Date().toISOString()
            bridge.count += 1
            if (req.headers && req.headers.host) bridge.lastHost = String(req.headers.host)

            if (req.method !== 'GET' && req.method !== 'HEAD' && String((req.headers && req.headers['x-xmfu-client']) || '') !== '1') {
              return send(403, { ok: false, error: '需要同源客户端请求（缺少 x-xmfu-client 头）' })
            }

            if (route === '/state' && req.method === 'GET') {
              const cred = await credentials()
              return send(200, {
                ok: true,
                version: PKG_VERSION,
                config: publicConfig(),
                keySource: cred.source,
                envName: cred.envName,
                mediaDir: MEDIA_DIR,
                bridge,
                models: { novelai: NOVELAI_MODELS, gpt: GPT_MODELS, samplers: SAMPLERS, schedules: SCHEDULES },
              })
            }

            if (route === '/config' && req.method === 'POST') {
              const body = await readBody(req)
              return send(200, { ok: true, config: applyConfig(body, { clearApiKey: body.clearApiKey === true }) })
            }

            if (route === '/status' && req.method === 'GET') {
              return send(200, await runStatus())
            }

            if (route === '/models' && req.method === 'GET') {
              const cred = await credentials()
              return send(200, await listModels(cred.token))
            }

            if (route === '/quote' && req.method === 'POST') {
              const body = await readBody(req)
              try { return send(200, await runGenerate({ ...body, quote: true })) }
              catch (error) { return send(200, { ok: false, message: String((error && error.message) || error) }) }
            }

            if ((route === '/generate' || route === '/test') && req.method === 'POST') {
              const body = await readBody(req)
              try { return send(200, await runGenerate(body)) }
              catch (error) { return send(200, { ok: false, message: String((error && error.message) || error) }) }
            }

            if (route === '/file' && req.method === 'GET') {
              const rawPath = String(search.get('path') || '')
              if (!rawPath) return send(400, 'missing path', 'text/plain')
              const target = pathResolve(rawPath)
              const allowedRoot = pathResolve(MEDIA_DIR) + sep
              if (target !== pathResolve(MEDIA_DIR) && !target.startsWith(allowedRoot)) {
                return send(403, 'forbidden', 'text/plain')
              }
              if (!existsSync(target) || !statSync(target).isFile()) return send(404, 'not found', 'text/plain')
              try { return sendFile(res, target) } catch (error) { return send(500, String((error && error.message) || error), 'text/plain') }
            }

            return send(404, { ok: false, error: '未知路由：' + route })
          } catch (error) {
            return send(200, { ok: false, message: String((error && error.message) || error) })
          }
        },
      })
      log(`同源 API ${API_PREFIX} 已挂上；图片目录 ${MEDIA_DIR}`)
    } catch (error) {
      log('同源 API 挂载失败：' + String((error && error.message) || error))
    }
  }

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerRoutes)
  else if (ctx.webServer) registerRoutes(ctx)

  log(`插件就绪 v${PKG_VERSION} · API ${apiOrigin()}/v1`)
}

export default { name, inject, apply }
