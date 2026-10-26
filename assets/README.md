# assets/ — Cloudflare R2 源目录

这个目录**不进 Git**（见根目录 `.gitignore`）。它是 `https://assets.hellokar.org` 的本地镜像：
`npm run assets:sync` 把这里的文件按原路径上传成 R2 object key。

```
assets/
├── illustrations/
│   ├── img/<word>.webp      单词插画 512px   ~185 MB   7,298 张
│   └── thumb/<word>.webp    单词缩略图 256px ~70 MB    7,298 张
├── audio/
│   ├── uk/<word>.mp3        英音            ~59 MB     7,298 条
│   ├── us/<word>.mp3        美音            ~61 MB     7,298 条
│   ├── ex/<word>.mp3        例句朗读        ~193 MB    7,298 条
│   └── ex2/<word>.mp3       第二例句朗读    ~53 MB     1,011 条
├── brand/                   品牌图、话题封面、分享卡     2.2 MB
└── sfx/                     界面音效与环境声             4.3 MB
```

合计约 **630 MB / 37,631 个文件**。

## 为什么拆出去

Cloudflare Pages 单次部署上限是 **20,000 个文件**。这些媒体留在仓库里时，
`dist/` 有 37,705 个文件——构建能过，部署必然失败。拆开之后：

| | 位置 | 文件数 | 体积 |
|---|---|---:|---:|
| 网站界面、React 应用、学习功能、词库 JSON | Pages `words.hellokar.org` | 87 | 7.9 MB |
| 插画、音频、品牌图、音效 | R2 `assets.hellokar.org` | 37,631 | 630 MB |

## 首次填充

媒体仍在 Git 历史里（拆分那次提交的父提交）：

```bash
npm run assets:pull          # 从历史还原到 assets/，约 630 MB
npm run assets:manifest      # 检查清单与体积
```

## 上传

需要一个 R2 API Token（Object Read & Write），三个环境变量写进 `.env.local`：

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=word-atlas-assets
```

```bash
node --env-file=.env.local scripts/assets/sync-r2.mjs --dry-run   # 先看要传什么
node --env-file=.env.local scripts/assets/sync-r2.mjs             # 增量上传
node --env-file=.env.local scripts/assets/sync-r2.mjs --only audio/uk
```

脚本按 `ContentLength` 比对已有对象，只传新增和变化的文件，可反复执行。
每个对象带 `Cache-Control: public, max-age=31536000, immutable`，
所以**改图必须换文件名**（目前是 `<word>.webp`，换图就换 word 或加版本前缀）。

## 公网访问

R2 bucket 需要绑定自定义域 `assets.hellokar.org`（Cloudflare 控制台 → R2 → Settings → Custom Domains）。
不要用 `r2.dev` 的公共开发域名做生产：它有速率限制，且不适合被大量用户直接访问。

`web/src/lib/assets.ts` 里的默认值就是 `https://assets.hellokar.org`，
所以正常情况下构建时不需要设置任何环境变量。
