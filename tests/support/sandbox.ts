// A private temp root per test: heeded's every root (home, Claude Code's config dir, the cache) points inside it, and
// PATH holds only the sandbox's bin and node's own folder, so the real `claude` can never be reached.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir, TZ: 'UTC',
    PATH: `${bin}:${dirname(process.execPath)}` };
  return { root, home, configDir, cacheDir, bin, env };
}
