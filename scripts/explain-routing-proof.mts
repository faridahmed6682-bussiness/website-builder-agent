// Step 7 (P1/F4) proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/explain-routing-proof.mts
// Proves:
//  1. classifyIntentLocal: pure explanation questions ("explain X",
//     "what is X", "how does X work") -> 'casual'; anything with a
//     build/change verb or a request about the user's own code/files
//     ("explain how to build a website", "explain this code") -> 'task'.
//  2. classifyTask: a pure explain that ever reaches the loop is 'chat'
//     (cheap chain), never 'reasoning' (Hydrogen, high effort); a
//     build/fix explain is still 'coding'.
//  3. End-to-end (stubbed provider, fake key): an explain turn gets ONE
//     direct cheap-model call (provider calls == 1, model is not Hydrogen,
//     done apiCalls == 1, zero key_active / no agent loop), while a build
//     turn enters the agent loop (key_active events emitted).
import assert from 'node:assert';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEKEYONE';
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;
delete process.env.GEMINI_API_KEY; // no studio fallback in either case

const { classifyIntentLocal } = await import('../server/agent/intentGate.ts');
const { classifyTask, turnReasoningEffort } = await import('../server/agent/llmClient.ts');

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// 1. Local classification ----------------------------------------------------
console.log('classifyIntentLocal:');
const explainCasual = [
  'explain what React is',
  'Explain photosynthesis',
  'what is a database',
  'how does the internet work',
  'Can you explain what an API is?',
  'tell me about black holes',
  'what is the difference between HTTP and HTTPS',
  'describe how rain forms',
  'explain what a function is',
  'ব্যাখ্যা করো, ফটোসিনথেসিস কী',
  'how does a refrigerator work',
];
for (const q of explainCasual) {
  ok(`explain -> casual: "${q}"`, () => {
    assert.equal(classifyIntentLocal(q), 'casual', `expected casual for "${q}"`);
  });
}
const buildTask = [
  'explain how to build a website',
  'explain and fix this code',
  'explain this code',
  'explain my code',
  'build a landing page for a bakery',
  'explain how to deploy my app',
  'what is the best way to create a dashboard',
  'explain how to update the homepage',
  'fix my button',
  'explain how to write a React component',
];
for (const q of buildTask) {
  ok(`build/change/code -> task: "${q}"`, () => {
    assert.equal(classifyIntentLocal(q), 'task', `expected task for "${q}"`);
  });
}

// 2. Loop-side classification (defence in depth) ----------------------------
console.log('classifyTask / turnReasoningEffort:');
ok('pure explain is chat, not reasoning', () => {
  assert.equal(classifyTask('explain photosynthesis'), 'chat');
});
ok('pure explain about a coding noun is coding, never reasoning', () => {
  // codingRe matches "database" first — still the cheap loop, not Hydrogen.
  assert.notEqual(classifyTask('explain what a database is'), 'reasoning');
});
ok('pure explain gets no high reasoning effort', () => {
  assert.equal(turnReasoningEffort('explain what a database is'), undefined);
  assert.equal(turnReasoningEffort('explain photosynthesis'), undefined);
});
ok('explain + fix stays coding', () => {
  assert.equal(classifyTask('explain and fix this code'), 'coding');
});
ok('genuine reasoning ("why ...") is still reasoning', () => {
  assert.equal(classifyTask('why is the sky blue'), 'reasoning');
});

// 3. End-to-end through handleOrchestratedChat ------------------------------
const providerCalls: Array<{ url: string; model?: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-4-hydrogen', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://openrouter.ai/api/v1/models') {
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai/.test(url)) {
    providerCalls.push({ url, model: body?.model });
    // Combined Gemini + OpenAI shape: whichever parser reads it, the
    // canned answer comes back. No tool calls, so any loop ends at once.
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Stub answer: a short direct explanation.' }] } }],
      choices: [{ message: { content: 'Stub answer: a short direct explanation.', tool_calls: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('Unexpected fetch: ' + url);
}) as any;

const { handleOrchestratedChat } = await import('../server/agent/apiOrchestrator.ts');

const fakeKey = {
  id: 'fake-gemini-1',
  provider: 'gemini',
  name: 'Fake Gemini',
  apiKey: 'AIzaFAKEKEYONE',
  model: 'gemini-3.1-flash-lite',
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

console.log('end-to-end explain turn ("explain what React is", stubbed provider):');
providerCalls.length = 0;
const explainEvents = await runTurn('step7-proof-explain', 'explain what React is');
const explainDone = explainEvents.find((e) => e.type === 'done');
const explainKeyActive = explainEvents.filter((e) => e.type === 'key_active');
console.log(`  provider model calls: ${providerCalls.length}, key_active: ${explainKeyActive.length}, done: ${JSON.stringify(explainDone)}`);
ok('explain turn makes exactly 1 provider call (one direct answer, no loop)', () => {
  assert.equal(providerCalls.length, 1, `expected 1 provider call, got ${providerCalls.length}`);
});
ok('explain turn never starts the agent loop (zero key_active)', () => {
  assert.equal(explainKeyActive.length, 0, `expected 0 key_active, got ${explainKeyActive.length}`);
});
ok('explain turn reports apiCalls == 1 and a non-Hydrogen model', () => {
  assert.ok(explainDone, 'expected a done event');
  assert.equal(explainDone.apiCalls, 1, `expected apiCalls 1, got ${explainDone.apiCalls}`);
  assert.ok(explainDone.model && !String(explainDone.model).includes('hydrogen'),
    `expected a cheap model, got ${explainDone.model}`);
});
ok('explain turn answers with the direct text', () => {
  assert.ok(String(explainDone.fullText || '').includes('Stub answer'), 'done fullText must carry the direct answer');
});

console.log('end-to-end build turn ("build a landing page for a bakery", stubbed provider):');
providerCalls.length = 0;
const buildEvents = await runTurn('step7-proof-build', 'build a landing page for a bakery');
const buildKeyActive = buildEvents.filter((e) => e.type === 'key_active');
console.log(`  provider model calls: ${providerCalls.length}, key_active: ${buildKeyActive.length}`);
ok('build turn still enters the agent loop (key_active events emitted)', () => {
  assert.ok(buildKeyActive.length >= 1, `expected >= 1 key_active, got ${buildKeyActive.length}`);
});
ok('build turn still makes provider calls from the loop', () => {
  assert.ok(providerCalls.length >= 1, `expected loop provider calls, got ${providerCalls.length}`);
});

globalThis.fetch = realFetch;
console.log(`\nEXPLAIN-ROUTING PROOF (STEP 7): ${passed} checks passed, 0 failed.`);
