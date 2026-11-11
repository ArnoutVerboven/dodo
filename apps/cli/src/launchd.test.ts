import { describe, expect, it } from 'vitest';
import { stableNodePath } from './launchd.js';

describe('stableNodePath', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it("uses Homebrew's opt link instead of the versioned Cellar path", () => {
    expect(
      stableNodePath(
        '/opt/homebrew/Cellar/node/26.8.1/bin/node',
        has('/opt/homebrew/opt/node/bin/node'),
      ),
    ).toBe('/opt/homebrew/opt/node/bin/node');
  });

  it('keeps a versioned formula on its own line (node@22)', () => {
    expect(
      stableNodePath(
        '/usr/local/Cellar/node@22/22.11.0/bin/node',
        has('/usr/local/opt/node@22/bin/node'),
      ),
    ).toBe('/usr/local/opt/node@22/bin/node');
  });

  it('keeps the path when there is no opt link', () => {
    expect(stableNodePath('/opt/homebrew/Cellar/node/26.8.1/bin/node', has())).toBe(
      '/opt/homebrew/Cellar/node/26.8.1/bin/node',
    );
  });

  it('leaves other installs alone (nvm, the official installer)', () => {
    const nvm = '/Users/me/.nvm/versions/node/v22.11.0/bin/node';
    expect(stableNodePath(nvm, () => true)).toBe(nvm);
    expect(stableNodePath('/usr/local/bin/node', () => true)).toBe('/usr/local/bin/node');
  });
});
