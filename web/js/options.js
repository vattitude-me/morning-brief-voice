// The bring-your-own-key catalogues used by Settings.
//
// The daily briefing itself is built and voiced once per day on the server, so
// nothing here affects what you hear. These lists exist only for the two
// optional Settings panels: previewing a voice, and turning on AI summaries
// with your own provider key.

// ------------------------------------------------------------------ voices
// Voice ids look like "gemini:Kore" or "groq:tara".
export const VOICES = [
  // Gemini prebuilt voices, free tier on gemini-2.5-flash-preview-tts.
  { id: 'gemini:Kore', provider: 'gemini', name: 'Kore', accent: 'American', gender: 'female', description: 'Mid-range, expressive', recommended: true },
  { id: 'gemini:Charon', provider: 'gemini', name: 'Charon', accent: 'American', gender: 'male', description: 'Baritone, news-anchor' },
  { id: 'gemini:Puck', provider: 'gemini', name: 'Puck', accent: 'American', gender: 'male', description: 'High, conversational' },
  { id: 'gemini:Aoede', provider: 'gemini', name: 'Aoede', accent: 'American', gender: 'female', description: 'Alto, neutral' },
  { id: 'gemini:Fenrir', provider: 'gemini', name: 'Fenrir', accent: 'American', gender: 'male', description: 'Deep, calm' },
  { id: 'gemini:Leda', provider: 'gemini', name: 'Leda', accent: 'American', gender: 'female', description: 'Bright, warm' },
  // Orpheus voices through Groq's /audio/speech endpoint. Note: Groq hosts its
  // own voice names (not the upstream tara/leo set) and caps input at 200 chars.
  { id: 'groq:autumn', provider: 'groq', name: 'Autumn', accent: 'American', gender: 'female', description: 'Orpheus via Groq', recommended: true },
  { id: 'groq:diana', provider: 'groq', name: 'Diana', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
  { id: 'groq:hannah', provider: 'groq', name: 'Hannah', accent: 'American', gender: 'female', description: 'Orpheus via Groq' },
  { id: 'groq:austin', provider: 'groq', name: 'Austin', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
  { id: 'groq:daniel', provider: 'groq', name: 'Daniel', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
  { id: 'groq:troy', provider: 'groq', name: 'Troy', accent: 'American', gender: 'male', description: 'Orpheus via Groq' },
];

export const LLM_PROVIDERS = {
  groq: { label: 'Groq', models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], keyLabel: 'Groq API key', keyUrl: 'https://console.groq.com/keys' },
  gemini: { label: 'Gemini', models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'], keyLabel: 'Gemini API key', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', models: ['meta-llama/llama-3.3-70b-instruct:free'], keyLabel: 'OpenRouter API key', keyUrl: 'https://openrouter.ai/keys' },
};
