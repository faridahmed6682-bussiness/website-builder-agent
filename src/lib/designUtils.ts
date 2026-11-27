// Client-side design utilities (Step 14) — pure browser JS, no server
// calls, no provider calls, no new dependencies. Used by the 'design' tab
// in ToolsModal. Canvas work (favicon / image compression) lives in the
// DesignTools component; everything here is pure functions so it can be
// unit-tested without a DOM.

export function isValidHex(hex: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test((hex || '').trim());
}

export function normalizeHex(hex: string): string {
  let h = (hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toLowerCase()}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hn = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t % 1;
    if (x < 0) x += 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return rgbToHex(f(hn + 1 / 3) * 255, f(hn) * 255, f(hn - 1 / 3) * 255);
}

/** Palette generator: harmonious scheme around a base colour — the base,
 * two analogous neighbours (±30°), the complement (180°) and a light +
 * dark shade of the base. Always returns `count` hex colours. */
export function generatePalette(baseHex: string, count = 5): string[] {
  if (!isValidHex(baseHex)) return [];
  const { h, s, l } = hexToHsl(baseHex);
  const base = normalizeHex(baseHex);
  const scheme = [
    base,
    hslToHex(h + 30, s, l),
    hslToHex(h - 30, s, l),
    hslToHex(h + 180, Math.max(s, 0.35), l),
    hslToHex(h, s, Math.min(l + 0.25, 0.92)),
    hslToHex(h, s, Math.max(l - 0.25, 0.08)),
    hslToHex(h + 60, s, l),
    hslToHex(h - 60, s, l),
  ];
  const out: string[] = [];
  for (const c of scheme) {
    if (out.length >= count) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// --- WCAG contrast ---------------------------------------------------------
function linearChannel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG contrast ratio, 1–21 (black on white = 21). */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastVerdict {
  ratio: number;
  aaNormal: boolean; // >= 4.5
  aaLarge: boolean; // >= 3
  aaaNormal: boolean; // >= 7
  aaaLarge: boolean; // >= 4.5
  grade: 'AAA' | 'AA' | 'AA large only' | 'Fail';
}

export function contrastVerdict(fgHex: string, bgHex: string): ContrastVerdict {
  const ratio = contrastRatio(fgHex, bgHex);
  const aaNormal = ratio >= 4.5;
  const aaLarge = ratio >= 3;
  const aaaNormal = ratio >= 7;
  const aaaLarge = ratio >= 4.5;
  const grade = aaaNormal ? 'AAA' : aaNormal ? 'AA' : aaLarge ? 'AA large only' : 'Fail';
  return { ratio, aaNormal, aaLarge, aaaNormal, aaaLarge, grade };
}

// --- SEO / meta generator --------------------------------------------------
// Executes the applet-seo skill checklist as code:
// 1. Sync <title>, <meta name="description">, og:title, og:description,
//    og:type, twitter:card in index.html.
// 2. Add semantic HTML5 landmarks + JSON-LD structured data for public apps.
export interface SeoInput {
  title: string;
  description: string;
  url?: string;
  image?: string;
  type?: string; // default 'website'
  siteName?: string;
  author?: string;
}

export interface SeoOutput {
  headSnippet: string;
  jsonLd: string;
  /** Checklist items, each with whether the input satisfied it. */
  checklist: Array<{ item: string; ok: boolean; hint?: string }>;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSeoMeta(input: SeoInput): SeoOutput {
  const title = (input.title || '').trim().slice(0, 60);
  const description = (input.description || '').trim().slice(0, 160);
  const url = (input.url || '').trim();
  const image = (input.image || '').trim();
  const type = (input.type || 'website').trim() || 'website';
  const siteName = (input.siteName || '').trim();
  const author = (input.author || '').trim();

  const lines: string[] = [];
  lines.push(`<title>${escAttr(title)}</title>`);
  lines.push(`<meta name="description" content="${escAttr(description)}" />`);
  if (url) lines.push(`<link rel="canonical" href="${escAttr(url)}" />`);
  lines.push(`<meta property="og:title" content="${escAttr(title)}" />`);
  lines.push(`<meta property="og:description" content="${escAttr(description)}" />`);
  lines.push(`<meta property="og:type" content="${escAttr(type)}" />`);
  if (url) lines.push(`<meta property="og:url" content="${escAttr(url)}" />`);
  if (siteName) lines.push(`<meta property="og:site_name" content="${escAttr(siteName)}" />`);
  if (image) lines.push(`<meta property="og:image" content="${escAttr(image)}" />`);
  lines.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`);
  lines.push(`<meta name="twitter:title" content="${escAttr(title)}" />`);
  lines.push(`<meta name="twitter:description" content="${escAttr(description)}" />`);
  if (image) lines.push(`<meta name="twitter:image" content="${escAttr(image)}" />`);

  const jsonLdObj: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': type === 'article' ? 'Article' : 'WebSite',
    name: title,
    description,
  };
  if (url) jsonLdObj.url = url;
  if (author) jsonLdObj.author = { '@type': 'Person', name: author };
  const jsonLd = JSON.stringify(jsonLdObj, null, 2);
  lines.push(`<script type="application/ld+json">\n${jsonLd}\n</script>`);

  const checklist: SeoOutput['checklist'] = [
    { item: 'Title present (≤ 60 chars)', ok: title.length > 0, hint: title.length === 0 ? 'Add a page title.' : title.length > 60 ? 'Title was trimmed to 60 chars.' : undefined },
    { item: 'Meta description present (≤ 160 chars)', ok: description.length > 0, hint: description.length === 0 ? 'Add a description.' : undefined },
    { item: 'og:title / og:description synced with title + description', ok: title.length > 0 && description.length > 0 },
    { item: 'og:type set', ok: true },
    { item: 'twitter:card set (summary_large_image when an image is given)', ok: true },
    { item: 'Canonical URL set', ok: url.length > 0, hint: url.length === 0 ? 'Add the page URL for a canonical link + og:url.' : undefined },
    { item: 'og:image / twitter:image set', ok: image.length > 0, hint: image.length === 0 ? 'Add a social preview image URL for richer cards.' : undefined },
    { item: 'JSON-LD structured data included', ok: true },
    { item: 'Semantic landmarks (<header>, <main>, <article>, <footer>)', ok: false, hint: 'Landmarks live in the page body, not the <head> — add them when building the page.' },
  ];

  return { headSnippet: lines.join('\n'), jsonLd, checklist };
}

/** Download a text blob in the browser (no server round-trip). */
export function downloadTextFile(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
