import mod from '../lib/index.js'

const expected = ['xmfu_nai_image', 'xmfu_nai_img2img', 'xmfu_nai_infill', 'xmfu_nai_status']

if (mod.name !== 'xmfu-nai') throw new Error('bad plugin name: ' + mod.name)
if (typeof mod.apply !== 'function') throw new Error('missing apply()')
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) throw new Error('missing tools injection')

const text = await (await import('node:fs/promises')).readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
for (const tool of expected) {
  if (!text.includes(`name: '${tool}'`)) throw new Error('missing tool registration: ' + tool)
}

console.log('ok: dsh-xmfu-nai module loads; tools declared:', expected.join(', '))
