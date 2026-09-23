import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectAll, SECTION_LABELS } from './feeds.mjs';
import { stripHtml } from './xml.mjs';
import { translateMany, translateStats } from './translate.mjs';

const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 36);
const TOTAL_CAP = Number(process.env.TOTAL_CAP || 22);
const PER_SECTION_CAP = 6;
const SNIPPET_LEN = 220;
const TRANSLATE = process.env.TRANSLATE !== 'off';

const HOT_TERMS =
  /\b(gpt-|claude|gemini|llama|mistral|deepseek|qwen|grok|phi|gemma|sonnet|opus|nano banana|sora|nano-banana)\b/i;

const SECTION_RULES = [
  ['model', /\b(gpt-|claude|gemini|llama|mistral|deepseek|qwen|grok|gemma|sonnet|opus|luna|sora)\b|版本\s*\d|v\d+\.\d+/i],
  ['research', /\b(paper|arxiv|study|research|benchmark|sota|state-of-the-art|outperform|dataset|abstract)\b|论文|研究/i],
  ['industry', /\b(fund|rais|acquisition|acquire|ipo|revenue|valuation|market|chip|nvidia|amd|intel|tsmc|regulat|lawsuit|antitrust|ban|policy|partnership|deal|layoff|launch|unveil|announc)\b|融资|收购|芯片|监管|政策/i],
  ['eng', /\b(github|open[- ]sourc|tool|library|framework|sdk|cli|plugin|release|deploy|tutorial|skill|repository)\b/i],
  ['model', /\b(introduc|released|launch|announc|now available|preview)\b|发布|推出/i],
  ['ideas', /\b(newsletter|roundup|weekly|opinion|essay|comment|analysis|why |how )|观点|评论/i],
];

const score = (item, ageHours) => {
  const title = item.title;
  let s = item.feed.weight * 3;
  s += Math.max(0, 12 * (1 - ageHours / WINDOW_HOURS));
  if (item.points) s += Math.min(14, Math.log2(item.points + 1) * 2);
  if (item.comments) s += Math.min(4, item.comments / 120);
  if (HOT_TERMS.test(title)) s += 6;
  if (/\b(openai|anthropic|deepmind|meta|Microsoft|google|nvidia|xai|microsoft)\b/i.test(title)) s += 3;
  if (item.feed.id.startsWith('arxiv')) s -= 5;
  if (/\b(weekly|roundup|digest|curated|top \d+|best \d+)\b/i.test(title)) s -= 3;
  return s;
};

const assignSection = (item) => {
  if (item.feed.id.startsWith('arxiv')) return 'research';
  for (const [section, re] of SECTION_RULES) if (re.test(item.title)) return section;
  return item.feed.section;
};

const dedupeNames = (names, self) => [...new Set(names.filter((n) => n && n !== self))];

const titleKey = (t) =>
  stripHtml(t)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    .slice(0, 70);

const domain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const ageLabel = (published) => {
  if (!published) return '';
  const h = (Date.now() - new Date(published).getTime()) / 3600_000;
  if (h < 1) return h < -2 ? '' : '刚刚';
  if (h < 36) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
};

// 部分源用 U+2011 等非 ASCII 连字符（"GPT‑6"），会让产品名漏过保护并被机译插空格
const tidyText = (t) =>
  t
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cleanSummary = (text) =>
  tidyText(
    text
      .replace(/^arxiv:\d{4}\.\d{4,5}v?\d*\s*/i, '')
      .replace(/^announce type:\s*\w+\s*/i, '')
      .replace(/^abstract:\s*/i, '')
      .trim(),
  );

const trim = (text) => {
  const t = text.trim();
  if (t.length <= SNIPPET_LEN) return t;
  return `${t.slice(0, SNIPPET_LEN).replace(/\s+\S*$/, '')}…`;
};

const render = (digest) => {
  const lines = [
    `# 📰 AI 日报 · ${digest.date}`,
    '',
    `> ${digest.itemCount} 条 · ${digest.sourcesOk}/${digest.sourcesTotal} 个源正常 · 覆盖最近 ${digest.windowHours} 小时${digest.translatedCount ? ` · ${digest.translatedCount} 条已译` : ''}`,
    '',
  ];
  for (const section of digest.sections) {
    lines.push(`## ${SECTION_LABELS[section.key]}`, '');
    section.items.forEach((item, i) => {
      const meta = [item.source, ageLabel(item.published), item.points ? `▲${item.points}` : '']
        .filter(Boolean)
        .join(' · ');
      const also = item.alsoOn.length ? ` （亦见于 ${item.alsoOn.join('、')}）` : '';
      const original = item.titleZh && item.titleZh !== item.title ? `${item.title} · ` : '';
      lines.push(`**${i + 1}. ${item.titleZh || item.title}**`, '');
      lines.push(`${original}${meta}${also} · [原文](<${item.url}>)`);
      const summary = item.summaryZh || item.summary;
      if (summary) lines.push('', `_${trim(summary)}_`);
      lines.push('');
    });
  }
  if (digest.sourcesFailed.length) {
    lines.push('---', '', `⚠️ 拉取失败的源：${digest.sourcesFailed.join('、')}`, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
};

// 译文若带出待办清单语法会毁掉笔记正文（见 README「清单模式陷阱」），一律弃用
const safeZh = (text) =>
  text && !/^\s*[-*+]\s*\[[ xX]\]/m.test(text) ? text : null;

// 只译要展示的那一段：整篇 arXiv 摘要又长又没人读
const displayPart = (text) =>
  text.length <= SNIPPET_LEN ? text : text.slice(0, SNIPPET_LEN).replace(/\s+\S*$/, '');

// 只有链接、标题党式空摘要不值得花配额
const worthTranslating = (summary) =>
  summary.length > 12 && !/^(https?:\/\/\S+|\[[^\]]*\]\(\S+\))$/i.test(summary);

const attachTranslations = async (sections) => {
  const items = sections.flatMap((s) => s.items);
  if (!items.length) return;
  const titles = await translateMany(items.map((it) => it.title));
  const sources = items.map((it) =>
    worthTranslating(it.summary) ? displayPart(it.summary) : '',
  );
  const summaries = await translateMany(sources);
  items.forEach((item, i) => {
    item.titleZh = safeZh(titles[i]);
    const zh = safeZh(summaries[i]);
    // 译文来自被截断的前 220 字，补省略号免得读起来像断句
    item.summaryZh = zh && sources[i] !== item.summary ? `${zh}…` : zh || null;
  });
};

const build = async () => {
  const results = await collectAll({ windowHours: WINDOW_HOURS });

  const pool = new Map();
  for (const { items } of results) {
    for (const item of items) {
      const enriched = {
        ...item,
        title: tidyText(stripHtml(item.title)),
        summary: cleanSummary(stripHtml(item.summary || '')),
        source: item.feed.name,
        alsoOn: [],
      };
      enriched.published = enriched.published || new Date().toISOString();
      enriched.score = score(enriched, (Date.now() - new Date(enriched.published)) / 3600_000);
      const key = titleKey(enriched.title) || domain(enriched.url);
      const prev = pool.get(key);
      if (!prev) pool.set(key, enriched);
      else if (enriched.score > prev.score) {
        pool.set(key, {
          ...enriched,
          points: Math.max(enriched.points || 0, prev.points || 0) || undefined,
          comments: Math.max(enriched.comments || 0, prev.comments || 0) || undefined,
          alsoOn: dedupeNames([prev.source, ...prev.alsoOn], enriched.source),
        });
      } else {
        prev.points = Math.max(prev.points || 0, enriched.points || 0) || undefined;
        prev.alsoOn = dedupeNames([...prev.alsoOn, enriched.source], prev.source);
      }
    }
  }

  const ranked = [...pool.values()]
    .map((it) => ({ ...it, section: assignSection(it) }))
    .sort((a, b) => b.score - a.score);

  const buckets = new Map();
  for (const item of ranked) {
    const list = buckets.get(item.section) || [];
    if (list.length >= PER_SECTION_CAP) continue;
    list.push(item);
    buckets.set(item.section, list);
  }

  const order = ['model', 'research', 'industry', 'eng', 'ideas', 'other'];
  let sections = order
    .filter((key) => (buckets.get(key) || []).length)
    .map((key) => ({ key, items: buckets.get(key) }));

  let total = sections.reduce((n, s) => n + s.items.length, 0);
  while (total > TOTAL_CAP) {
    const biggest = sections.reduce((a, b) => (a.items.length >= b.items.length ? a : b));
    biggest.items.pop();
    total -= 1;
  }
  sections = sections.filter((s) => s.items.length);

  if (TRANSLATE) await attachTranslations(sections);

  const ok = results.filter((r) => !r.error);
  const translatedCount = sections
    .flatMap((s) => s.items)
    .filter((it) => it.titleZh).length;
  const digest = {
    date: todayIn(),
    generatedAt: new Date().toISOString(),
    windowHours: WINDOW_HOURS,
    sourcesTotal: results.length,
    sourcesOk: ok.length,
    sourcesFailed: results.filter((r) => r.error).map((r) => r.feed.name),
    itemCount: total,
    translatedCount,
    sections: sections.map((s) => ({
      key: s.key,
      label: SECTION_LABELS[s.key],
      items: s.items.map((it) => ({
        title: it.title,
        titleZh: it.titleZh || '',
        url: it.url,
        source: it.source,
        alsoOn: it.alsoOn,
        summary: it.summary,
        summaryZh: it.summaryZh || '',
        published: it.published,
        points: it.points || 0,
        discussion: it.discussion || '',
      })),
    })),
  };
  digest.markdown = render(digest);
  return { digest, results };
};

const TZ = process.env.DIGEST_TZ || 'Asia/Shanghai';
const todayIn = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const outDir = path.resolve(process.cwd(), process.argv[2] || 'digest');
const { digest, results } = await build();

await mkdir(outDir, { recursive: true });
const files = [
  [`${digest.date}.json`, JSON.stringify(digest, null, 2)],
  [`${digest.date}.md`, digest.markdown],
  ['latest.json', JSON.stringify(digest, null, 2)],
  ['latest.md', digest.markdown],
];
await Promise.all(files.map(([name, body]) => writeFile(path.join(outDir, name), body, 'utf8')));

console.log(`\nAI 日报 ${digest.date} · ${digest.itemCount} 条 · ${digest.sourcesOk}/${digest.sourcesTotal} 源 · 中文标题 ${digest.translatedCount}/${digest.itemCount}\n`);
if (TRANSLATE) console.log('翻译统计:', translateStats(), '\n');
for (const r of results) {
  console.log(
    `${r.error ? '✗' : '✓'} ${r.feed.name.padEnd(20)} ${String(r.items.length).padStart(2)} 条  ${r.ms}ms  ${r.error || ''}`,
  );
}
console.log(`\n已写入 ${outDir}\n`);
