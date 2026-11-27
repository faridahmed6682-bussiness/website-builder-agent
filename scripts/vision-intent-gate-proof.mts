// Step 17 (P2/F6) proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/vision-intent-gate-proof.mts
// Proves:
//  1. asksAboutImage (local, no model call): messages that ask about the
//     image itself ("what's in this image?", "describe this image",
//     "is this design good?", "এই ছবিটা কেমন?") -> true; a bare greeting
//     or praise with an image ("hi", "nice pic!") -> false.
//  2. End-to-end (stubbed provider, fake key, fake image bytes): a CASUAL
//     turn with an image ("hi" + image) makes ZERO vision calls — no
//     provider request carries the image bytes — and still gets its one
//     direct cheap-model answer. A TASK turn with an image still gets its
//     vision description (a provider request carries the image bytes, and
//     the brief reaches the agent loop). A casual turn that ASKS about the
//     image ("what's in this image?") DOES get a vision call, and the
//     brief is fed to the cheap casual answer (the answer request carries
//     the brief text). A plain casual turn without an image is unchanged
//     (1 cheap call, 0 vision calls).
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
const { asksAboutImage } = await import('../server/agent/vision.ts');

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`); };

// 1. Local image-question check ---------------------------------------------
console.log('asksAboutImage:');
for (const q of [
  "what's in this image?",
  'describe this image',
  'is this design good?',
  'what do you think of this photo',
  'এই ছবিটা কেমন?',
  'ছবিটা দেখো',
]) {
  ok(`asks about the image -> true: "${q}"`, () => {
    assert.equal(asksAboutImage(q), true, `expected true for "${q}"`);
  });
}
for (const q of [
  'hi',
  'nice pic!',
  'thanks',
  'this picture is beautiful',
  'build a site like this design',
  '',
]) {
  ok(`does not ask about the image -> false: "${q}"`, () => {
    assert.equal(asksAboutImage(q), false, `expected false for "${q}"`);
  });
}

// 2. Intent classification of the same turns (cheap/local, no model call) ---
console.log('classifyIntentLocal:');
ok('"hi" is casual', () => assert.equal(classifyIntentLocal('hi'), 'casual'));
ok('"what\'s in this image?" is casual (explain-style question)', () => assert.equal(classifyIntentLocal("what's in this image?"), 'casual'));
ok('"describe this image" is casual', () => assert.equal(classifyIntentLocal('describe this image'), 'casual'));
ok('"build a landing page like this design" is a task', () => assert.equal(classifyIntentLocal('build a landing page like this design'), 'task'));

// 3. End-to-end through handleOrchestratedChat ------------------------------
const FAKE_IMAGE = 'FAKEIMAGEBYTES';
const VISION_BRIEF = 'STUB-VISION-BRIEF: red hero, white cards, blue buttons.';

interface ProviderCall { url: string; body: string }
const providerCalls: ProviderCall[] = [];
const visionCalls = () => providerCalls.filter((c) => c.body.includes(FAKE_IMAGE));
const briefUses = () => providerCalls.filter((c) => c.body.includes(VISION_BRIEF));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? String(init.body) : '';
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
    providerCalls.push({ url, body });
    // A vision call (request carries the image bytes) gets the distinctive
    // design brief; every other call gets the canned direct answer. The
    // combined Gemini + OpenAI shape is readable by either parser.
    const text = body.includes(FAKE_IMAGE)
      ? VISION_BRIEF
      : 'Stub answer: a short direct reply.';
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      choices: [{ message: { content: text, tool_calls: null }, finish_reason: 'stop' }],
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

function runTurn(sessionId: string, text: string, imageBase64?: string): Promise<any[]> {
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
      { messages: [{ role: 'user', parts: [{ text }] }], userKeys: [fakeKey], sessionId, imageBase64, imageMime: 'image/jpeg' },
      res,
    ).catch((err: any) => { clearTimeout(timer); reject(err); });
  });
}

console.log('end-to-end casual turn with an image ("hi" + image):');
providerCalls.length = 0;
const casualImgEvents = await runTurn('step17-proof-casual-img', 'hi', FAKE_IMAGE);
const casualImgDone = casualImgEvents.find((e) => e.type === 'done');
const casualImgKeyActive = casualImgEvents.filter((e) => e.type === 'key_active');
console.log(`  provider calls: ${providerCalls.length}, vision calls: ${visionCalls().length}, key_active: ${casualImgKeyActive.length}, done: ${JSON.stringify(casualImgDone)}`);
ok('casual + image makes ZERO vision calls (no request carries the image bytes)', () => {
  assert.equal(visionCalls().length, 0, `expected 0 vision calls, got ${visionCalls().length}`);
});
ok('casual + image still gets its one direct cheap-model answer', () => {
  assert.equal(providerCalls.length, 1, `expected 1 provider call, got ${providerCalls.length}`);
  assert.ok(casualImgDone, 'expected a done event');
  assert.ok(casualImgDone.model && !String(casualImgDone.model).includes('hydrogen'),
    `expected a cheap model, got ${casualImgDone.model}`);
});
ok('casual + image never starts the agent loop (zero key_active)', () => {
  assert.equal(casualImgKeyActive.length, 0, `expected 0 key_active, got ${casualImgKeyActive.length}`);
});

console.log('end-to-end task turn with an image ("build a landing page like this design" + image):');
providerCalls.length = 0;
const taskImgEvents = await runTurn('step17-proof-task-img', 'build a landing page like this design', FAKE_IMAGE);
const taskImgKeyActive = taskImgEvents.filter((e) => e.type === 'key_active');
console.log(`  provider calls: ${providerCalls.length}, vision calls: ${visionCalls().length}, brief uses: ${briefUses().length}, key_active: ${taskImgKeyActive.length}`);
ok('task + image still gets its vision description (a request carries the image bytes)', () => {
  assert.ok(visionCalls().length >= 1, `expected >= 1 vision call, got ${visionCalls().length}`);
});
ok('task + image feeds the vision brief into the agent loop', () => {
  assert.ok(briefUses().length >= 1, `expected the brief in a later call, got ${briefUses().length} uses`);
});
ok('task + image still enters the agent loop (key_active events emitted)', () => {
  assert.ok(taskImgKeyActive.length >= 1, `expected >= 1 key_active, got ${taskImgKeyActive.length}`);
});

console.log('end-to-end image-question casual turn ("what\'s in this image?" + image):');
providerCalls.length = 0;
const askImgEvents = await runTurn('step17-proof-ask-img', "what's in this image?", FAKE_IMAGE);
const askImgDone = askImgEvents.find((e) => e.type === 'done');
console.log(`  provider calls: ${providerCalls.length}, vision calls: ${visionCalls().length}, brief uses: ${briefUses().length}, done: ${JSON.stringify(askImgDone)}`);
ok('image question DOES get a vision call (the answer needs the image content)', () => {
  assert.equal(visionCalls().length, 1, `expected exactly 1 vision call, got ${visionCalls().length}`);
});
ok('image question feeds the brief to the cheap casual answer', () => {
  assert.ok(briefUses().length >= 1, `expected the brief in the casual answer call, got ${briefUses().length} uses`);
  assert.ok(askImgDone, 'expected a done event');
  assert.ok(String(askImgDone.fullText || '').includes('Stub answer'), 'done fullText must carry the direct answer');
});
ok('image question costs exactly 2 provider calls (vision + one cheap answer, no loop)', () => {
  assert.equal(providerCalls.length, 2, `expected 2 provider calls, got ${providerCalls.length}`);
  assert.equal(askImgEvents.filter((e) => e.type === 'key_active').length, 0, 'agent loop must not start');
});

console.log('end-to-end plain casual turn without an image ("hi", regression check):');
providerCalls.length = 0;
const casualEvents = await runTurn('step17-proof-casual', 'hi');
const casualDone = casualEvents.find((e) => e.type === 'done');
console.log(`  provider calls: ${providerCalls.length}, vision calls: ${visionCalls().length}`);
ok('plain casual turn is unchanged (1 cheap call, 0 vision calls)', () => {
  assert.equal(providerCalls.length, 1, `expected 1 provider call, got ${providerCalls.length}`);
  assert.equal(visionCalls().length, 0, `expected 0 vision calls, got ${visionCalls().length}`);
  assert.ok(casualDone, 'expected a done event');
});

globalThis.fetch = realFetch;
console.log(`\nVISION-INTENT-GATE PROOF (STEP 17): ${passed} checks passed, 0 failed.`);
