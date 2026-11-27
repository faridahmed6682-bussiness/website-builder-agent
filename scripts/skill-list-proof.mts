// Skill-list proof — mocks/stubs ONLY, no real API keys, no network.
// Run: npx tsx scripts/skill-list-proof.mts
// Proves (Step 5, P0):
//  1. The system prompt lists skill NAMES only (no descriptions): all 34
//     names present, zero of the 34 descriptions present; section token
//     size before vs after, and full-prompt size before vs after. The
//     "before" prompt is reconstructed from the registry with the exact
//     old formula + old intro text + the four stale tool names, and
//     cross-checked against the pre-edit baseline (16384 chars) measured
//     before the change was made.
//  2. Matched-skill preload intact: a prompt built with matchedSkills
//     still carries that skill's full instructions verbatim, while a
//     non-matched skill's instructions are NOT in the default prompt
//     (detail loads on demand via read_skill).
//  3. read_skill still resolves a skill by name: getSkillByName /
//     listAllSkillsSummary (the exact functions the executor calls) return
//     the skill, and the read_skill declaration still exists in serverTools.
//  4. Bonus: none of the 17 step-4-dropped tools is named (backticked) in
//     the prompt any more — the model is not told about undeclared tools.
import assert from 'node:assert';

// --- Fake keys (obviously not real) / no keys at all ------------------------
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEYS;
delete process.env.GROQ_API_KEYS;
delete process.env.OPENROUTER_API_KEYS;
delete process.env.FREE_LLM_API_URL;
delete process.env.FREE_LLM_API_KEY;

const { getNexusSystemInstruction } = await import('../server/agent/websiteDeployer.ts');
const { CODING_SKILLS_REGISTRY, getSkillByName, listAllSkillsSummary } = await import('../server/agent/skillsRegistry.ts');
const { estimateTokens } = await import('../server/agent/usage.ts');
const { serverTools } = await import('../server/agent/geminiService.ts');

const skills = CODING_SKILLS_REGISTRY;
assert.strictEqual(skills.length, 34, `registry should hold 34 skills, got ${skills.length}`);

// --- Old (pre-step-5) section, exact formula from HEAD ----------------------
const oldSection = skills
  .map((s, i) => `${i + 1}. [${s.name}]: ${s.description}`)
  .join('\n');

const newPrompt = getNexusSystemInstruction('general');

// The new names-only section: lines of comma-separated names, between the
// intro paragraph and the matched-skills/memory sections.
const sectionStart = newPrompt.indexOf('frontend-design');
assert.ok(sectionStart > 0, 'new prompt should contain the first skill name');
const sectionEnd = newPrompt.indexOf('\n\n===', sectionStart);
assert.ok(sectionEnd > sectionStart, 'could not find end of skill section');
const newSection = newPrompt.slice(sectionStart, sectionEnd);

// --- 1. Names only + size before vs after -----------------------------------
for (const s of skills) {
  assert.ok(newPrompt.includes(s.name), `prompt missing skill name ${s.name}`);
  assert.ok(!newPrompt.includes(s.description), `prompt still carries description of ${s.name}`);
}
assert.ok(!newSection.includes('[') && !newSection.includes(']:'),
  'new skill section should have no "[name]: description" lines');

// Reconstruct the exact pre-step-5 prompt from the new one and cross-check
// it against the baseline measured before the edit (16384 chars).
const OLD_INTRO = 'At the start of a NEW CODING TASK or when user prompt shifts to implementation, perform a Skill Check!\nIf any skill below is [RELEVANT] to the user\'s request, call `read_skill` with its SkillName BEFORE modifying or creating code files:';
const newIntroStart = newPrompt.indexOf('At the start of a NEW CODING TASK');
const newIntroEnd = newPrompt.indexOf(':', newPrompt.indexOf('no extra read_skill call needed for them')) + 1;
const newIntro = newPrompt.slice(newIntroStart, newIntroEnd);
const oldPrompt = newPrompt
  .replace(newSection, oldSection)
  .replace(newIntro, OLD_INTRO)
  .replace(`(${skills.length} CODING SKILLS — NAMES ONLY)`, `(${skills.length} CODING SKILLS)`)
  .replace('`deploy_firebase`, `cloudsql_execute_sql`).',
    '`deploy_firebase`, `set_up_oauth`, `cloudsql_execute_sql`, `figma_import`, `focus_mode`, `schedule`).');
assert.strictEqual(oldPrompt.length, 16384,
  `reconstructed old prompt should match the pre-edit baseline (16384 chars), got ${oldPrompt.length}`);

const size = (label: string, text: string) => ({ label, chars: text.length, tokens: estimateTokens(text) });
const before = { section: size('old section', oldSection), prompt: size('old prompt', oldPrompt) };
const after = { section: size('new section', newSection), prompt: size('new prompt', newPrompt) };
assert.ok(after.section.tokens < before.section.tokens, 'skill section tokens must drop');
assert.ok(after.prompt.tokens < before.prompt.tokens, 'full prompt tokens must drop');
const savedSection = before.section.tokens - after.section.tokens;
const savedPrompt = before.prompt.tokens - after.prompt.tokens;
assert.ok(savedSection >= 1000, `expected >=1000 tokens saved in the section, got ${savedSection}`);

// --- 2. Matched-skill preload intact ----------------------------------------
const frontend = skills.find((s) => s.name === 'frontend-design')!;
const matched = getNexusSystemInstruction('general', {
  matchedSkills: `### ${frontend.name}\n${frontend.instructions}`,
});
assert.ok(matched.includes('PRE-LOADED SKILLS FOR THIS REQUEST'), 'matched-skills header missing');
assert.ok(matched.includes(frontend.instructions), 'matched skill instructions must be preloaded verbatim');
const testing = skills.find((s) => s.name === 'testing')!;
assert.ok(!newPrompt.includes(testing.instructions),
  'non-matched skill instructions must NOT be in the default prompt');

// --- 3. read_skill still resolves a skill by name ---------------------------
const resolved = getSkillByName('frontend-design');
assert.ok(resolved && resolved.instructions.includes('Anti-AI Slop'),
  'getSkillByName should resolve frontend-design with full instructions');
assert.strictEqual(getSkillByName('no-such-skill'), undefined, 'unknown skill should resolve to undefined');
const summaries = listAllSkillsSummary();
assert.strictEqual(summaries.length, 34, `read_skill 'list' should summarise 34 skills, got ${summaries.length}`);
assert.ok(summaries.every((s) => s.description && s.triggers.length > 0),
  'every list summary should carry a description + triggers');
assert.ok(serverTools.some((t: any) => t.name === 'read_skill'), 'read_skill declaration missing from serverTools');

// --- 4. Bonus: no dropped tool named in the prompt --------------------------
const DROPPED_17 = [
  'fileRead', 'fileWrite', 'fileEdit', 'bash',
  'claw_doctor', 'claw_status', 'claw_acp', 'claw_prompt',
  'omx_protocol', 'clawhip_router', 'lazycodex_runner',
  'figma_import', 'focus_mode', 'set_up_oauth', 'remove_oauth',
  'cloudsql_update_schema', 'schedule',
];
for (const name of DROPPED_17) {
  assert.ok(!newPrompt.includes(`\`${name}\``), `prompt still names dropped tool \`${name}\``);
}

// --- Report ------------------------------------------------------------------
console.log('STEP 5 PROOF — all assertions passed');
console.log(`  skill section: ${before.section.chars} chars / ${before.section.tokens} tokens -> ${after.section.chars} chars / ${after.section.tokens} tokens (saved ${savedSection} tokens, -${((savedSection / before.section.tokens) * 100).toFixed(1)}%)`);
console.log(`  full prompt:   ${before.prompt.chars} chars / ${before.prompt.tokens} tokens -> ${after.prompt.chars} chars / ${after.prompt.tokens} tokens (saved ${savedPrompt} tokens, -${((savedPrompt / before.prompt.tokens) * 100).toFixed(1)}%)`);
console.log(`  matched preload: frontend-design instructions (${frontend.instructions.length} chars) present verbatim; non-matched 'testing' instructions absent from default prompt`);
console.log(`  read_skill: resolves 'frontend-design' by name; 'list' summarises 34 skills; declaration present in serverTools`);
console.log(`  stale tools: 0 of the 17 dropped tools named in the prompt`);
