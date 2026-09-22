import { fetchJson, fetchText } from './http.mjs';
import { parseFeed } from './xml.mjs';

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);

const gnews = (query, locale) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;

const hnTop = async (windowHours) => {
  const since = Math.floor(hoursAgo(windowHours).getTime() / 1000);
  const url =
    'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=150&numericFilters=' +
    encodeURIComponent(`created_at_i>${since},points>40`);
  const data = await fetchJson(url);
  return (data.hits || [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      published: h.created_at_i ? new Date(h.created_at_i * 1000).toISOString() : null,
      summary: h.story_text || '',
      points: h.points || 0,
      comments: h.num_comments || 0,
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
};

export const SECTION_LABELS = {
  model: '🚀 模型与产品发布',
  research: '🔬 研究前沿',
  industry: '🏢 公司与行业动向',
  eng: '🛠 工程与开源工具',
  ideas: '💭 观点与深度',
  other: '📎 其他值得看',
};

export const FEEDS = [
  { id: 'hn', name: 'Hacker News', section: 'eng', weight: 9, cap: 8, aiFilter: true, kind: 'items', source: hnTop },
  { id: 'openai', name: 'OpenAI', section: 'model', weight: 10, cap: 4, source: () => fetchText('https://openai.com/news/rss.xml') },
  { id: 'deepmind', name: 'Google DeepMind', section: 'model', weight: 10, cap: 4, source: () => fetchText('https://deepmind.google/blog/rss.xml') },
  { id: 'hf', name: 'Hugging Face', section: 'model', weight: 8, cap: 5, source: () => fetchText('https://huggingface.co/blog/feed.xml') },
  { id: 'arxiv-ai', name: 'arXiv cs.AI', section: 'research', weight: 5, cap: 6, source: () => fetchText('https://rss.arxiv.org/rss/cs.AI') },
  { id: 'arxiv-lg', name: 'arXiv cs.LG', section: 'research', weight: 5, cap: 6, source: () => fetchText('https://rss.arxiv.org/rss/cs.LG') },
  { id: 'arxiv-cl', name: 'arXiv cs.CL', section: 'research', weight: 5, cap: 6, source: () => fetchText('https://rss.arxiv.org/rss/cs.CL') },
  { id: 'techcrunch', name: 'TechCrunch AI', section: 'industry', weight: 7, cap: 6, source: () => fetchText('https://techcrunch.com/category/artificial-intelligence/feed/') },
  { id: 'ars', name: 'Ars Technica AI', section: 'industry', weight: 7, cap: 5, source: () => fetchText('https://arstechnica.com/ai/feed/') },
  { id: 'mittr', name: 'MIT Tech Review', section: 'ideas', weight: 7, cap: 4, aiFilter: true, source: () => fetchText('https://www.technologyreview.com/feed/') },
  { id: 'simonw', name: 'Simon Willison', section: 'eng', weight: 8, cap: 4, source: () => fetchText('https://simonwillison.net/atom/everything/') },
  { id: 'gnews-en', name: 'Google News', section: 'industry', weight: 6, cap: 6, source: () => fetchText(gnews('artificial intelligence OR LLM OR OpenAI OR Anthropic when:1d', { hl: 'en-US', gl: 'US', ceid: 'US:en' })) },
  { id: 'gnews-zh', name: 'Google 新闻中文', section: 'industry', weight: 6, cap: 5, source: () => fetchText(gnews('人工智能 OR 大模型 OR ChatGPT when:1d', { hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' })) },
];

const AI_HINT =
  /\b(ai|a\.i\.|llm|gpt|claude|gemini|llama|mistral|deepseek|qwen|openai|anthropic|deepmind|hugging ?face|transformer|diffusion|agent|rag|fine-?tun|prompt|inference|machine learning|deep learning|neural|multimodal|reasoning|chatbot|copilot|人工智能|大模型|智能体|算力|推理|训练|多模态)\b/i;

const extraFeeds = () =>
  (process.env.EXTRA_FEED_URLS || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url, i) => ({
      id: `custom-${i + 1}`,
      name: url.replace(/^https?:\/\//, '').split('/')[0],
      section: 'other',
      weight: 8,
      cap: 6,
      source: () => fetchText(url),
    }));

export const collectAll = async ({ windowHours }) => {
  const cutoff = hoursAgo(windowHours).getTime() - 3600_000;

  const run = async (feed) => {
    const t = Date.now();
    try {
      const raw = await feed.source(windowHours);
      const items = (feed.kind === 'items' ? raw : parseFeed(raw))
        .filter((it) => it.title && it.url)
        .filter((it) => !feed.aiFilter || AI_HINT.test(`${it.title} ${it.summary || ''}`))
        .filter((it) => !it.published || new Date(it.published).getTime() >= cutoff)
        .slice(0, feed.cap)
        .map((it) => ({ ...it, feed }));
      return { feed, items, ms: Date.now() - t, error: null };
    } catch (e) {
      return { feed, items: [], ms: Date.now() - t, error: String(e?.message || e) };
    }
  };

  return Promise.all([...FEEDS, ...extraFeeds()].map(run));
};
