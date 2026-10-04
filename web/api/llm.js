// LLM proxy: forwards chat-completion requests with the USER's own free API key.
// The key arrives per request and is never stored or logged server-side.
// Body: { provider: 'groq'|'openrouter'|'gemini', apiKey, model, messages, maxTokens?, json? }
// Returns: { text }
const PROVIDERS = {
  groq: (key) => ({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { Authorization: `Bearer ${key}` },
    openai: true,
  }),
  openrouter: (key) => ({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://morningbrief.app', 'X-Title': 'Morning Brief' },
    openai: true,
  }),
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
  const { provider, apiKey, model, messages, maxTokens = 600, json = true } = body;
  if (!apiKey) return res.status(400).json({ error: 'An API key is required.' });

  try {
    let text;
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent`;
      const contents = (messages || [])
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const system = (messages || []).find((m) => m.role === 'system');
      const payload = { contents, generationConfig: { maxOutputTokens: maxTokens } };
      if (json) payload.generationConfig.responseMimeType = 'application/json';
      if (system) payload.systemInstruction = { parts: [{ text: system.content }] };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
      text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    } else {
      const p = PROVIDERS[provider];
      if (!p) return res.status(400).json({ error: `Unknown provider: ${provider}` });
      const cfg = p(apiKey);
      const payload = {
        model: model || (provider === 'groq' ? 'openai/gpt-oss-20b' : 'meta-llama/llama-3.3-70b-instruct:free'),
        messages,
        max_tokens: maxTokens,
      };
      if (json) payload.response_format = { type: 'json_object' };
      const r = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cfg.headers },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `${provider} error ${r.status}`);
      text = data.choices?.[0]?.message?.content || '';
    }
    if (!text) throw new Error('The model returned no text.');
    return res.status(200).json({ text });
  } catch (err) {
    const msg = String(err.message || err);
    const status = /401|unauthorized|invalid.*key|incorrect api key/i.test(msg) ? 401 : 502;
    return res.status(status).json({ error: msg.slice(0, 300) });
  }
}
