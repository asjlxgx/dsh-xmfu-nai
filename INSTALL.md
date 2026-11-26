# 安装 / 卸载

## 安装

```powershell
cd path\to\dsh-xmfu-nai
powershell -ExecutionPolicy Bypass -File .\install-xmfu-nai.ps1
```

如果自动定位 DSH_HOME 失败：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-xmfu-nai.ps1 -DshHome "C:\Users\you\.dsh"
```

重启 DSH 后打开 设置 → XMFU NAI。

## 手动安装

1. 把项目目录复制到 `<DSH_HOME>\plugins\dsh-xmfu-nai`
2. 编辑 `<DSH_HOME>\profiles\desktop\package.json` 和 `<DSH_HOME>\profiles\web\package.json`：

```json
{
  "dependencies": {
    "dsh-xmfu-nai": "link:../../plugins/dsh-xmfu-nai"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-xmfu-nai"
      ]
    }
  }
}
```

注意保留已有 dependencies / bundles，不是覆盖整个文件。

3. 给两个 profile 建目录链接：

```powershell
New-Item -ItemType Junction -Path "<DSH_HOME>\profiles\desktop\node_modules\dsh-xmfu-nai" -Target "<DSH_HOME>\plugins\dsh-xmfu-nai"
New-Item -ItemType Junction -Path "<DSH_HOME>\profiles\web\node_modules\dsh-xmfu-nai" -Target "<DSH_HOME>\plugins\dsh-xmfu-nai"
```

4. 重启 DSH。

## 卸载

- 删除 `<DSH_HOME>\plugins\dsh-xmfu-nai`
- 从 desktop / web profile 的 `dependencies` 和 `dsh.profile.bundles` 删除 `dsh-xmfu-nai`
- 删除两个 profile 的 `node_modules\dsh-xmfu-nai`
- 图片保存在 `<DSH_HOME>\media\xmfu-nai`，按需保留或删除
