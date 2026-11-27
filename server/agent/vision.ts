// Vision — build from image. The chat accepts an image upload (screenshot /
// design). A vision-capable FREE model describes the design, and the agent
// builds a site matching it.
//
// The model is Gemini (multimodal on the free tier): Hydrogen for the
// description (Tier 2 — description quality decides the build), via the
// planning chain. No paid vision API anywhere. The description is a structured
// design brief (~300 words): layout, sections, colours, typography, text
// content, components — which the agent then builds from like any other brief.
// The uploaded image is shown in the conversation (client) and stored with
// the chat turn (server memory), never sent anywhere except the model call.
import { chatOnce, planningChain } from './llmClient.ts';

const VISION_SYSTEM = `You are a UI designer describing a screenshot/design image so a website builder can recreate it as a working site. Describe ONLY what you can see. Be concrete and structured:

1. Overall layout (header, hero, sections in order, footer; sidebar or single column)
2. Colour palette (dominant colours, background, accents — hex when you can tell)
3. Typography (headings style, body text style, sizes/weights if visible)
4. Sections in order, each with: what it contains, key text (quote visible headings/buttons exactly), images/icons
5. Components (buttons, cards, forms, nav links, prices, badges)
6. Style notes (rounded/sharp, shadows, spacing, mobile feel)

Keep it under ~300 words. Do not invent text or features that are not visible. If text is unreadable, say so.`;

export interface ImageBrief {
  brief: string;
  model: string;
}

/** Describe an uploaded image as a build brief. Throws when no model answers. */
export async function describeImage(imageBase64: string, mime = 'image/jpeg'): Promise<ImageBrief> {
  const chain = planningChain();
  const { text, model } = await chatOnce({
    system: VISION_SYSTEM,
    user: 'Describe this design image as a website build brief.',
    imageBase64,
    imageMime: mime,
    chain,
    maxTokens: 1200,
    timeoutMs: 90000,
  });
  const brief = (text || '').trim();
  if (!brief) throw new Error('Vision model returned an empty description.');
  return { brief, model };
}

// STEP 17 (P2/F6): does this message ask about the uploaded image itself?
// Local-only check, no model call. An image noun (image / picture / photo /
// screenshot / design, ছবি / স্ক্রিনশট / ডিজাইন) PLUS a question mark or a
// describe/ask verb ("what", "describe", "tell", "show", "explain", "look",
// "কী", "বলো", "দেখো", ...) means the answer needs the image content —
// e.g. "what's in this image?", "describe this image", "এই ছবিটা কেমন?".
// A bare greeting or praise ("hi", "nice pic!") does not: the image is
// incidental there and no vision call is warranted.
const IMAGE_NOUN_RE = /\b(image|picture|photo|screenshot|pic|design)\b|ছবি|স্ক্রিনশট|ডিজাইন/i;
const IMAGE_QUESTION_RE = /[?？]|\b(what|describe|tell|show|explain|look|see|how|why)\b|কী|কি|ব্যাখ্যা|বুঝিয়ে|বুঝিয়ে|দেখো|বলো/i;

export function asksAboutImage(prompt: string): boolean {
  const text = (prompt || '').trim();
  if (!text) return false;
  return IMAGE_NOUN_RE.test(text) && IMAGE_QUESTION_RE.test(text);
}
