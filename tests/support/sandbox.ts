// A private temp root per test: heeded's every root (home, Claude Code's config dir, the cache) points inside it, and
// PATH holds only the sandbox's bin, with node linked in, so the real `claude` can never be reached (npm installs it
// next to node).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'heeded-')));
  after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const configDir = join(home, '.claude');
  const cacheDir = join(home, '.cache');
  const bin = join(root, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir, TZ: 'UTC', PATH: bin };
  return { root, configDir, cacheDir, bin, env };
}
