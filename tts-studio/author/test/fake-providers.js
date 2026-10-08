import http from 'node:http';

/**
 * Stand-ins for model providers, in the test process: an OpenAI-style server (OpenAI, Groq,
 * LM Studio...), Ollama's own API and Anthropic's Messages API. Nothing reaches the network.
 *
 * What they answer depends on the model asked for:
 *   json-only     refuses a JSON schema, takes JSON mode
 *   cutoff        stops at its length limit
 *   badjson-once  answers prose first, then JSON
 *   busy          a 429 once, then answers
 *   daily         always a 429 naming a daily limit
 *   blind         refuses pictures
 *   tiny          (Ollama) a 4096-token context
 *   anything else answers with what `answer(request)` returns
 *
 * Every request is kept in `requests`.
 */
export async function fakeProviders({ answer = () => ({ word: 'ready' }) } = {}) {
  const requests = [];
  const seen = new Map();
  const once = (key) => {
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n === 1;
  };
  const read = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => resolve(body ? JSON.parse(body) : null));
  });
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };
  // What a request showed the model: its text, and whether a picture or a PDF came with it.
  const look = (messages) => {
    const user = messages.find((m) => m.role === 'user');
    const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: user.content }];
    return {
      text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n'),
      image: parts.some((p) => p.type === 'image_url' || p.type === 'image') || !!user.images?.length,
      pdf: parts.some((p) => p.type === 'file' || p.type === 'document'),
    };
  };
  const reply = (seenBy) => {
    if (/colour/.test(seenBy.text)) return { word: seenBy.image ? 'red' : 'none' };
    if (/word is written in the PDF/.test(seenBy.text)) return { word: seenBy.pdf ? 'PINEAPPLE' : 'none' };
    return answer(seenBy);
  };

  const server = http.createServer(async (req, res) => {
    const body = req.method === 'POST' ? await read(req) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    // ---- OpenAI style ----
    if (req.url === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'gpt-test', object: 'model', context_window: 131072 }, { id: 'json-only', object: 'model' }] });
    if (req.url === '/v1/chat/completions') {
      const m = body.model;
      if (m === 'daily') return send(res, 429, { error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 100000.' } }, { 'retry-after': '0' });
      if (m === 'busy' && once('busy')) return send(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
      if (m === 'json-only' && body.response_format?.type === 'json_schema') return send(res, 400, { error: { message: "response_format 'json_schema' is not supported by this model" } });
      if (m === 'json-only' && body.reasoning_effort) return send(res, 400, { error: { message: 'reasoning_effort is not supported' } });
      const seenBy = look(body.messages);
      if (m === 'blind' && seenBy.image) return send(res, 400, { error: { message: 'This model does not support image input' } });
      let content = JSON.stringify(reply(seenBy));
      if (m === 'badjson-once' && once('badjson')) content = 'Sure! Here is the lesson you asked for.';
      return send(res, 200, {
        id: 'x', object: 'chat.completion', model: m, created: 1,
        choices: [{ index: 0, finish_reason: m === 'cutoff' ? 'length' : 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
      });
    }

    // ---- Ollama ----
    if (req.url === '/api/tags') return send(res, 200, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'tiny', model: 'tiny' }] });
    if (req.url === '/api/show') return send(res, 200, { model_info: { 'qwen3.context_length': body.model === 'tiny' ? 4096 : 40960 }, capabilities: ['completion'] });
    if (req.url === '/api/chat') {
      const seenBy = look(body.messages);
      return send(res, 200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(reply(seenBy)) }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 250, total_duration: 2_000_000_000 });
    }

    // ---- Anthropic ----
    if (req.url.startsWith('/v1/models')) return send(res, 200, { data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
    if (req.url.startsWith('/v1/messages')) {
      if (!req.headers['x-api-key']) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      const seenBy = look(body.messages);
      const text = JSON.stringify(reply(seenBy));
      const stop = body.model === 'cutoff' ? 'max_tokens' : 'end_turn';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 800, output_tokens: 1, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 400 } });
      ev('message_stop', {});
      return res.end();
    }
    send(res, 404, { error: 'no such route' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
