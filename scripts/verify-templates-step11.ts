/**
 * Step 11 verification — runs with NO API key.
 *
 *  1. Static checks (no server needed): every template in
 *     src/lib/templates.ts is a complete standalone HTML document with
 *     inline CSS only (no external script/stylesheet/image, no CDN) and
 *     contains no provider/model reference of any kind.
 *  2. Live flow (needs the dev server on --base, e.g. http://localhost:3456):
 *     for every template, POST its HTML to the existing
 *     POST /api/tools/file-write, then GET the returned previewUrl and the
 *     session manifest.webmanifest + sw.js written by the deployHtmlFile
 *     PWA path. The server is started with no keys, so a passing run is
 *     also proof the flow needs zero provider calls.
 *
 * Usage:
 *   npx tsx scripts/verify-templates-step11.ts [--base http://localhost:3456]
 * Exit 0 = all templates pass, non-zero = failure (lists the failures).
 */
import { STATIC_TEMPLATES, isCompleteHtml } from '../src/lib/templates.ts';

const BANNED = [
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.groq.com',
  'api.openai.com',
  'cdn.tailwindcss.com',
  '<script src=',
  '<link rel="stylesheet"',
  '<img src="http',
  'fetch(',
  'XMLHttpRequest',
];
const MODEL_ID_HINT = /gemini-[0-9]|gpt-[0-9]|claude|llama-[0-9]/i;

let failures: string[] = [];
let checks = 0;
function check(ok: boolean, label: string) {
  checks++;
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

console.log(`Templates: ${STATIC_TEMPLATES.length}`);
check(STATIC_TEMPLATES.length >= 8, `at least 8 templates (have ${STATIC_TEMPLATES.length})`);
const ids = new Set<string>();
for (const t of STATIC_TEMPLATES) {
  check(!ids.has(t.id), `${t.id}: id is unique`);
  ids.add(t.id);
  check(isCompleteHtml(t.html), `${t.id}: complete standalone HTML document`);
  check(t.html.length > 2000, `${t.id}: substantial content (${t.html.length} chars)`);
  for (const needle of BANNED) {
    check(!t.html.includes(needle), `${t.id}: no banned content ${JSON.stringify(needle)}`);
  }
  check(!MODEL_ID_HINT.test(t.html), `${t.id}: no hardcoded model id`);
  check(!t.html.includes('${') && !t.html.includes('`'), `${t.id}: no template-literal hazards`);
}

const base = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : '';

if (base) {
  const clean = base.replace(/\/+$/, '');
  for (const t of STATIC_TEMPLATES) {
    const sessionId = `step11_verify_${t.id}`;
    const res = await fetch(`${clean}/api/tools/file-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: `projects/${sessionId}/index.html`,
        content: t.html,
        sessionId,
      }),
    });
    check(res.ok, `${t.id}: file-write HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as any;
    check(data?.success === true, `${t.id}: file-write success:true`);
    check(typeof data?.previewUrl === 'string' && data.previewUrl.includes(sessionId), `${t.id}: PWA deploy returned session previewUrl`);
    check(typeof data?.deployedHtml === 'string' && data.deployedHtml.includes('serviceWorker.register'), `${t.id}: deployed HTML has PWA service-worker injection`);
    if (typeof data?.previewUrl === 'string') {
      const url = data.previewUrl.startsWith('http') ? data.previewUrl : `${clean}${data.previewUrl}`;
      const page = await fetch(url);
      const text = await page.text();
      check(page.status === 200, `${t.id}: preview GET 200`);
      const title = t.html.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
      check(title !== '' && text.includes(title), `${t.id}: preview serves the template title`);
      const manifest = await fetch(`${clean}/projects/${sessionId}/manifest.webmanifest`);
      check(manifest.ok, `${t.id}: session manifest.webmanifest 200`);
      const sw = await fetch(`${clean}/projects/${sessionId}/sw.js`);
      check(sw.ok && (await sw.text()).includes('CACHE_NAME'), `${t.id}: session sw.js 200`);
    }
  }
} else {
  console.log('Live flow skipped (no --base given).');
}

console.log(`\n${checks - failures.length}/${checks} checks passed.`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('All template checks passed — zero provider calls needed (no key configured).');
