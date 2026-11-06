/**
 * Consume an OpenAI-compatible chat completion, streaming when the provider
 * really streams.
 *
 * Providers are not uniform about `stream: true`: the Hugging Face router and
 * Agnes AI normally answer with `text/event-stream`, but a gateway can buffer
 * the response and hand back a single JSON completion instead (some router
 * providers and self-hosted proxies do exactly that). We therefore parse SSE
 * frames when they are present and fall back to the plain JSON body, so a real
 * completion is never discarded as "empty output".
 */

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionPayload {
  model?: string;
  usage?: ChatCompletionUsage;
  choices?: Array<{
    message?: { content?: string | null };
    delta?: { content?: string | null };
    text?: string | null;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads the text of a completion object in any of the shapes providers use. */
function completionText(payload: ChatCompletionPayload): string {
  const choice = payload.choices?.[0];
  const fromMessage = choice?.message?.content;
  if (typeof fromMessage === 'string' && fromMessage) return fromMessage;
  const fromDelta = choice?.delta?.content;
  if (typeof fromDelta === 'string' && fromDelta) return fromDelta;
  const fromText = choice?.text;
  if (typeof fromText === 'string' && fromText) return fromText;
  return '';
}

export async function readChatStream(
  response: Response,
  onText: (text: string) => void,
  timeoutMs: number,
): Promise<ChatCompletionPayload> {
  if (!response.body) throw new Error('The provider returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** The whole body, kept only so a buffered JSON response can be recovered. */
  let raw = '';
  let text = '';
  let model: string | undefined;
  let usage: ChatCompletionUsage | undefined;
  let doneEvent = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, timeoutMs);
  onText('');

  const consume = (payload: ChatCompletionPayload) => {
    model = payload.model ?? model;
    usage = payload.usage ?? usage;
    const piece = completionText(payload);
    // A streamed delta replaces nothing: append. A buffered completion carries
    // the whole answer, so it is used as-is.
    if (!piece) return;
    const delta = payload.choices?.[0]?.delta?.content;
    text = typeof delta === 'string' ? text + delta : piece;
    onText(text);
  };

  const event = (frame: string) => {
    const dataLines = frame
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(line => line.startsWith('data:'));
    const data = dataLines.length
      ? dataLines.map(line => line.slice(5).trimStart()).join('\n')
      : frame.trim();
    if (!data) return;
    if (data === '[DONE]') { doneEvent = true; return; }
    // Non-SSE frames (a buffered body split on blank lines) may not be JSON;
    // ignore those instead of failing the whole generation.
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.error) throw new Error('The provider reported an error during streaming.');
    consume(parsed as ChatCompletionPayload);
  };

  try {
    while (!doneEvent) {
      const { value, done } = await reader.read();
      if (timedOut) throw new Error('Text generation timed out.');
      const chunk = decoder.decode(value, { stream: !done });
      raw += chunk;
      buffer += chunk;
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const index = boundary.index!;
        event(buffer.slice(0, index));
        buffer = buffer.slice(index + boundary[0].length);
      }
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!text.trim()) {
      // The provider ignored `stream: true` and returned one JSON completion.
      try {
        const payload: unknown = JSON.parse(raw);
        if (isRecord(payload)) {
          const choice = payload as ChatCompletionPayload;
          const whole = completionText(choice);
          if (whole) {
            model = choice.model ?? model;
            usage = choice.usage ?? usage;
            text = whole;
            onText(text);
          }
        }
      } catch {
        // Not JSON either: fall through to the empty-response error below.
      }
    }
    if (!text.trim()) throw new Error('The provider returned an empty response.');
    return { model, usage, choices: [{ message: { content: text } }] };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
