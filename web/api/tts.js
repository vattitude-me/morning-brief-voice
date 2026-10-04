// TTS proxy: turns text into speech with the USER's own free API key.
// The key arrives per request and is never stored or logged server-side.
// Body: { provider: 'gemini'|'groq', apiKey, text, voice, model? }
// Returns audio bytes (audio/wav). Gemini returns raw PCM which we wrap in a
// WAV header here so the browser can play it directly.

// Minimal WAV writer for 16-bit mono PCM.
function pcmToWav(pcm, sampleRate = 24000) {
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length, 40);
  Buffer.from(pcm).copy(buf, 44);
  return buf;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
  const { provider, apiKey, text, voice } = body;
  if (!apiKey) return res.status(400).json({ error: 'An API key is required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text to speak.' });
  if (text.length > 4000) return res.status(400).json({ error: 'Text is too long for one request (4000 chars max).' });

  try {
    let audio;
    if (provider === 'gemini') {
      const model = body.model || 'gemini-2.5-flash-preview-tts';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } },
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
      const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) throw new Error('Gemini returned no audio.');
      audio = pcmToWav(Buffer.from(b64, 'base64'), 24000);
    } else if (provider === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: body.model || 'canopylabs/orpheus-v1-english',
          input: text,
          voice: voice || 'tara',
          response_format: 'wav',
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Groq error ${r.status}`);
      }
      audio = Buffer.from(await r.arrayBuffer());
    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (err) {
    const msg = String(err.message || err);
    const status = /401|unauthorized|invalid.*key|incorrect api key/i.test(msg) ? 401 : 502;
    return res.status(status).json({ error: msg.slice(0, 300) });
  }
}
