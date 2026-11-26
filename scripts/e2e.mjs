// 端到端验证：走插件自己的工具注册 / 锅巴守卫 / 公共 API 出图。
// 会真实消耗少量锅巴。用法：node scripts/e2e.mjs
import mod from '../lib/index.js'
import { existsSync, statSync } from 'node:fs'

const tools = []
const ctx = {
  inject: () => {},
  logger: { info: () => {} },
  tools: { register: (t) => tools.push(t) },
}
mod.apply(ctx)

const imageTool = tools.find((t) => t && t.name === 'xmfu_nai_image')
if (!imageTool) throw new Error('xmfu_nai_image 工具没注册上')
if (typeof imageTool.execute !== 'function') throw new Error('xmfu_nai_image 没有 execute')

const args = {
  prompt: '1girl, cherry blossoms, soft light',
  width: 512,
  height: 768,
  steps: 8,
  scale: 7,
  count: 1,
  name: 'e2e',
}

console.log('--- 1) 只估算 ---')
const quoted = await imageTool.execute({ ...args, quote: true })
console.log(JSON.stringify(quoted).slice(0, 500))

console.log('\n--- 2) 守卫应拦下 ---')
const blocked = await imageTool.execute({ ...args })
console.log(JSON.stringify(blocked).slice(0, 600))
if (blocked.ok !== false || !String(blocked.message).includes('确认码')) {
  throw new Error('锅巴守卫没有按预期拦下')
}

const match = String(blocked.message).match(/确认码\s*(\d{6})/)
if (!match) throw new Error('没从守卫消息里拿到确认码')
const code = match[1]
console.log('拿到确认码：' + code)

console.log('\n--- 3) 带确认码真实出图 ---')
const t0 = Date.now()
const result = await imageTool.execute({ ...args, paid_code: code })
console.log('耗时 ' + Math.round((Date.now() - t0) / 1000) + 's')
console.log(JSON.stringify(result).slice(0, 1000))

if (result.ok !== true || !Array.isArray(result.paths) || result.paths.length === 0) {
  throw new Error('出图失败：' + JSON.stringify(result).slice(0, 600))
}
for (const p of result.paths) {
  if (!existsSync(p) || statSync(p).size < 1000) throw new Error('图片文件无效：' + p)
}
console.log('\nE2E OK：' + result.paths.join(', '))
