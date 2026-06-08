// Minimal Anthropic Messages API caller (built-in fetch — no SDK dependency, in
// keeping with this project's zero-install core). Used by the content generator
// so quality posts/magnets/image-briefs can be produced HEADLESS in a container,
// where the interactive `claude` Max-plan CLI can't run.
//
// Requires ANTHROPIC_API_KEY. Model defaults to claude-opus-4-8.

export async function runAnthropic(prompt, { apiKey, model = 'claude-opus-4-8', system, maxTokens = 1024, timeout = 60000 } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  return (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
