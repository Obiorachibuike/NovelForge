/** Consume OpenAI-compatible SSE without losing split UTF-8 or event frames. */
export async function readChatStream(
  response: Response,
  onText: (text: string) => void,
  timeoutMs: number,
): Promise<any> {
  if (!response.body) throw new Error('The provider returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model: string | undefined;
  let usage: any;
  let doneEvent = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, timeoutMs);
  onText('');
  const event = (frame: string) => {
    const data = frame.replace(/\r\n/g, '\n').split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { doneEvent = true; return; }
    const part = JSON.parse(data);
    if (part.error) throw new Error('The provider reported an error during streaming.');
    model = part.model ?? model;
    usage = part.usage ?? usage;
    const delta = part.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) { text += delta; onText(text); }
  };
  try {
    while (!doneEvent) {
      const { value, done } = await reader.read();
      if (timedOut) throw new Error('Text generation timed out.');
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const index = boundary.index!;
        event(buffer.slice(0, index));
        buffer = buffer.slice(index + boundary[0].length);
      }
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!text.trim()) throw new Error('The provider returned an empty response.');
    return { model, usage, choices: [{ message: { content: text } }] };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
