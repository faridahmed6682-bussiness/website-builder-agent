// Embedded router — provider adapters.
//
// All three providers expose an OpenAI-compatible /v1/chat/completions
// endpoint, so the router is one thin fetch per provider. The Gemini
// endpoint is Google's own OpenAI-compatible surface
// (generativelanguage.googleapis.com/v1beta/openai/) — it supports tools,
// streaming and reasoning_effort natively, and translates reasoning_effort
// to the Gemini thinking config server-side.
//
// reasoning_effort mapping: the OpenAI-compatible endpoints accept
// 'low'/'high' but not 'xhigh' (xhigh is a FreeLLMAPI translation of the
// Gemini thinking_level). The embedded router maps xhigh -> high and says so
// in the README; the external FreeLLMAPI path keeps the full xhigh
// translation. 'high' is the default knee — the loss from xhigh is small and
// only affects the hardest plans.
import type { RouterProvider } from './keys.ts';

export interface RouterChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  stream?: boolean;
  max_tokens?: number;
  reasoning_effort?: string;
}

const PROVIDER_ENDPOINTS: Record<RouterProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

/** Strip a provider prefix for providers that want the bare model id. */
export function bareModelId(provider: RouterProvider, model: string): string {
  if (provider === 'gemini') {
    return model.replace(/^google\//, '').replace(/^gemini\//, '');
  }
  return model;
}

function mapReasoningEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === 'xhigh') return 'high'; // OpenAI-compat endpoints cap at 'high'
  return effort;
}

export async function callProvider(
  provider: RouterProvider,
  model: string,
  req: RouterChatRequest,
  apiKey: string,
  timeoutMs = 120000,
): Promise<Response> {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://localhost/';
    headers['X-Title'] = 'Website Builder Agent';
  }
  const body: Record<string, unknown> = {
    model: bareModelId(provider, model),
    messages: req.messages,
    stream: Boolean(req.stream),
  };
  if (req.max_tokens) body.max_tokens = req.max_tokens;
  const effort = mapReasoningEffort(req.reasoning_effort);
  if (effort) body.reasoning_effort = effort;
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.tool_choice || 'auto';
  }
  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
