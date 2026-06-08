// Shared Claude CLI plumbing (uses your Claude Max plan via the headless `claude`
// binary). Used by both the DM personalizer and the inbound content generator.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);

export async function runClaude(prompt, { bin = 'claude', model, timeout = 120000 } = {}) {
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  const { stdout } = await pexecFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

// Strip artifacts an LLM sometimes adds despite "output only the text": code
// fences, a leading "Sure, here's…:" preamble line, and wrapping quotes.
export function sanitize(text) {
  if (!text) return text;
  let s = text.trim();
  s = s.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  s = s.replace(/^(sure[,!]?|here(?:['’]s| is)|certainly[,!]?|of course[,!]?)[^\n]*:\s*\n+/i, '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('“') && s.endsWith('”')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}
