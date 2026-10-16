// Gemini free-tier client (Google AI Studio key, x-goog-api-key header).
// Free-tier limits verified live 2026-10-06 (per project, not per key):
//   gemini-3.1-flash-lite / gemini-3.5-flash-lite: 15 RPM, 250K TPM, 500 RPD
//   Other Flash models: 5 RPM / 20 RPD (too small). Pro: unavailable on free tier.
// Caveat: free-tier content may be used to improve Google products -> UI must warn
// users not to enter private data.
// Request/response shape follows https://ai.google.dev/gemini-api/docs/text-generation
// and is UNVERIFIED until the first live call; if usage metadata is absent we keep
// the full reservation (fail closed, per audit).

export const MODEL_POOL = [
  { id: 'gemini-3.1-flash-lite', rpm: 15, tpm: 250000, rpd: 500 },
  { id: 'gemini-3.5-flash-lite', rpm: 15, tpm: 250000, rpd: 500 },
  // Gemma fallback: 30 RPM / 16K TPM / 14.4K RPD, API id NOT yet verified - do not
  // enable until the id is confirmed live.
];

export class GeminiClient {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('GeminiClient requires an API key');
    this.apiKey = apiKey;
    // workerd throws TypeError "Illegal invocation" when global fetch is called as
    // a method (this = client). Bind to undefined so the call matches a bare fetch().
    // (This was the real cause of the 2026-10-07 "Workers egress" failure.)
    this.fetch = fetchImpl.bind(undefined);
  }

  // Returns { text, usage: { totalTokens } | null }
  async generate(model, prompt, { maxOutputTokens = 800 } = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await this.fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens, temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Gemini failed: ${body?.error?.message || 'HTTP ' + res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const total = body?.usageMetadata?.totalTokenCount;
    return { text, usage: Number.isInteger(total) ? { totalTokens: total } : null };
  }
}
