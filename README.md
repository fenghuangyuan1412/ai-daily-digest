# ai-daily-digest

每天抓取 AI / 科技要闻，生成一份中文日报，投递到 Super Productivity（番茄钟）的收件箱里，作为当天的一条阅读任务。

## 链路

```
GitHub Actions (每天 01:00 UTC = 北京 09:00)
  └─ node src/build.mjs           抓 13 个源 → 去重 → 打分 → 分区 → 渲染
       └─ digest/latest.json      ← 插件读这个
          digest/latest.md        ← 人读的
          digest/YYYY-MM-DD.*     ← 历史留档
          └─ git commit + push

浏览器里的番茄钟
  └─ ai-daily-digest 插件 (plugin/)
       └─ PluginAPI.request 拉 latest.json
          PluginAPI.addTask  →  收件箱一条「📰 AI 日报 · 日期」，正文即日报
```

日报存在**你的浏览器 IndexedDB 里**（番茄钟本身是纯前端应用），所以插件只在应用打开时同步；每天最多投一条，重复打开不会产生第二条。

## 抓取源

| 源 | 分区倾向 | 备注 |
|---|---|---|
| Hacker News (Algolia API) | 按标题判定 | 只需点数 >40 |
| OpenAI / DeepMind / Hugging Face 博客 | 模型与产品 | 官方一手发布 |
| arXiv cs.AI / cs.LG / cs.CL | 研究前沿 | |
| TechCrunch AI / Ars Technica AI | 公司与行业 | |
| MIT Technology Review | 观点与深度 | 需命中 AI 关键词 |
| Simon Willison | 工程与工具 | 含其转引的 X 推文 |
| Google News（英/中各一条查询） | 公司与行业 | |

排序不看时间先后，看分数：源权重 + 新鲜度 + HN 点数 + 是否出现前沿模型名。**不是同一篇新闻在多个源出现只会留一条**，并在来源后标注「亦见于 …」。

想加源（包括推特）：在仓库 Settings → Secrets and variables → Actions → **Variables** 里建 `EXTRA_FEED_URLS`，一行一个 RSS 地址。

> 推特/X 没有免费可靠的读取方式（官方 API 收费，Nitter 基本已死）。要读推特就自备一个 RSS 桥（RSSHub 自建实例、Fusebridge、RSS.app 等），把地址填进 `EXTRA_FEED_URLS` 即可，代码不用动。

## 手动触发

Actions 页面 → 「每日 AI 日报」→ Run workflow，可填回溯小时数（默认 36）。

## 装插件

1. 下载仓库根目录的 `ai-daily-digest-plugin.zip`（改了 `plugin/` 下文件后重新 `npm run plugin:pack`）。
2. 打开番茄钟 → 设置 → 插件 → 选择文件上传 → 启用。
3. 刷新页面，几秒内应弹出「AI 日报已投递到收件箱」。

改日报地址：编辑 `plugin/plugin.js` 顶部的 `DIGEST_URL`，重新打包上传。

## 本地跑

```bash
node src/build.mjs              # 生成日报，产物写到 digest/
node plugin/self-test.mjs       # 用桩 PluginAPI 验证插件：投一条 / 同日不重复 / 断网不炸
```

无需 `npm install`，只用 Node 内置能力（≥20）。注意在中国大陆网络下 `huggingface.co`、`news.google.com` 直连不通，本地跑这三个源会失败并在日报末尾标注，Actions 上不受影响。
