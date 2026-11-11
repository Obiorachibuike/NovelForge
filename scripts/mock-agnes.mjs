/**
 * Local mock of the Agnes AI OpenAI-compatible API for end-to-end testing.
 * Not part of the application — a test harness for the provider path.
 *
 *   node scripts/mock-agnes.mjs            # happy path, SSE streaming + JSON
 *   node scripts/mock-agnes.mjs --fail     # every request returns 500
 *   node scripts/mock-agnes.mjs --empty    # returns 200 with empty content
 *   node scripts/mock-agnes.mjs --delay=30000  # hold responses for 30s (slow provider)
 */
import http from 'node:http';

const FAIL = process.argv.includes('--fail');
const EMPTY = process.argv.includes('--empty');
const DELAY_ARG = process.argv.find(a => a.startsWith('--delay='));
const DELAY = DELAY_ARG ? Number(DELAY_ARG.split('=')[1]) || 0 : 0;
const PORT = Number(process.env.MOCK_AGNES_PORT || 8099);

let requestLog = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    requestLog.push({ url: req.url, model: parsed.model, stream: parsed.stream, messages: (parsed.messages || []).length });
    if (requestLog.length > 50) requestLog.shift();

    if (req.url === '/log') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(requestLog));
      return;
    }

    setTimeout(() => respond(parsed, res), DELAY);
  });
});

function respond(parsed, res) {
  if (FAIL) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock upstream failure' } }));
    return;
  }

  const content = EMPTY
    ? ''
    : 'The rain had stopped by the time she reached the bridge, but the stones still glistened like old wounds.\n\nShe pulled her collar higher and counted the arches — seven, just as the letter had said.\n\nSomewhere behind her, a door creaked open in a building that should have been empty for years.\n\n"You took your time," a voice said from the shadow of the pier.\n\nShe did not turn. Not yet.';

  const base = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: parsed.model || 'agnes-2.5-flash',
    usage: { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 },
  };

  if (parsed.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const pieces = content.match(/[\s\S]{1,24}/g) || [''];
    for (const piece of pieces) {
      res.write(
        `data: ${JSON.stringify({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      ...base,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
  );
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-agnes] listening on http://localhost:${PORT} (fail=${FAIL}, empty=${EMPTY}, delay=${DELAY}ms)`);
});
