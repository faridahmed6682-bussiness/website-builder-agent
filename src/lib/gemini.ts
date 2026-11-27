import { ActionStep, KeyMetadata } from '../types/secrets';
import { getLocalKeys, getPreferOnlyCustomKeys, getLastSuccessfulKeyId, setLastSuccessfulKeyId } from './secretsManager';

export type { KeyMetadata };

export interface ChatAIOptions {
  selectedModel?: string;
  developerPersona?: string;
  customSystemInstruction?: string;
  outputFormat?: 'auto' | 'markdown' | 'json';
  multiAgent?: boolean;
  /** Vision: base64 image (client-downscaled) + mime, sent to the server. */
  imageBase64?: string;
  imageMime?: string;
  /** Per-turn usage (requests/tokens per model/step) for the usage display. */
  onUsage?: (usage: any) => void;
  /** Multi-agent team status (planner/coder/reviewer/tester). */
  onAgentStatus?: (status: { agent: string; status: string; detail?: string }) => void;
}

export async function chatWithAI(
  messages: any[],
  onUpdateText: (text: string, imageUrl?: string) => void,
  onAction: (action: string) => void,
  mode: string = 'coding',
  onRotateKey: (keyId: string, cooldownSec: number) => void,
  onPreviewReady: (url: string, html?: string, sessionId?: string) => void,
  sessionId?: string,
  onKeyInfo?: (keyInfo: KeyMetadata) => void,
  onActionStep?: (step: ActionStep) => void,
  options?: ChatAIOptions,
  onFileModified?: (file: { filePath: string; action?: string }) => void,
  onAskQuestion?: (payload: { questionId: string; questions: any[] }) => void
): Promise<void> {
  const localKeys = getLocalKeys().filter(k => k.isActive);
  const preferOnlyCustomKeys = getPreferOnlyCustomKeys();
  const stickyKeyId = getLastSuccessfulKeyId();

  const response = await fetch('/api/gemini/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      mode,
      sessionId,
      userKeys: localKeys,
      keys: localKeys,
      preferOnlyCustomKeys,
      stickyKeyId,
      selectedModel: options?.selectedModel,
      developerPersona: options?.developerPersona,
      customSystemInstruction: options?.customSystemInstruction,
      outputFormat: options?.outputFormat,
      multiAgent: options?.multiAgent,
      imageBase64: options?.imageBase64,
      imageMime: options?.imageMime,
    }),
  });

  if (!response.ok) {
    let errorMsg = `Server error ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming not supported or failed to obtain response stream reader.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = '';
  let latestImageUrl: string | undefined = undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.replace(/^data:\s*/, '');
      if (!jsonStr) continue;

      let event: any = null;
      try {
        event = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn('Failed to parse SSE event data:', jsonStr, parseErr);
        continue;
      }

      switch (event.type) {
        case 'text':
          accumulatedText = event.text;
          onUpdateText(accumulatedText, latestImageUrl);
          break;

        case 'image':
          latestImageUrl = event.imageUrl;
          onUpdateText(accumulatedText, latestImageUrl);
          break;

        case 'action':
          if (event.action) {
            onAction(event.action);
          }
          break;

        case 'action_step':
          if (event.step && onActionStep) {
            onActionStep({
              ...event.step,
              details: event.step.details || event.step.detail,
            });
          }
          break;

        case 'file_modified':
          if (event.filePath && onFileModified) {
            onFileModified({
              filePath: event.filePath,
              action: event.action,
            });
          }
          break;

        case 'ask_question':
          if (event.questionId && Array.isArray(event.questions) && onAskQuestion) {
            onAskQuestion({
              questionId: event.questionId,
              questions: event.questions,
            });
          }
          break;

        case 'key_info':
          if (event.keyInfo && onKeyInfo) {
            onKeyInfo(event.keyInfo);
          }
          break;

        case 'key_active':
          if (onKeyInfo) {
            onKeyInfo({
              keyId: event.keyId,
              keyName: event.keyName,
              model: event.model,
              provider: event.provider,
              isCustomKey: event.isCustomKey,
            });
          }
          break;

        case 'preview_ready':
          if (event.url) {
            onPreviewReady(event.url, event.html, event.sessionId || sessionId);
          }
          break;

        case 'rotate_key':
        case 'key_cooldown':
          if (event.keyId) {
            onRotateKey(event.keyId, event.cooldownSec || 60);
          }
          break;

        case 'usage':
        case 'usage_summary':
          if (event.usage && options?.onUsage) {
            options.onUsage(event.usage);
          }
          break;

        case 'agent_status':
          if (event.agent && options?.onAgentStatus) {
            options.onAgentStatus({ agent: event.agent, status: event.status, detail: event.detail });
          }
          break;

        case 'error': {
          const serverErr: any = new Error(event.error || 'Server processing error');
          serverErr.isAuthError = Boolean(event.isAuthError);
          throw serverErr;
        }

        case 'done':
          if (event.activeKeyId || event.keyId) {
            setLastSuccessfulKeyId(event.activeKeyId || event.keyId);
          }
          break;
      }
    }
  }
}
