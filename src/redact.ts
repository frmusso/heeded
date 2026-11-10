// Token-like runs (API keys, access tokens, hashes, blobs) become "…" before anything is sent or printed: instruction
// files and transcripts may hold them. Specific prefixes first, then the generic shapes.
const SECRETS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic keys
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe keys
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, // GitHub tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g, // long hex (hashes, secrets)
];
// Long base64-like runs: only when they mix digits, upper and lower case (paths and words don't).
const BLOB = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g;

export function redact(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, '…');
  return out.replace(BLOB, (run) => (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) ? '…' : run));
}
