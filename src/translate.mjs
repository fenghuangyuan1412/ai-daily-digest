import { fetchJson } from './http.mjs';

const ENDPOINT = 'https://api.mymemory.translated.net/get';
// MyMemory 匿名档硬限：QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS
// （按字符数计，不是字节），留出余量分片
const MAX_CHUNK_CHARS = 400;
const CONCURRENCY = 3;
const THROTTLE_MS = 250;
const REQUEST_TIMEOUT_MS = 12_000;
const BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS || 150_000);

const EMAIL = process.env.MYMEMORY_EMAIL || '';

// 中文/日文/韩文原文不翻译
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

// 机译会把产品名硬翻成中文（"Claude Opus 5.5" → "克劳德作品5.5"），先挖成占位符再还原
const PRODUCT_NAMES =
  /\b(anthropic|openai|deepmind|chatgpt|copilot|notebooklm|claude\s+(?:opus|sonnet|haiku)|gemini|deepseek|llama(?:\.\d+)?|mistral|qwen|grok|gemma|phi-\d|nano\s+banana|stable\s+diffusion|midjourney|sora|hugging\s+face|gpt[-\s]?\d+(?:[-.\d]+)?[a-z]?)\b/gi;

// 实测（2026-09-23）：纯字母数字占位符能原样穿过 MyMemory，含标点的则会被插空格拆散
const TOKEN = (i) => `Zz${i}zZ`;
const TOKEN_RE = /Zz\s*(\d+)\s*zZ/gi;

const maskNames = (text) => {
  const names = [];
  const masked = text.replace(PRODUCT_NAMES, (m) => {
    names.push(m);
    return TOKEN(names.length - 1);
  });
  return { masked, names };
};

const unmaskNames = (text, names) => {
  const seen = new Set();
  const restored = text.replace(TOKEN_RE, (whole, i) => {
    const idx = Number(i);
    if (!names[idx]) return whole;
    seen.add(idx);
    return names[idx];
  });
  // 有占位符被引擎吞掉或改写 = 译文缺词，宁可回落到英文
  if (names.some((_, i) => !seen.has(i))) return null;
  return restored;
};

// MyMemory 会在中英文之间、全角标点内侧插空格
const tidy = (text) =>
  text
    .replace(/\s+([，。、；：？！）」』】])/g, '$1')
    .replace(/([（「『【])\s+/g, '$1')
    .replace(/\s+([-–—])\s+/g, '$1')
    .replace(/([^\x00-\x7f])\s+(?=[^\x00-\x7f])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

const cache = new Map();
const stats = { attempted: 0, ok: 0, failed: 0, skipped: 0, truncated: false };
let deadline = Infinity;

const chars = (s) => [...s].length;

// 单句也可能超长（摘要里一整段没有句号），所以句切之后还要按词硬切
const hardSplit = (text) => {
  if (chars(text) <= MAX_CHUNK_CHARS) return [text];
  const words = text.split(/(?<=\s)/);
  const pieces = [];
  let cur = '';
  for (const word of words) {
    if (cur && chars(cur + word) > MAX_CHUNK_CHARS) {
      pieces.push(cur.trim());
      cur = word;
    } else {
      cur += word;
    }
  }
  if (cur.trim()) pieces.push(cur.trim());
  return pieces;
};

const splitChunks = (text) => {
  if (chars(text) <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [text];
  const chunks = [];
  let cur = '';
  for (const sentence of sentences) {
    if (cur && chars(cur + sentence) > MAX_CHUNK_CHARS) {
      chunks.push(cur.trim());
      cur = sentence;
    } else {
      cur += sentence;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.flatMap(hardSplit);
};

const requestOnce = async (text) => {
  const params = new URLSearchParams({ q: text, langpair: 'en|zh-CN', dt: 1 });
  if (EMAIL) params.set('de', EMAIL);
  const res = await fetchJson(`${ENDPOINT}?${params}`, {
    timeout: REQUEST_TIMEOUT_MS,
    retries: 0,
  });
  const translated = res?.responseData?.translatedText;
  if (Number(res?.responseStatus) !== 200 || typeof translated !== 'string') {
    throw new Error(`status ${res?.responseStatus}`);
  }
  if (!translated.trim()) throw new Error('empty');
  return translated;
};

const translateOne = async (text) => {
  const chunks = splitChunks(text);
  const out = [];
  for (const chunk of chunks) {
    out.push(await requestOnce(chunk));
  }
  return out.join(' ');
};

const translateQuietly = async (text) => {
  const { masked, names } = maskNames(text);
  let zh = await translateOne(masked);
  if (names.length) {
    const restored = unmaskNames(zh, names);
    if (!restored) throw new Error('name tokens lost');
    zh = restored;
  }
  zh = tidy(zh);
  // 原样回传 = 引擎没翻，占配额不出活
  const echo = zh.toLowerCase() === text.toLowerCase() || zh.toLowerCase() === masked.toLowerCase();
  if (!zh || echo) throw new Error('echo');
  return zh;
};

/**
 * 单条翻译。失败返回 null（调用方回落英文），不抛异常。
 */
export const translate = async (text) => {
  const src = String(text || '').trim();
  if (!src) return '';
  if (CJK.test(src)) {
    stats.skipped += 1;
    return null;
  }
  if (cache.has(src)) return cache.get(src);
  if (Date.now() > deadline) {
    stats.truncated = true;
    return null;
  }
  stats.attempted += 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sleep();
    try {
      const zh = await translateQuietly(src);
      cache.set(src, zh);
      stats.ok += 1;
      return zh;
    } catch {
      stats.failed += 1;
    }
  }
  cache.set(src, null);
  return null;
};

let lastAt = 0;
const sleep = async () => {
  const wait = lastAt + THROTTLE_MS / CONCURRENCY - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
};

/**
 * 并发批量翻译，返回与入参等长的译文数组（失败位为 null）。
 */
export const translateMany = async (texts) => {
  deadline = Date.now() + BUDGET_MS;
  const input = texts.map((t) => String(t || '').trim());
  const results = new Array(input.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < input.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await translate(input[i]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
};

export const translateStats = () => ({ ...stats });
