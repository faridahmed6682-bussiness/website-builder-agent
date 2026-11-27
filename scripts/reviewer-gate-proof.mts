// Step 8 (P1) proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/reviewer-gate-proof.mts
// Proves the conditional reviewer (apiOrchestrator.ts):
//  1. Unit: shouldRunReviewerPass runs ONLY when (a) verification failed
//     and was fixed, (b) the diff is large (>= 50,000 chars written or
//     >= 5 files mutated), or (c) it is the first build of the session.
//     A small clean follow-up build skips it. Boundaries checked.
//  2. Unit: writtenCharsForToolCall counts new content per write-tool
//     arg shape; sessionHasPriorBuild reads projects/<session>/index.html.
//  3. End-to-end (stubbed OpenRouter provider, fake key, local 127.0.0.1
//     file serving for verify_live_preview):
//     A. small clean build, session already has a build -> reviewer
//        SKIPPED (0 reviewer calls, "Reviewer skipped" action logged).
//     B. verification failed then fixed, session already has a build ->
//        reviewer RUNS (exactly 1 reviewer call).
//     C. large diff (55k chars), session already has a build -> reviewer
//        RUNS (exactly 1 reviewer call).
//     D. small clean build, FIRST build of session -> reviewer RUNS
//        (exactly 1 reviewer call).
// Cleanup: restores the tracked projects/index.html, manifest.webmanifest
// and sw.js that deployHtmlFile overwrites, removes the proof session
// dirs/chats, and restores data/lessons.md.
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEKEYONE';
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;
delete process.env.GEMINI_API_KEY; // no studio fallback
process.env.FREE_LLM_API_ROUTING = 'off'; // routeTurnModel -> configured model

const {
  shouldRunReviewerPass,
  writtenCharsForToolCall,
  sessionHasPriorBuild,
  REVIEWER_LARGE_DIFF_CHARS,
  REVIEWER_LARGE_DIFF_FILES,
} = await import('../server/agent/apiOrchestrator.ts');

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// 1. Gate decision (pure function) ------------------------------------------
console.log('shouldRunReviewerPass:');
ok(`thresholds are 50000 chars / 5 files (got ${REVIEWER_LARGE_DIFF_CHARS} / ${REVIEWER_LARGE_DIFF_FILES})`, () => {
  assert.equal(REVIEWER_LARGE_DIFF_CHARS, 50000);
  assert.equal(REVIEWER_LARGE_DIFF_FILES, 5);
});
const clean = { verificationFailedAndFixed: false, mutatedFileCount: 1, mutatedChars: 600, isFirstBuildOfSession: false };
ok('small clean follow-up build -> skip', () => {
  const d = shouldRunReviewerPass(clean);
  assert.equal(d.run, false);
  assert.deepEqual(d.reasons, []);
});
ok('verification failed and was fixed -> run', () => {
  const d = shouldRunReviewerPass({ ...clean, verificationFailedAndFixed: true });
  assert.equal(d.run, true);
  assert.ok(d.reasons.join(' ').includes('verification failed'));
});
ok('large diff by chars (50000) -> run; 49999 -> skip', () => {
  assert.equal(shouldRunReviewerPass({ ...clean, mutatedChars: 50000 }).run, true);
  assert.equal(shouldRunReviewerPass({ ...clean, mutatedChars: 49999 }).run, false);
});
ok('large diff by files (5) -> run; 4 -> skip', () => {
  assert.equal(shouldRunReviewerPass({ ...clean, mutatedFileCount: 5 }).run, true);
  assert.equal(shouldRunReviewerPass({ ...clean, mutatedFileCount: 4 }).run, false);
});
ok('first build of session -> run', () => {
  const d = shouldRunReviewerPass({ ...clean, isFirstBuildOfSession: true });
  assert.equal(d.run, true);
  assert.ok(d.reasons.join(' ').includes('first build'));
});
ok('multiple reasons are all reported', () => {
  const d = shouldRunReviewerPass({ verificationFailedAndFixed: true, mutatedFileCount: 6, mutatedChars: 60000, isFirstBuildOfSession: true });
  assert.equal(d.run, true);
  assert.equal(d.reasons.length, 4);
});

// 2. Written-chars extraction -------------------------------------------------
console.log('writtenCharsForToolCall:');
ok('write_to_file counts CodeContent; content fallback works', () => {
  assert.equal(writtenCharsForToolCall('write_to_file', { CodeContent: 'abc' }), 3);
  assert.equal(writtenCharsForToolCall('fileWrite', { content: 'abcdef' }), 6);
});
ok('replace_file_content counts ReplacementContent; newText fallback works', () => {
  assert.equal(writtenCharsForToolCall('replace_file_content', { ReplacementContent: 'hello' }), 5);
  assert.equal(writtenCharsForToolCall('fileEdit', { newText: 'hi' }), 2);
});
ok('multi_replace sums ReplacementChunks', () => {
  assert.equal(writtenCharsForToolCall('multi_replace_file_content', {
    ReplacementChunks: [{ ReplacementContent: 'aaa' }, { ReplacementContent: 'bb' }, { TargetContent: 'x' }],
  }), 5);
});
ok('non-write tools and missing args count 0', () => {
  assert.equal(writtenCharsForToolCall('view_file', { AbsolutePath: '/x' }), 0);
  assert.equal(writtenCharsForToolCall('write_to_file', null), 0);
  assert.equal(writtenCharsForToolCall('write_to_file', {}), 0);
});

// 3. sessionHasPriorBuild ------------------------------------------------------
console.log('sessionHasPriorBuild:');
const tmpSession = 'step8-proof-tmp';
const tmpDir = path.resolve(process.cwd(), 'projects', tmpSession);
await fs.rm(tmpDir, { recursive: true, force: true });
ok('missing session dir -> false', async () => {
  assert.equal(await sessionHasPriorBuild(tmpSession), false);
});
await fs.mkdir(tmpDir, { recursive: true });
ok('dir without index.html -> false', async () => {
  assert.equal(await sessionHasPriorBuild(tmpSession), false);
});
await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>', 'utf-8');
ok('dir with index.html -> true', async () => {
  assert.equal(await sessionHasPriorBuild(tmpSession), true);
});
await fs.rm(tmpDir, { recursive: true, force: true });

// 4. End-to-end through handleOrchestratedChat ---------------------------------
console.log('end-to-end (stubbed OpenRouter, fake key):');

const SMALL_HTML =
  '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Tiny proof page</title></head>\n' +
  '<body>\n<h1>Hello from the proof</h1>\n<p>' + 'Small clean build. '.repeat(20) + '</p>\n</body>\n</html>';
const BROKEN_HTML =
  '<!DOCTYPE html><html><head><title>Broken</title></head><body><h1>Oops</h1>' +
  '<script>const broken = ;</script></body></html>';
const BIG_HTML =
  '<!DOCTYPE html><html><head><title>Big</title></head><body><h1>Big page</h1><p>' +
  'x'.repeat(55000) + '</p></body></html>';
console.log(`  SMALL_HTML=${SMALL_HTML.length} chars, BIG_HTML=${BIG_HTML.length} chars (threshold ${REVIEWER_LARGE_DIFF_CHARS})`);
assert.ok(SMALL_HTML.length < 5000, 'small fixture must stay small');
assert.ok(BIG_HTML.length > REVIEWER_LARGE_DIFF_CHARS, 'big fixture must clear the threshold');

const sseText = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: [DONE]\n\n`;
const sseToolCall = (id: string, name: string, args: any): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: [DONE]\n\n`;

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// One scripted model per scenario: streaming calls are consumed in order;
// the non-streaming (stream === false) call is the reviewer pass. Turns run
// sequentially, so a single shared queue per turn is enough.
function makeFetchStub(queue: string[], reviewerCalls: { n: number }) {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url === 'https://openrouter.ai/api/v1/models') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.stream === false) {
        reviewerCalls.n++;
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'APPROVED' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (body.stream === true) {
        const next = queue.shift();
        if (next !== undefined) return sseResponse(next);
        return sseResponse(sseText('Done.'));
      }
      // Planner sub-call (no stream flag): canned plan text.
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Stub plan: build the page, then verify.' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('http://127.0.0.1:')) {
      // verify_live_preview's local fetch: serve workspace files from disk.
      const pathname = new URL(url).pathname;
      if (pathname.startsWith('/projects/')) {
        const file = await fs.readFile(path.resolve(process.cwd(), `.${pathname}`), 'utf-8').catch(() => null);
        if (file === null) return new Response('not found', { status: 404 });
        return new Response(file, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      return new Response('', { status: 200 }); // /icon.svg etc: served by the dev server
    }
    throw new Error('Unexpected fetch: ' + url);
  }) as any;
}

const { handleOrchestratedChat } = await import('../server/agent/apiOrchestrator.ts');

const fakeKey = {
  id: 'fake-openrouter-1',
  provider: 'openrouter',
  name: 'Fake OpenRouter',
  apiKey: 'sk-fake-key-for-proof-only',
  model: 'fake/test-model-free',
  isActive: true,
  rpmLimit: 60,
} as any;

function runTurn(sessionId: string, text: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const timer = setTimeout(() => reject(new Error(`turn "${text}" timed out after 120s`)), 120_000);
    const res: any = {
      setHeader() {},
      on() {},
      once() {},
      write(chunk: string) {
        for (const line of String(chunk).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* heartbeat */ }
        }
      },
      end() { clearTimeout(timer); resolve(events); },
    };
    handleOrchestratedChat(
      { messages: [{ role: 'user', parts: [{ text }] }], userKeys: [fakeKey], sessionId },
      res,
    ).catch((err: any) => { clearTimeout(timer); reject(err); });
  });
}

const writeCall = (sessionId: string, html: string) =>
  sseToolCall(`call-write-${sessionId}`, 'write_to_file', {
    TargetFile: `projects/${sessionId}/index.html`,
    CodeContent: html,
    Description: 'Proof page write',
  });
const planCall = (sessionId: string) =>
  sseToolCall(`call-plan-${sessionId}`, 'read_skill', { SkillName: 'list' });

// Snapshot the tracked files deployHtmlFile overwrites (global projects/).
const tracked = ['projects/index.html', 'projects/manifest.webmanifest', 'projects/sw.js'];
const snapshots = new Map<string, string | null>();
for (const f of tracked) {
  snapshots.set(f, await fs.readFile(path.resolve(process.cwd(), f), 'utf-8').catch(() => null));
}
const lessonsBefore = await fs.readFile(path.resolve(process.cwd(), 'data/lessons.md'), 'utf-8').catch(() => null);

const realFetch = globalThis.fetch;
try {
  // --- Case A: small clean build, session already has a build -> SKIP ------
  const sessionA = 'step8-proof-skip';
  await fs.mkdir(path.resolve(process.cwd(), 'projects', sessionA), { recursive: true });
  await fs.writeFile(
    path.resolve(process.cwd(), 'projects', sessionA, 'index.html'),
    '<!DOCTYPE html><html><head><title>Prior</title></head><body><h1>Prior build</h1></body></html>',
    'utf-8',
  );
  const reviewerA = { n: 0 };
  globalThis.fetch = makeFetchStub([
    planCall(sessionA),
    writeCall(sessionA, SMALL_HTML),
    sseText('Done — tiny page built.'),
  ], reviewerA);
  const eventsA = await runTurn(sessionA, 'build a tiny landing page');
  ok('A: small clean follow-up build -> reviewer skipped (0 reviewer calls)', () => {
    assert.equal(reviewerA.n, 0, `expected 0 reviewer calls, got ${reviewerA.n}`);
    assert.ok(eventsA.find((e) => e.type === 'done'), 'expected a done event');
    assert.ok(
      eventsA.some((e) => e.type === 'action' && typeof e.action === 'string' && e.action.includes('Reviewer skipped')),
      'expected a "Reviewer skipped" action event',
    );
  });

  // --- Case B: verification failed then fixed -> RUN -----------------------
  const sessionB = 'step8-proof-fixed';
  await fs.mkdir(path.resolve(process.cwd(), 'projects', sessionB), { recursive: true });
  await fs.writeFile(
    path.resolve(process.cwd(), 'projects', sessionB, 'index.html'),
    '<!DOCTYPE html><html><head><title>Prior</title></head><body><h1>Prior build</h1></body></html>',
    'utf-8',
  );
  const reviewerB = { n: 0 };
  globalThis.fetch = makeFetchStub([
    planCall(sessionB),
    writeCall(sessionB, BROKEN_HTML),
    sseText('Built it.'),
    writeCall(sessionB, SMALL_HTML),
    sseText('Fixed the script error.'),
  ], reviewerB);
  const eventsB = await runTurn(sessionB, 'build a tiny landing page');
  ok('B: verification failed then fixed -> reviewer runs (exactly 1 reviewer call)', () => {
    assert.equal(reviewerB.n, 1, `expected 1 reviewer call, got ${reviewerB.n}`);
    assert.ok(eventsB.find((e) => e.type === 'done'), 'expected a done event');
    assert.ok(
      eventsB.some((e) => e.type === 'action' && typeof e.action === 'string' && e.action.includes('Verification failed')),
      'expected a verification-failed repair action event',
    );
  });

  // --- Case C: large diff (55k chars) -> RUN ------------------------------
  const sessionC = 'step8-proof-large';
  await fs.mkdir(path.resolve(process.cwd(), 'projects', sessionC), { recursive: true });
  await fs.writeFile(
    path.resolve(process.cwd(), 'projects', sessionC, 'index.html'),
    '<!DOCTYPE html><html><head><title>Prior</title></head><body><h1>Prior build</h1></body></html>',
    'utf-8',
  );
  const reviewerC = { n: 0 };
  globalThis.fetch = makeFetchStub([
    planCall(sessionC),
    writeCall(sessionC, BIG_HTML),
    sseText('Done — big page built.'),
  ], reviewerC);
  const eventsC = await runTurn(sessionC, 'build a very long landing page');
  ok('C: large diff (55k chars) -> reviewer runs (exactly 1 reviewer call)', () => {
    assert.equal(reviewerC.n, 1, `expected 1 reviewer call, got ${reviewerC.n}`);
    assert.ok(eventsC.find((e) => e.type === 'done'), 'expected a done event');
  });

  // --- Case D: first build of session -> RUN -------------------------------
  const sessionD = 'step8-proof-first';
  await fs.rm(path.resolve(process.cwd(), 'projects', sessionD), { recursive: true, force: true });
  const reviewerD = { n: 0 };
  globalThis.fetch = makeFetchStub([
    planCall(sessionD),
    writeCall(sessionD, SMALL_HTML),
    sseText('Done — tiny page built.'),
  ], reviewerD);
  const eventsD = await runTurn(sessionD, 'build a tiny landing page');
  ok('D: first build of session -> reviewer runs (exactly 1 reviewer call)', () => {
    assert.equal(reviewerD.n, 1, `expected 1 reviewer call, got ${reviewerD.n}`);
    assert.ok(eventsD.find((e) => e.type === 'done'), 'expected a done event');
  });
} finally {
  globalThis.fetch = realFetch;
  // Restore tracked files deployHtmlFile overwrote; remove proof artifacts.
  for (const [f, content] of snapshots) {
    if (content !== null) await fs.writeFile(path.resolve(process.cwd(), f), content, 'utf-8').catch(() => {});
  }
  for (const s of ['step8-proof-skip', 'step8-proof-fixed', 'step8-proof-large', 'step8-proof-first', 'step8-proof-tmp']) {
    await fs.rm(path.resolve(process.cwd(), 'projects', s), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.resolve(process.cwd(), 'data', 'chats', `${s}.json`), { force: true }).catch(() => {});
  }
  if (lessonsBefore !== null) {
    await fs.writeFile(path.resolve(process.cwd(), 'data/lessons.md'), lessonsBefore, 'utf-8').catch(() => {});
  }
}

console.log(`\nREVIEWER-GATE PROOF (STEP 8): ${passed} checks passed, 0 failed.`);
