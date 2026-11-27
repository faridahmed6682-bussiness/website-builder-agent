// Step 6 (P0) proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/casual-failure-proof.mts
// Proves:
//  1. A failing CASUAL turn ("hi") ends with a short friendly Bengali error
//     and makes ZERO further model calls after the casual answer fails —
//     no fall-through into the agent retry loop (no key_active events,
//     no "Routing via" actions, provider-call count frozen once the error
//     event is emitted).
//  2. A failing TASK turn still retries normally — the agent loop runs
//     (key_active events emitted, pool attempts made) and only then fails.
import assert from 'node:assert';

// --- Fake keys (obviously not real) ---------------------------------------
process.env.GEMINI_API_KEYS = 'AIzaFAKEKEYONE';
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.OPENROUTER_API_KEY;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;
delete process.env.GEMINI_API_KEY; // no studio fallback in either case

const providerCalls: Array<{ url: string; model?: string }> = [];

// --- Global fetch stub: every provider call fails --------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  // Catalog discovery (router + chain verification).
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

  // Every real model call fails (500) — the casual answer AND the loop.
  if (/generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai/.test(url)) {
    providerCalls.push({ url, model: body?.model });
    return new Response(JSON.stringify({ error: { message: 'Simulated provider outage', code: 500 } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
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

type Captured = { events: any[]; callsAtError: number | null };

function runTurn(sessionId: string, text: string): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const captured: Captured = { events: [], callsAtError: null };
    const timer = setTimeout(() => reject(new Error(`turn "${text}" timed out after 180s`)), 180_000);
    const res: any = {
      setHeader() {},
      on() {},
      once() {},
      write(chunk: string) {
        for (const line of String(chunk).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            captured.events.push(ev);
            if (ev.type === 'error' && captured.callsAtError === null) {
              captured.callsAtError = providerCalls.length;
            }
          } catch { /* heartbeat / non-JSON line */ }
        }
      },
      end() {
        clearTimeout(timer);
        resolve(captured);
      },
    };
    handleOrchestratedChat(
      {
        messages: [{ role: 'user', parts: [{ text }] }],
        userKeys: [fakeKey],
        sessionId,
      },
      res,
    ).catch((err: any) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// 1. Failing casual turn ------------------------------------------------------
console.log('casual turn ("hi", all providers failing):');
const casual = await runTurn('step6-proof-casual', 'hi');
const casualErrors = casual.events.filter((e) => e.type === 'error');
const casualKeyActive = casual.events.filter((e) => e.type === 'key_active');
const casualRouting = casual.events.filter((e) => e.type === 'action' && /Routing via/.test(String(e.action || '')));
console.log(`  events: ${casual.events.map((e) => e.type).join(', ')}`);
console.log(`  provider model calls total: ${providerCalls.length} (chatOnce's own cheap-chain walk)`);
console.log(`  provider calls at error event: ${casual.callsAtError}, at end: ${providerCalls.length}`);
ok('casual failure ends with the friendly Bengali error, not a raw rotation error', () => {
  assert.equal(casualErrors.length, 1, `expected exactly 1 error event, got ${casualErrors.length}`);
  assert.ok(String(casualErrors[0].error).includes('দুঃখিত'), 'error must be Bengali-first');
  assert.ok(String(casualErrors[0].error).includes('Keys ট্যাবে'), 'error must point at the Keys tab');
});
ok('no fall-through: zero key_active events (agent loop never started)', () => {
  assert.equal(casualKeyActive.length, 0, `expected 0 key_active, got ${casualKeyActive.length}`);
  assert.equal(casualRouting.length, 0, `expected 0 "Routing via" actions, got ${casualRouting.length}`);
});
ok('no fall-through: zero provider calls after the casual error event', () => {
  assert.notEqual(casual.callsAtError, null, 'an error event must have been emitted');
  assert.equal(providerCalls.length, casual.callsAtError,
    `expected no calls after the error event (${casual.callsAtError}), got ${providerCalls.length}`);
});

// 2. Failing task turn still retries ------------------------------------------
console.log('task turn ("build a landing page for a bakery", all providers failing):');
providerCalls.length = 0;
const task = await runTurn('step6-proof-task', 'build a landing page for a bakery');
const taskKeyActive = task.events.filter((e) => e.type === 'key_active');
const taskErrors = task.events.filter((e) => e.type === 'error');
console.log(`  key_active events: ${taskKeyActive.length}, provider model calls: ${providerCalls.length}`);
console.log(`  events: ${task.events.map((e) => e.type).join(', ')}`);
ok('task turn still enters the agent loop (key_active events emitted)', () => {
  assert.ok(taskKeyActive.length >= 1, `expected >= 1 key_active, got ${taskKeyActive.length}`);
});
ok('task turn still retries (provider calls made by the loop)', () => {
  assert.ok(providerCalls.length >= 1, `expected loop provider calls, got ${providerCalls.length}`);
});
ok('task turn ends with an error event after the loop exhausts', () => {
  assert.ok(taskErrors.length >= 1, 'expected an error event at the end of the failed task turn');
});

globalThis.fetch = realFetch;
console.log(`\nCASUAL-FAILURE PROOF (STEP 6): ${passed} checks passed, 0 failed.`);
