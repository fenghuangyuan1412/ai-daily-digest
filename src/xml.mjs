const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export const decodeEntities = (raw) =>
  String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m,
    );

const safeCodePoint = (n) => {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
};

export const stripHtml = (raw) =>
  decodeEntities(
    String(raw || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const field = (block, ...names) => {
  for (const name of names) {
    const paired = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (paired) return paired[1].trim();
    const selfClosing = block.match(new RegExp(`<${name}\\b[^>]*?/>`, 'i'));
    if (selfClosing) {
      const href = selfClosing[0].match(/\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i);
      if (href) return href[1] || href[2] || '';
    }
  }
  return '';
};

const atomLink = (block) => {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  const pick = (rel) => {
    for (const m of links) {
      const attrs = m[1];
      const relAttr = /\brel\s*=\s*"([^"]*)"|\brel\s*=\s*'([^']*)'/i.exec(attrs);
      const isTargetRel = relAttr ? (relAttr[1] || relAttr[2]) === rel : rel === 'alternate';
      if (!isTargetRel) continue;
      const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(attrs);
      if (href) return href[1] || href[2];
    }
    return '';
  };
  return pick('alternate') || pick('') || field(block, 'link', 'guid', 'id');
};

const toDate = (value) => {
  const text = decodeEntities(value).trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export const parseFeed = (xml) => {
  const blocks = [...String(xml).matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map(
    (m) => m[0],
  );

  return blocks
    .map((block) => {
      const title = stripHtml(field(block, 'title'));
      const link = stripHtml(atomLink(block)) || stripHtml(field(block, 'link', 'guid', 'id'));
      const published =
        toDate(field(block, 'pubDate', 'published', 'updated', 'dc:date', 'date')) ||
        toDate(field(block, 'updated', 'published'));
      const summary = stripHtml(
        field(block, 'description', 'summary', 'content:encoded', 'content', 'media:description'),
      );
      return { title, url: link, published, summary };
    })
    .filter((it) => it.title && it.url && /^https?:\/\//i.test(it.url));
};
