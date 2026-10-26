# 部署 / Deployment

站点分两个 Cloudflare 产品，边界只有一条：**代码和数据在 Pages，二进制媒体在 R2。**

```
Cloudflare Pages · words.hellokar.org          assets.hellokar.org
├── 网站界面（index.html / _headers / sw.js）   │
├── React 应用（dist/assets/*.js|css|woff2）    └── Worker: word-atlas-assets-proxy
└── 学习功能（FSRS、星图、打字、分享）                 ├── UsageLimiter（Durable Object 记账）
    词库 JSON：/atlas/index.json + entries/          └── Cloudflare R2（私有，无公共入口）
                                                          ├── 单词插画  illustrations/{img,thumb}
                                                          ├── 音频文件  audio/{uk,us,ex,ex2}
                                                          └── 其他静态资源  brand/  sfx/
```

R2 没有自定义域、也没有 `r2.dev` 地址，`assets.hellokar.org` 是唯一入口，
经 Worker 转发并记账。详见 [assets-proxy.md](assets-proxy.md)。

| | Pages | R2 |
|---|---|---|
| 文件数 | 87 | 37,631 |
| 体积 | 7.9 MB | 630 MB |
| 缓存 | 每次部署原子替换 | 一年 immutable |
| 谁在改 | 每次 push | 只在换素材时 |

## 为什么必须拆

Cloudflare Pages **单次部署上限 20,000 个文件**。媒体留在 `public/` 时 `dist/` 是 37,705 个文件，
本地 `npm run build` 能过，`wrangler pages deploy` 一定失败。拆开之后 Pages 只剩 87 个文件，
R2 承担全部媒体，且媒体有独立缓存与独立域名。

## 仓库布局

```
word-atlas/
├── web/                    # → Pages
│   ├── index.html
│   ├── public/             # 站点外壳：favicon / manifest / sw.js / _headers
│   │   └── atlas/          # 词库 JSON（随代码一起发版）
│   └── src/
│       ├── pages/          # 界面：今日 / 图鉴 / 学习 / 练习 / 我的
│       ├── galaxy/         # 词汇星图（WebGL2）
│       ├── store/          # FSRS 记忆调度 + 本地进度
│       ├── ui/             # 卡片、分享、音效触发
│       └── lib/assets.ts   # 唯一决定「这个文件从哪个域取」的地方
├── assets/                 # → R2（不进 Git）
├── data/                   # 词库源数据（CC BY 4.0）
├── scripts/                # 生成、校验、上传
└── wrangler.jsonc          # Pages 项目配置
```

`vite.config.ts` 在仓库根，`root` 指向 `web/`，产物写到 `dist/`。

## 地址是怎么拼出来的

`web/src/lib/assets.ts` 是唯一入口：

```ts
ASSET_BASE = VITE_ASSET_BASE || "https://assets.hellokar.org"
asset("illustrations/img/abandon.webp")  // → https://assets.hellokar.org/illustrations/img/abandon.webp
dataUrl("index.json")                    // → /atlas/index.json（同源，跟代码一起发）
```

改域名只改一个环境变量，不用翻代码。全离线开发时设 `VITE_ASSET_BASE=/assets`，
dev server 会直接把仓库里的 `assets/` 挂在 `/assets/` 下。

## 首次部署顺序

顺序很重要：**先把媒体传上 R2，再切 Pages 域名**，否则用户会看到一堆 404 的插画。

### 1. 建 bucket，不绑公共域名

```bash
npx wrangler r2 bucket create word-atlas-assets
```

**不要把 `assets.hellokar.org` 绑到 bucket 上**，也不要开 `r2.dev` 公共地址——
那样会绕过 Worker 和额度闸门。主机名归 Worker 所有，见 [assets-proxy.md](assets-proxy.md)。

### 2. 跨域由 Worker 负责，不再配 R2 CORS

浏览器只和 Worker 说话，Worker 直接读 bucket 绑定，中间没有跨域问题。
`Access-Control-Allow-Origin` 由 Worker 按 `ALLOWED_ORIGIN` 写入。

这一步仍然重要，因为本项目有两处**必须**要 CORS：

- `web/src/lib/sound.ts` 用 `fetch()` 取 `sfx/*.mp3` 再喂给 Web Audio；
- `web/src/ui/share.ts`、`shareSession.ts` 把插画画进 canvas 再 `toBlob()`，跨域无 CORS 会污染画布。

只是现在由 Worker 统一返回，`scripts/assets/r2-cors.json` 只在回滚成「bucket 直连」
方案时才需要。

```bash
# 仅回滚到 bucket 直连时才需要
npx wrangler r2 bucket cors set word-atlas-assets --file scripts/assets/r2-cors.json
```

文件里已包含 `https://words.hellokar.org` 和 `http://localhost:5188`。

### 3. 上传媒体

```bash
npm run assets:pull                      # 从 Git 历史还原 ~630 MB 到 assets/
node --env-file=.env.local scripts/assets/sync-r2.mjs --dry-run
node --env-file=.env.local scripts/assets/sync-r2.mjs
```

`.env.local` 需要 `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`。
Token 在 R2 → Manage R2 API Tokens 创建，权限选 Object Read & Write。

上传完抽查两个地址：

```bash
curl -sI https://assets.hellokar.org/illustrations/thumb/abandon.webp | head -5
curl -sI https://assets.hellokar.org/audio/uk/abandon.mp3 | head -5
```

### 4. 建 Pages 项目

```bash
npm run build
npx wrangler pages project create word-atlas --production-branch=main
npx wrangler pages deploy dist --project-name=word-atlas
```

然后在 Pages → Custom domains 绑定 `words.hellokar.org`。

之后每次 `git push origin main` 由 `.github/workflows/deploy-pages.yml` 自动部署。
在仓库 Secrets 里配置 `CLOUDFLARE_API_TOKEN`（权限：Cloudflare Pages:Edit）和 `CLOUDFLARE_ACCOUNT_ID`。

## 缓存约定

`web/public/_headers` 在构建时被复制进 `dist/`，由 Pages 生效：

| 路径 | 策略 | 理由 |
|---|---|---|
| `/assets/*` | `max-age=31536000, immutable` | 文件名带内容哈希 |
| `/atlas/*` | `max-age=0, must-revalidate` | 与代码同版本，改词库要立刻可见 |
| `/sw.js` | `no-cache` | 否则旧的 Service Worker 永远不更新 |
| R2 全部对象 | `max-age=31536000, immutable` | 上传脚本统一写入 |

**推论：换插画或换录音必须换文件名。** 现在文件名是 `<word>.webp` / `<word>.mp3`，
换素材要么改词条 id，要么加内容版本前缀（`illustrations/img/abandon.v2.webp`）。
不要原地覆盖同名对象——浏览器和 Service Worker 都不会去取新版本。

## Service Worker

`web/public/sw.js` 分两条策略：

- **媒体**（`illustrations/`、`audio/`、`brand/`、`sfx/`，任意域）：cache-first，最多留 1500 个对象。
- **外壳与词库**（同源）：network-first，离线时回落到缓存。

跨域媒体能被缓存，前提是上面第 2 步的 CORS 配好了；否则只能存 opaque 响应，
`fetch()` 取音频会失败。

## 子路径部署

如果不想用独立域名，仍可部署在子路径：

```bash
ATLAS_BASE=/words/ npm run build
```

此时 `dataUrl()` 会变成 `/words/atlas/...`，而媒体仍然走 `ASSET_BASE` 的绝对地址，
两者互不影响——这正是把地址收进 `lib/assets.ts` 的好处。

## 本地开发

```bash
npm ci
npm run dev          # http://localhost:5188，媒体默认从线上 R2 取
```

想完全离线：`npm run assets:pull` 之后在 `.env.local` 里设 `VITE_ASSET_BASE=/assets`。

## 检查清单

- [ ] `npm run build` 产物 < 20,000 文件（CI 里 `check.yml` 会拦）
- [ ] `npm run check:atlas` 无 error
- [ ] `assets/` 已上传，`sync-r2.mjs` 第二次运行应全部 `skipped`
- [ ] R2 CORS 含 `https://words.hellokar.org`
- [ ] `assets.hellokar.org` 的响应带 `Cache-Control: immutable` 和 `access-control-allow-origin`
- [ ] 分享卡片能导出图片（验证 canvas 未被污染）
