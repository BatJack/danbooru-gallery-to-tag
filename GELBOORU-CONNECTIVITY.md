# Gelbooru 连不上的原因排查

排查日期：2026-11-11
分支：`github-pages`（纯静态版）
状态：**根因已确认，暂未修改代码**

## 现象

在应用里把图源切到 Gelbooru 后搜索，界面提示：

```
检索失败
无法连接 gelbooru.com：网络不可达，或被浏览器跨域(CORS)拦截。可在设置中填写 CORS 代理。
```

## 结论

**Gelbooru 的响应不带 CORS 头，被浏览器拦截。** 网络本身是通的，应用代码路径也正常，前端无法绕过这一点，必须通过代理转发。

Gelbooru 对公开 HTML 页面和 DAPI 接口都**不返回** `Access-Control-Allow-Origin`，带上 `Origin: http://127.0.0.1:8000` 请求头也一样。浏览器 `fetch` 因此在读取响应前就报错，统一表现为 `TypeError: Failed to fetch` / `net::ERR_FAILED`。

## 证据

### 1. 浏览器内直连（无头 Edge，加载 `http://127.0.0.1:8000/`）

```json
{
  "direct": {
    "dapi": { "error": "TypeError: Failed to fetch" },
    "list": { "error": "TypeError: Failed to fetch" }
  },
  "appSearch": { "error": "无法连接 gelbooru.com：网络不可达，或被浏览器跨域(CORS)拦截。" },
  "events": ["net::ERR_FAILED", "net::ERR_FAILED", "net::ERR_CONNECTION_CLOSED", "net::ERR_FAILED"]
}
```

`appSearch` 是直接调用应用的 `DG.gallery.searchPosts({ source: "gelbooru", ... })`，说明问题不在 UI 层。

### 2. 同 URL 绕过浏览器（走系统代理 `127.0.0.1:7897`）

| 请求 | 状态 | `Access-Control-Allow-Origin` |
| --- | --- | --- |
| `GET /index.php?page=post&s=list&tags=all&pid=0` | `200 OK`（真实 HTML） | **无** |
| `GET /index.php?page=dapi&s=post&q=index&json=1&limit=1` | `401 Unauthorized`（未带凭据） | **无** |

响应头示例：

```http
HTTP/1.1 200 OK
Server: nginx/1.26.3
Content-Type: text/html; charset=UTF-8
X-Frame-Options: sameorigin
```

没有 `Access-Control-Allow-Origin`，所以浏览器端必然拦截。

### 3. 本机 DNS 被污染（次要因素）

| 解析方式 | `gelbooru.com` 解析结果 |
| --- | --- |
| 本机 DNS | `199.96.59.95` |
| `1.1.1.1` | `31.13.94.49`（Facebook 网段） |
| `8.8.8.8` | `157.240.17.14`（Facebook 网段） |
| AAAA 记录 | `2a03:2880:f10f:83:face:b00c:0:25de`（Facebook 网段） |

`curl` 不走代理直连 `gelbooru.com:443` 会 21 秒超时，只有走系统代理 `127.0.0.1:7897` 才能拿到 200。浏览器使用系统代理，所以这一项在浏览器里被掩盖了；但它会影响命令行排查，也会让「到底是网络问题还是 CORS 问题」变得难以判断。

对照：`danbooru.donmai.us` 直连同样超时（DNS 污染），走代理返回 `403` + Cloudflare 质询（`Cf-Mitigated: challenge`）。

## 代码层面的三个叠加因素

1. **CORS 是硬限制。** `js/gallery-api.js` 直连失败时会尝试 `cors_proxy`，但代理只是转发请求，响应仍然必须带 CORS 头，否则浏览器照样拒绝。所以关键是选一个**会补 CORS 头**的代理。
2. **默认没有配置代理。** `js/store.js:41` 中 `cors_proxy: ""` 为空，因此 `js/gallery-api.js:77-96` 的 `request()` 在直连失败后直接抛出那条错误提示，不会重试。
3. **DAPI 无凭据不可用。** 不带 `user_id` + `api_key` 时 DAPI 返回 `401`；`searchGelbooru()`（`js/gallery-api.js:584-598`）此时会退回抓公开 HTML 列表页，而这条路径同样需要 CORS 代理。

相关代码位置：

- `js/gallery-api.js:77-96` — `request()`：直连 → 失败 → 用 `cors_proxy` 重试 → 仍失败则报错
- `js/gallery-api.js:584-598` — `searchGelbooru()`：有凭据走 DAPI，否则抓公开页面
- `js/gallery-api.js:780-803` — `testProxy()`：设置页的代理连通性测试
- `js/store.js:41-42` — `cors_proxy` / `image_proxy` 默认值

## 公共 CORS 代理实测（2026-11-11，本机）

README 中列出的示例代理在当前网络环境下**全部不可用**：

| 代理模板 | 结果 |
| --- | --- |
| `https://corsproxy.io/?url={url}` | `401 Unauthorized` |
| `https://api.allorigins.win/raw?url={url}` | `522` |
| `https://api.codetabs.com/v1/proxy?quest={url}` | `522` |

注意：这三个是 README 里的示例，不能视为「可用方案」。公共代理普遍限流、需要密钥或随时失效。

## 可选方案

1. **自建转发服务（最稳）**
   起一个本地小服务，转发请求并附加 `Access-Control-Allow-Origin: *`，在设置里填 `http://127.0.0.1:8787/?url={url}`。
   优点：可控、稳定、能同时解决 DNS 污染（可在服务端走代理）。
   缺点：使用时需要额外开一个进程；GitHub Pages 上的纯静态站点无法自带后端。

2. **换成确认可用的公共 CORS 代理**
   填进设置页的「CORS 代理」，用自带的测试按钮验证（`testProxy()` 接受 401/403，只判断代理是否可达且返回了 CORS 头）。

3. **申请 Gelbooru API 凭据**
   填 `user_id` + `api_key` 走 DAPI，返回 JSON 比解析 HTML 稳定；但仍需方案 1 或 2 解决 CORS。

4. **只改文档与提示**
   在 README 和错误提示中明确「Gelbooru 必须配代理，且 README 示例代理可能已失效」，避免用户误判为自己的网络故障。

## 复现步骤

```powershell
python -m http.server 8000
# 打开 http://127.0.0.1:8000
# 图源切到 Gelbooru → 搜索 → 观察提示与 DevTools Console/Network
```

命令行验证「不是网络问题」：

```powershell
curl.exe -sS -x http://127.0.0.1:7897 -D - -o NUL `
  "https://gelbooru.com/index.php?page=post&s=list&tags=all&pid=0" `
  -H "Origin: http://127.0.0.1:8000" -A "Mozilla/5.0" --max-time 30
# 预期：HTTP 200，且响应头中没有 Access-Control-Allow-Origin
```

## 建议的后续动作

- 修复前先确认采用哪种方案（自建服务 / 指定公共代理 / 仅改文档）。
- 若自建服务：新增独立目录（例如 `proxy/`），不引入打包工具，保持 `github-pages` 分支仍是可直接部署的静态输出。
- 更新 README 的代理示例，只保留经过实测可用的地址，或明确标注「示例，可能失效」。
