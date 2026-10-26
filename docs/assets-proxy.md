# 私有资源代理与额度闸门

`assets.hellokar.org` 不再直连 R2，而是经过一个 Worker。Bucket 保持私有，
Worker 在每次真正读 R2 之前向一个全局 Durable Object 记账。

```
浏览器
  ├── words.hellokar.org  → Cloudflare Pages（静态站点 + 词库 JSON）
  └── assets.hellokar.org → Worker
                              ├── 边缘缓存命中 → 直接返回（不记账、不读 R2）
                              └── 未命中 → UsageLimiter 记 1 笔
                                             ├── 超预算 → 429
                                             └── 有余额 → R2 GetObject
```

## 为什么只记「R2 读」

免费计划下 Workers 和 Durable Object 超额是**硬报错**，不会产生账单；
真正会扣钱的只有 R2 的三项：存储、Class A（写）、Class B（读）。

缓存命中不花钱，所以也不记账。这个口径让计数器直接对齐 Class B 账单。
代价：计数器数字小于真实访问量——它衡量的是"花了多少钱"，不是"来了多少人"。

**由此带来一个行为**：预算耗尽后，已缓存的对象仍然正常返回，只有缓存未命中的
请求才收到 429。这是刻意的——已经付过钱的字节没必要再拦一次。

## 请求预算

`MONTHLY_REQUEST_LIMIT` 默认 1,000,000，按 **UTC 自然月** 滚动。
每次真正读 R2（含 404 的探测）记 1 笔。达到上限后返回 429，
带 `Retry-After` 指向下个月 1 日 00:00 UTC。

并发安全：所有请求打到同一个 DO 实例（`idFromName("global")`），
读-改-写在 `storage.transaction()` 里完成，不存在两个请求同时读到 999,999 的情况。
实测 20 并发、余额 9 时，正好放行 9 个。

## 环境变量

| 名称 | 默认 | 说明 |
|---|---|---|
| `MONTHLY_REQUEST_LIMIT` | `1000000` | 每月 R2 读取预算 |
| `ALLOWED_ORIGIN` | `https://words.hellokar.org` | 唯一允许的 CORS 来源 |
| `FAIL_CLOSED` | `true` | 计数器不可达时拒绝服务。设 `false` 会放行未计费读取，仅用于排查 |
| `ADMIN_TOKEN` | 无 | 用量查询接口的 Bearer 令牌。**未设置时接口返回 404** |

## 接口

| 路径 | 方法 | 说明 |
|---|---|---|
| `/<key>` | GET / HEAD | 取资源。其余方法一律 405 |
| `/__usage` | GET | 需 `Authorization: Bearer $ADMIN_TOKEN`；令牌错或未配置都返回 404，不暴露接口存在 |

```bash
curl -s https://assets.hellokar.org/__usage -H "Authorization: Bearer $ADMIN_TOKEN"
# {"period":"2026-10","count":1240,"limit":1000000,"remaining":998760,"allowed":true}
```

## 防护

- 只放行 `GET` / `HEAD`，没有上传、修改、删除入口。
- 路径先解码一次再校验；`..`、反斜杠、空字节、`//`、非 `[A-Za-z0-9._\-/]` 字符
  一律拒绝，而不是"清洗"后放行。
- 双重编码（`%252e%252e`）解码一次后变成 `%2e%2e`，会被字符集检查拦下。
- `Content-Type` 优先取 R2 元数据，缺失时按扩展名兜底，绝不落到 `octet-stream`。
- 响应带 `X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: cross-origin`。
- 不向客户端泄露任何 token。

## 部署

```bash
bash scripts/deploy-worker.sh          # 打印将要做的事
bash scripts/deploy-worker.sh --yes    # 执行
```

脚本顺序固定：先摘掉 R2 自定义域（否则 Worker 抢不到主机名），再部署 Worker。
中间有几秒 `assets.hellokar.org` 不服务。

## 回滚

```bash
# 1. 把主机名还给 bucket
npx wrangler r2 bucket domain add word-atlas-assets \
  --domain assets.hellokar.org --zone-id 6956652c0556d2c810b637822a42080b

# 2. 删掉 Worker 的路由（或整个 Worker）
npx wrangler delete --config worker/wrangler.jsonc
```

bucket 内容不受影响，回滚只改主机名归属。

## 免费额度对照（2026-10 官方文档）

| 项目 | 免费额度 | 当前占用 |
|---|---|---|
| Workers 请求 | 100,000 / 天 | 每次资源请求 1 次 |
| DO 请求 | 计入 Workers 请求 | 每次 R2 读 1 次 |
| DO 行写入 | 100,000 / 天 | 每次 R2 读 1 行 |
| DO SQL 存储 | 5 GB | 一个计数器，几 KB |
| R2 存储 | 10 GB-month | 0.63 GB |
| R2 Class A | 1,000,000 / 月 | 37,553（一次性上传） |
| R2 Class B | 10,000,000 / 月 | 受本闸门约束 |

**计数器管不到的费用**：R2 存储（按 GB-month，词库变大就涨）、
R2 Class A（每次 `assets:sync` 上传产生）、DO 自身的存储与行读写、
Workers CPU 时间。Cloudflare 也没有"花到 X 就停"的硬开关，
只有账单通知——真正的兜底是免费计划的硬配额。

## 入口 IP 被限速时的处理

zone 分到的 anycast IP 在某些网络下会被限速甚至不可达：实测同一张 10 KB 缩略图，
经 zone 的 IP 有 50%–60% 连接超时，经 Cloudflare 自家的 IP 段 4/4 通过、TLS 0.25 秒。
一个首页要取 26 张图，于是表现成「很多图片看不到」。

这不是 Worker 能修的——请求在到达 Worker 之前就断了。Worker 自报的
`Server-Timing: quota;dur=47, r2;dur=151` 说明内部只花 200 毫秒左右。

两条绕开的路子：

1. **资源换入口**（当前采用）：构建时把 `VITE_ASSET_BASE` 指向
   `https://word-atlas-assets-proxy.oneyearmd.workers.dev`。这是同一个 Worker，
   计数与防护完全一致，只是走 Cloudflare 自己的 IP 段。
2. **站点换解析**：把 `words` 改成 **DNS only** 的 CNAME 指向
   `word-atlas-c4o.pages.dev`，让浏览器解析到同一组健康 IP。
   Pages 的自定义域按 Host 头路由，证书仍然有效（已验证 `CN=words.hellokar.org`）。

代价是这两个主机名不再经过 zone 的代理，zone 级 WAF / 缓存规则失效；
Cloudflare 边缘自身的缓存与防护仍在。
