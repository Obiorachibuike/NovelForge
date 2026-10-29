import { describe, expect, it } from 'vitest';
import { readChatStream } from '@/lib/ai/chat-stream';

function response(chunks: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }));
}

describe('live chapter stream', () => {
  it('assembles fragmented events and publishes full replacement snapshots', async () => {
    const snapshots: string[] = [];
    const result = await readChatStream(response([
      'data: {"choices":[{"delta":{"content":"The "}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"story."}}]}\n\n',
      'data: {"usage":{"completion_tokens":3}}\n\ndata: [DONE]\n\n',
    ]), text => snapshots.push(text), 1000);
    expect(snapshots).toEqual(['', 'The ', 'The story.']);
    expect(result.choices[0].message.content).toBe('The story.');
    expect(result.usage.completion_tokens).toBe(3);
  });

  it('rejects empty output rather than publishing a demo', async () => {
    await expect(readChatStream(response(['data: [DONE]\n\n']), () => {}, 1000)).rejects.toThrow('empty');
  });

  it('reports provider errors instead of treating partial content as completed', async () => {
    await expect(readChatStream(response(['data: {"error":{"message":"failed"}}\n\n']), () => {}, 1000)).rejects.toThrow('provider');
  });
});
