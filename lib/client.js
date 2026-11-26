/**
 * dsh-xmfu-nai —— 浏览器侧设置页
 *
 * 设置 → XMFU NAI：
 *   1. API Key / 凭据来源 / 线路
 *   2. 默认模型、尺寸、步数、CFG、采样器、负面词
 *   3. 报价守卫开关
 *   4. 测试报价 / 测试出图 / 状态
 */

window.__ModuleLoader__.load({
  id: 'dsh-xmfu-nai',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/xmfu-nai'
    var NS = 'dsh-xmfu-nai'

    var ROUTES = [
      ['cn', '默认线路 api.xmfu.cn'],
      ['cc', '备用线路 api.xmfu.cc（维护中可能 503）'],
      ['esa', 'ESA 线路 esaapi.xmfu.cn'],
    ]
    var PROVIDERS = [
      ['novelai', 'NovelAI Diffusion'],
      ['gpt-image', 'GPT Image'],
    ]
    var NOVELAI_MODELS = [
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
    var GPT_MODELS = [
      'gpt-image-2.5',
      'gpt-image-2',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
    ]
    var SAMPLERS = [
      ['k_euler', 'Euler'],
      ['k_euler_ancestral', 'Euler Ancestral'],
      ['k_dpm_2', 'DPM 2'],
      ['k_dpm_2_ancestral', 'DPM 2 Ancestral'],
      ['k_dpmpp_2m', 'DPM++ 2M'],
      ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
      ['k_dpmpp_sde', 'DPM++ SDE'],
      ['ddim', 'DDIM'],
      ['ddim_v3', 'DDIM V3'],
    ]
    var SCHEDULES = [
      ['native', 'Native'],
      ['karras', 'Karras'],
      ['exponential', 'Exponential'],
      ['polyexponential', 'Polyexponential'],
    ]
    var QUALITY = [
      ['standard', 'standard'],
      ['light', 'light'],
      ['none', 'none'],
    ]

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xmfu-client': '1' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }
    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)))
        }
        return data
      })
    }

    function Field(props) {
      return h('label', { className: 'xf-field' },
        h('span', { className: 'xf-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'xf-hint' }, props.hint) : null)
    }

    function Combo(props) {
      var known = (props.options || []).indexOf(props.value) >= 0
      var customState = useState(!known)
      var custom = customState[0]
      var setCustom = customState[1]
      return h('label', { className: 'xf-field' },
        h('span', { className: 'xf-label' }, props.label),
        custom
          ? h('div', { className: 'xf-pair' },
              h('input', {
                className: 'xf-input',
                value: props.value || '',
                onChange: function (e) { props.onChange(e.target.value) },
              }),
              h('button', {
                className: 'xf-btn xf-btn-sm',
                type: 'button',
                onClick: function () { setCustom(false); props.onChange((props.options || [''])[0]) },
              }, '列表'))
          : h('select', {
              className: 'xf-input',
              value: props.value,
              onChange: function (e) {
                if (e.target.value === '__custom__') setCustom(true)
                else props.onChange(e.target.value)
              },
            },
              (props.options || []).map(function (item) {
                var value = Array.isArray(item) ? item[0] : item
                var label = Array.isArray(item) ? item[1] : item
                return h('option', { key: value, value: value }, label)
              }),
              h('option', { key: '__custom__', value: '__custom__' }, '自定义…')),
        props.hint ? h('span', { className: 'xf-hint' }, props.hint) : null)
    }

    function Toast(props) {
      if (!props.toast) return null
      return h('div', {
        className: 'xf-toast ' + (props.toast.kind === 'ok' ? 'xf-toast-ok' : 'xf-toast-err'),
      }, props.toast.text)
    }

    function XmfuSection() {
      var state = useState(null)
      var form = useState(null)
      var toast = useState(null)
      var keyDraft = useState('')
      var status = useState(null)
      var caps = useState(null)
      var prompt = useState('1girl, solo, silver hair, fox ears, looking at viewer, soft light, detailed background')
      var quoteBusy = useState(false)
      var quoteRes = useState(null)
      var genBusy = useState(false)
      var genRes = useState(null)
      var paidCode = useState('')
      var statusBusy = useState(false)

      var showToast = useCallback(function (text, kind) {
        toast[1]({ text: text, kind: kind || 'ok' })
        window.setTimeout(function () { toast[1](null) }, 3600)
      }, [])

      var refresh = useCallback(function () {
        return apiGet('/state').then(function (data) {
          state[1](data)
          var c = data.config || {}
          form[1]({
            enabled: c.enabled !== false,
            route: c.route || 'cn',
            baseUrl: c.baseUrl || 'https://api.xmfu.cn',
            apiKeyEnv: c.apiKeyEnv || 'XMFU_API_KEY',
            provider: c.provider || 'novelai',
            model: c.model || 'nai-diffusion-4-5-full',
            width: c.width || 832,
            height: c.height || 1216,
            steps: c.steps || 23,
            scale: c.scale === undefined ? 7 : c.scale,
            sampler: c.sampler || 'k_euler_ancestral',
            noise_schedule: c.noise_schedule || 'karras',
            includeAdvanced: c.includeAdvanced === true,
            cfg_rescale: c.cfg_rescale === undefined ? 0 : c.cfg_rescale,
            qualityPresetId: c.qualityPresetId || 'standard',
            ucPreset: c.ucPreset === undefined ? 3 : c.ucPreset,
            resolution: c.resolution || '832x1216',
            negativePrompt: c.negativePrompt || '',
            promptSuffix: c.promptSuffix || '',
            seed: c.seed || 0,
            count: c.count || 1,
            quoteGuard: c.quoteGuard !== false,
            member: c.member === true,
            pollMs: c.pollMs || 2000,
            timeoutMs: c.timeoutMs || 600000,
          })
        }).catch(function (e) { showToast('读取状态失败：' + String((e && e.message) || e), 'err') })
      }, [showToast])

      useEffect(function () { refresh() }, [refresh])

      function setField(key, value) {
        form[1](function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      function saveConfig(clearKey) {
        if (!form[0]) return
        var body = {}
        for (var k in form[0]) body[k] = form[0][k]
        if (keyDraft[0]) body.apiKey = keyDraft[0]
        if (clearKey === true) body.clearApiKey = true
        apiPost('/config', body).then(function (data) {
          keyDraft[1]('')
          refresh()
          showToast(clearKey ? 'API Key 已清除' : '配置已保存', 'ok')
        }).catch(function (e) { showToast('保存失败：' + String((e && e.message) || e), 'err') })
      }

      function loadStatus() {
        statusBusy[1](true)
        apiGet('/status').then(function (data) { status[1](data) })
          .catch(function (e) { status[1]({ ok: false, message: String((e && e.message) || e) }) })
          .finally(function () { statusBusy[1](false) })
      }

      function loadModels() {
        apiGet('/models').then(function (data) { caps[1](data) })
          .catch(function (e) { caps[1]({ ok: false, error: String((e && e.message) || e) }) })
      }

      function testQuote() {
        quoteBusy[1](true)
        quoteRes[1](null)
        apiPost('/quote', { prompt: prompt[0], count: form[0] ? form[0].count : 1 }).then(function (data) {
          quoteRes[1](data)
        }).catch(function (e) { quoteRes[1]({ ok: false, message: String((e && e.message) || e) }) })
          .finally(function () { quoteBusy[1](false) })
      }

      function testGenerate() {
        genBusy[1](true)
        genRes[1](null)
        var body = { prompt: prompt[0], name: 'settings-test', count: 1 }
        if (paidCode[0].trim()) body.paid_code = paidCode[0].trim()
        apiPost('/generate', body).then(function (data) {
          genRes[1](data)
          if (data && data.ok) showToast('测试出图完成', 'ok')
          else if (data && data.message && data.message.indexOf('确认码') >= 0) showToast('需要先填确认码再提交', 'err')
        }).catch(function (e) { genRes[1]({ ok: false, message: String((e && e.message) || e) }) })
          .finally(function () { genBusy[1](false) })
      }

      if (!state[0] || !form[0]) {
        return h('div', { className: 'xf-wrap' }, h('p', null, '正在加载 XMFU NAI 设置…'), h(Toast, { toast: toast[0] }))
      }

      var f = form[0]
      var s = state[0]
      var modelOptions = f.provider === 'gpt-image' ? GPT_MODELS : NOVELAI_MODELS
      if (modelOptions.indexOf(f.model) < 0) modelOptions = [f.model].concat(modelOptions)
      var providerModels = caps[0] && caps[0].providers ? caps[0].providers : []

      var statusView = status[0]
      var credits = statusView && statusView.credits ? statusView.credits : null
      var quoteResult = quoteRes[0]
      var genResult = genRes[0]

      return h('div', { className: 'xf-wrap' },
        h(Toast, { toast: toast[0] }),
        h('div', { className: 'xf-head' },
          h('h3', null, 'XMFU NAI'),
          h('span', { className: 'xf-badge' }, 'v' + (s.version || '?'))),
        h('p', { className: 'xf-desc' }, '用 pst-xmfu- API Key 调 XMFU 公共 /v1 出图接口（NovelAI / GPT Image）。默认模型 v4.5 full，一次 20 锅巴。开会员的话勾选下面的会员开关，就不扣锅巴、跳过确认码。锅巴余额去网页端看。'),

        h('div', { className: 'xf-card' },
          h('h4', null, '凭据与线路'),
          h('p', { className: 'xf-note' },
            '当前凭据来源：', s.keySource || '无',
            s.envName ? '（' + s.envName + '）' : '',
            s.config && s.config.hasApiKey ? ' · 设置页 Key：' + s.config.apiKeyMasked : ''),
          h(Field, { label: 'API Key', hint: 'pst-xmfu- 开头。留空表示保留已有值。优先级：环境变量 / .credentials.yaml refs / 此处填写。' },
            h('input', {
              className: 'xf-input',
              type: 'password',
              value: keyDraft[0],
              placeholder: s.config && s.config.hasApiKey ? '已保存 ' + s.config.apiKeyMasked + '，留空不改' : 'pst-xmfu-…',
              onChange: function (e) { keyDraft[1](e.target.value) },
            })),
          h(Field, { label: '凭据环境变量名', hint: 'DSH ~/.credentials.yaml 的 refs 中用这个名字。' },
            h('input', {
              className: 'xf-input',
              value: f.apiKeyEnv,
              onChange: function (e) { setField('apiKeyEnv', e.target.value) },
            })),
          h(Field, { label: 'API 线路' },
            h('select', {
              className: 'xf-input',
              value: f.route,
              onChange: function (e) {
                var route = e.target.value
                setField('route', route)
                if (route === 'cn') setField('baseUrl', 'https://api.xmfu.cn')
                else if (route === 'cc') setField('baseUrl', 'https://api.xmfu.cc')
                else if (route === 'esa') setField('baseUrl', 'https://esaapi.xmfu.cn')
              },
            }, ROUTES.map(function (r) { return h('option', { key: r[0], value: r[0] }, r[1]) }))),
          h(Field, { label: 'API Base URL', hint: '只填域名，不带 /v1 或 /api/v1。插件自动拼 /v1 公共接口。' },
            h('input', {
              className: 'xf-input',
              value: f.baseUrl,
              onChange: function (e) { setField('baseUrl', e.target.value) },
            })),
          h('div', { className: 'xf-actions' },
            h('button', { className: 'xf-btn xf-btn-primary', type: 'button', onClick: function () { saveConfig(false) } }, '保存配置'),
            h('button', { className: 'xf-btn', type: 'button', onClick: function () { saveConfig(true) } }, '清除本机 Key'),
            h('button', { className: 'xf-btn', type: 'button', onClick: loadStatus, disabled: statusBusy[0] }, statusBusy[0] ? '检查中…' : '检查连接'),
            h('button', { className: 'xf-btn', type: 'button', onClick: loadModels }, '拉取模型表')),
          h('p', { className: 'xf-note' },
            h('a', { href: 'https://www.xmfu.cc/app#studio', target: '_blank', rel: 'noreferrer' }, '打开 XMFU Studio'),
            ' → 账号菜单 → API 密钥 → 创建 Key。')),

        h('div', { className: 'xf-card' },
          h('h4', null, '默认出图参数'),
          h(Field, { label: 'Provider' },
            h('select', {
              className: 'xf-input',
              value: f.provider,
              onChange: function (e) { setField('provider', e.target.value) },
            }, PROVIDERS.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) }))),
          h(Combo, { label: '模型', value: f.model, options: modelOptions, onChange: function (v) { setField('model', v) } }),
          h('div', { className: 'xf-grid' },
            h(Field, { label: '宽' }, h('input', { className: 'xf-input', type: 'number', value: f.width, onChange: function (e) { setField('width', e.target.value) } })),
            h(Field, { label: '高' }, h('input', { className: 'xf-input', type: 'number', value: f.height, onChange: function (e) { setField('height', e.target.value) } })),
            h(Field, { label: '步数' }, h('input', { className: 'xf-input', type: 'number', value: f.steps, onChange: function (e) { setField('steps', e.target.value) } })),
            h(Field, { label: 'CFG scale' }, h('input', { className: 'xf-input', type: 'number', step: '0.1', value: f.scale, onChange: function (e) { setField('scale', e.target.value) } })),
            h(Field, { label: '张数上限' }, h('input', { className: 'xf-input', type: 'number', value: f.count, onChange: function (e) { setField('count', e.target.value) } })),
            h(Field, { label: 'Seed（0=随机）' }, h('input', { className: 'xf-input', type: 'number', value: f.seed, onChange: function (e) { setField('seed', e.target.value) } }))),
          h('div', { className: 'xf-grid' },
            h(Field, { label: '采样器' },
              h('select', { className: 'xf-input', value: f.sampler, onChange: function (e) { setField('sampler', e.target.value) } },
                SAMPLERS.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))),
            h(Field, { label: '噪声调度' },
              h('select', { className: 'xf-input', value: f.noise_schedule, onChange: function (e) { setField('noise_schedule', e.target.value) } },
                SCHEDULES.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))),
            h(Field, { label: 'Quality preset' },
              h('select', { className: 'xf-input', value: f.qualityPresetId, onChange: function (e) { setField('qualityPresetId', e.target.value) } },
                QUALITY.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]) }))),
            h(Field, { label: 'UC preset' },
              h('select', { className: 'xf-input', value: f.ucPreset, onChange: function (e) { setField('ucPreset', e.target.value) } },
                h('option', { value: '0' }, 'heavy'), h('option', { value: '1' }, 'light'), h('option', { value: '2' }, 'human'), h('option', { value: '3' }, 'none')))),
          h(Field, { label: '默认负面词' },
            h('textarea', { className: 'xf-input xf-textarea', rows: 3, value: f.negativePrompt, onChange: function (e) { setField('negativePrompt', e.target.value) } })),
          h(Field, { label: '默认提示词前缀', hint: '每次 prompt 前面自动拼这段。' },
            h('input', { className: 'xf-input', value: f.promptSuffix, onChange: function (e) { setField('promptSuffix', e.target.value) } })),
          h('label', { className: 'xf-check' },
            h('input', { type: 'checkbox', checked: f.member === true, onChange: function (e) { setField('member', e.target.checked) } }),
            h('span', null, '我是会员：出图不扣锅巴，跳过确认码守卫（v4.5 full 非会员 20 锅巴/张）')),
          h('label', { className: 'xf-check' },
            h('input', { type: 'checkbox', checked: f.quoteGuard !== false, onChange: function (e) { setField('quoteGuard', e.target.checked) } }),
            h('span', null, '锅巴守卫：非会员出图前估算并拦下，等本人给确认码')),
          h('label', { className: 'xf-check' },
            h('input', { type: 'checkbox', checked: f.includeAdvanced === true, onChange: function (e) { setField('includeAdvanced', e.target.checked) } }),
            h('span', null, '高级：把采样器 / 噪声调度一起发给上游（默认关，用接口默认值最稳）')),
          h('div', { className: 'xf-actions' },
            h('button', { className: 'xf-btn xf-btn-primary', type: 'button', onClick: function () { saveConfig(false) } }, '保存参数'))),

        h('div', { className: 'xf-card' },
          h('h4', null, '状态'),
          statusView ? h('div', { className: 'xf-status' },
            h('p', null, 'API：' + (statusView.api || '')),
            h('p', null, 'Key：' + (statusView.hasKey ? statusView.keySource : '无') + (statusView.keyValid === true ? ' · 有效' : statusView.keyValid === false ? ' · 无效' : '')),
            statusView.modelCount !== undefined ? h('p', null, '模型数：' + statusView.modelCount) : null,
            statusView.creditsNote ? h('p', null, statusView.creditsNote) : null,
            statusView.keyError ? h('p', { className: 'xf-err' }, statusView.keyError) : null,
            providerModels.length > 0 ? h('pre', { className: 'xf-pre' }, JSON.stringify(providerModels, null, 2).slice(0, 3000)) : null
          ) : h('p', { className: 'xf-note' }, '点上面的「检查连接」查看 Key、锅巴和模型表。')),

        h('div', { className: 'xf-card' },
          h('h4', null, '测试'),
          h(Field, { label: '测试提示词' },
            h('textarea', { className: 'xf-input xf-textarea', rows: 3, value: prompt[0], onChange: function (e) { prompt[1](e.target.value) } })),
          h(Field, { label: '锅巴确认码', hint: '点「只估算」或「测试出图」会给出一次性确认码；把它填进这里再点一次「测试出图」。' },
            h('input', {
              className: 'xf-input',
              value: paidCode[0],
              placeholder: '6 位数字，5 分钟内有效',
              onChange: function (e) { paidCode[1](e.target.value) },
            })),
          h('div', { className: 'xf-actions' },
            h('button', { className: 'xf-btn', type: 'button', onClick: testQuote, disabled: quoteBusy[0] }, quoteBusy[0] ? '估算中…' : '只估算锅巴'),
            h('button', { className: 'xf-btn xf-btn-primary', type: 'button', onClick: testGenerate, disabled: genBusy[0] }, genBusy[0] ? '生成中…' : '测试出图')),
          quoteResult ? h('pre', { className: 'xf-pre' }, JSON.stringify(quoteResult, null, 2).slice(0, 3000)) : null,
          genResult ? h('pre', { className: 'xf-pre' }, JSON.stringify(genResult, null, 2).slice(0, 6000)) : null)
      )
    }

    var CSS = [
      '.xf-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 0 20px;color:var(--text,#e8e8e8)}',
      '.xf-head{display:flex;align-items:center;gap:10px}.xf-head h3{margin:0;font-size:18px}',
      '.xf-badge{font-size:11px;border:1px solid var(--border,#444);border-radius:999px;padding:2px 8px;opacity:.75}',
      '.xf-desc,.xf-note{font-size:12px;opacity:.72;line-height:1.6;margin:6px 0}',
      '.xf-card{border:1px solid var(--border,#3a3a3a);border-radius:12px;padding:14px;background:var(--card,#151515)}',
      '.xf-card h4{margin:0 0 10px;font-size:15px}',
      '.xf-field{display:flex;flex-direction:column;gap:5px;margin:8px 0;font-size:12px}',
      '.xf-label{font-weight:600;opacity:.9}.xf-hint{font-size:11px;opacity:.6;line-height:1.5}',
      '.xf-input{width:100%;box-sizing:border-box;border:1px solid var(--border,#444);border-radius:8px;padding:8px 10px;background:var(--input-bg,#202020);color:inherit;font:inherit;font-size:13px}',
      '.xf-textarea{resize:vertical;min-height:64px}',
      '.xf-pair{display:flex;gap:8px}.xf-pair .xf-input{flex:1}',
      '.xf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}',
      '.xf-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
      '.xf-btn{border:1px solid var(--border,#555);border-radius:8px;padding:7px 12px;background:var(--btn-bg,#242424);color:inherit;cursor:pointer;font-size:12px}',
      '.xf-btn:hover{border-color:var(--primary,#6ea8fe)}.xf-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.xf-btn-primary{background:var(--primary,#2f6feb);border-color:var(--primary,#2f6feb);color:#fff}',
      '.xf-btn-sm{padding:5px 9px}',
      '.xf-check{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;cursor:pointer}',
      '.xf-pre{white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;background:var(--code-bg,#111);border-radius:8px;padding:10px;font-size:11px;line-height:1.5}',
      '.xf-err{color:#ff7b7b;font-size:12px;word-break:break-word}',
      '.xf-toast{position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 14px;border-radius:8px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.3)}',
      '.xf-toast-ok{background:#1c7c48;color:#fff}.xf-toast-err{background:#a83232;color:#fff}',
    ].join('')

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-xmfu-nai-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-xmfu-nai: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'xmfu-nai',
          order: 48,
          locale: NS,
          label: function () { return 'XMFU NAI' },
        }, function (props) {
          return h(XmfuSection, props !== null && props !== undefined ? props : {})
        })
      })
    }

    module.exports = {
      name: 'xmfu-nai',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
