# dsh-xmfu-nai

在 DeepSeek Harness（DSH）里用 `pst-xmfu-` API Key 直接调用 **XMFU 公共出图 API**。能力对齐 `dsh-rinko-nai`：原生工具 + 设置页 + 本地图片保存 + 同源内联图片链接。

## 能力

- `xmfu_nai_image`：文生图（NovelAI / GPT Image），`quote=true` 只估算锅巴不提交任务。
- `xmfu_nai_img2img`：参考图编辑，走 `/v1/images/edits`，输入本地图片路径或 data URL。
- `xmfu_nai_infill`：局部重绘。公共 API 不支持遮罩字段，本工具把底图作为参考图上传，用提示词描述要改的区域；要精确遮罩请用 XMFU 网页版。
- `xmfu_nai_status`：Key 有效性、模型数、默认参数、最近一次生成。锅巴余额公共 API 查不到，去网页端看。
- 默认模型 `nai-diffusion-4-5-full`，**非会员 20 锅巴/张**；设置页勾上「我是会员」后不扣锅巴、跳过确认码守卫。
- 锅巴守卫：公共 API **没有报价接口**，所以非会员每次生成前用本地估算表给出「预计约 N 锅巴」和一次性确认码（6 位，5 分钟有效，只能用一次）。只有用户本人回复确认码后，模型才允许带 `paid_code` 重试。
- 图片落到本机 `~/.dsh/media/xmfu-nai/`，并通过同源路由 `/api/xmfu-nai/file?path=...` 在会话里直接显示。

## API 依据

前端站点：`https://www.xmfu.cc/app#studio`
默认线路：`https://api.xmfu.cn`

站点 API 密钥页面里两套接入格式共用同一把 `pst-xmfu-` Key。本插件用**公共 /v1 任务接口**（实测可用）：

```text
GET  /v1/models                    可用模型（同时用来验证 Key）
GET  /api/v1/capabilities          站点模型能力表（只读）
POST /v1/images/generations        文生图 → 202 + taskId + pollUrl
POST /v1/images/edits              GPT Image 参考图编辑 → 同上
GET  /v1/tasks/{taskId}            轮询；succeeded 时 data[0].b64_json
```

请求示例：

```http
POST /v1/images/generations
Authorization: Bearer pst-xmfu-...
Content-Type: application/json
Idempotency-Key: <uuid>

{
  "model": "nai-diffusion-4-5-full",
  "prompt": "1girl, cherry blossoms",
  "size": "832x1216",
  "n": 1,
  "response_format": "b64_json",
  "novelai": {
    "negative_prompt": "lowres, bad anatomy, blurry",
    "steps": 23,
    "scale": 7
  }
}
```

注意事项：

- `n` 目前只支持 1；要出多张必须分别提交任务、各自不同的幂等键（插件已按 `count` 循环处理）。
- `response_format` 只能填 `b64_json`；结果在轮询完成后的 `data[0].b64_json`，解码即 PNG。
- 不要再调用网页版会话接口 `/api/v1/generations`，API Key 会返回 `INVALID_SESSION`。旧版插件就是错在这里。
- `api.xmfu.cc` 曾返回 `503 SERVICE_MAINTENANCE`，默认走 `.cn`。

## 安装

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File install-xmfu-nai.ps1
```

脚本会：

1. 复制插件到 `<DSH_HOME>\plugins\dsh-xmfu-nai`
2. 在 `profiles\desktop\package.json` 和 `profiles\web\package.json` 写入 `dependencies["dsh-xmfu-nai"] = "link:../../plugins/dsh-xmfu-nai"`
3. 把 `dsh-xmfu-nai` 加进两个 profile 的 `dsh.profile.bundles`
4. 给两个 profile 建 `node_modules\dsh-xmfu-nai` junction
5. 做 `node --check` 语法校验

安装后完全退出并重启 DSH。

## 配置 API Key

先去 XMFU Studio 创建 Key：

- 打开 `https://www.xmfu.cc/app#studio`
- 进 API 密钥页面
- 创建 Key，形如 `pst-xmfu-...`

插件读取优先级：

1. 环境变量 `XMFU_API_KEY`
2. `<DSH_HOME>/.credentials.yaml` 的 `refs.XMFU_API_KEY`
3. 设置页里保存的 `apiKey`

推荐写法：

```yaml
version: 1
refs:
  XMFU_API_KEY: pst-xmfu-xxxxxxxxxxxxxxxx
records: {}
```

也可以在 设置 → XMFU NAI 里直接粘贴 Key，保存在 `<DSH_HOME>/xmfu-nai/config.json`。

## 设置页

设置 → XMFU NAI：

- API Key / 环境变量名 / API 线路（只填域名，不带 `/v1`）
- Provider（novelai / gpt-image）/ Model
- 宽、高、步数、CFG、采样器、噪声调度
- 高级开关：把采样器/噪声调度发给上游（默认关，用接口默认值最稳）
- 默认负面词 / 提示词前缀 / 张数 / 种子
- 锅巴守卫开关
- 检查连接 / 拉取模型表 / 只估算锅巴 / 测试出图（带确认码输入框）

默认参数 `832×1216 / 23 步 / nai-diffusion-4-5-full`，非会员 20 锅巴/张。**开会员就在设置页勾上「我是会员」**，出图不扣锅巴、不走确认码。放大尺寸、提高步数对 v4.5 full 仍按 20 锅巴/张估算。

## 对话里怎么用

```text
画一张 1girl, silver hair, fox ears, purple kimono, soft light

用 xmfu 估算一下：1girl, solo, white hair, blue eyes

把 D:\pics\base.png 图生图，改成赛博朋克夜景，保留人物构图
```

如果要花钱，工具会返回：

```text
⛔ 本次 XMFU 出图会消耗锅巴，按用户要求先拦下，没有提交任何任务。
估算消耗：约 8 锅巴...
确认付费请回复确认码 123456
```

用户本人回复 `123456` 后，助手才能带 `paid_code` 再跑一次。设置页「测试出图」同理：先点一次拿到确认码，填进「锅巴确认码」再点一次。

## 文件

```text
dsh-xmfu-nai/
  lib/index.js              宿主侧：工具、公共 API、估算守卫、任务轮询、base64 解码
  lib/client.js             浏览器侧：设置页
  cordis.patch.yml          bundle 补丁
  package.json
  install-xmfu-nai.ps1      Windows 安装脚本
  scripts/smoke.mjs         模块导入烟雾测试
  scripts/e2e.mjs           端到端验证（会真实消耗少量锅巴）
```

## 校验

```bash
npm run check
npm run smoke
node scripts/e2e.mjs
```

## 备注

公共 API 返回的是 Base64 PNG，插件直接解码写到本地 `~/.dsh/media/xmfu-nai/`，不依赖云端 72 小时过期。
