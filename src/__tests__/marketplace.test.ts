import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshMarketplace } from '../resources/marketplace.js';

describe('refreshMarketplace', () => {
  let repo: string;

  const manifestPath = (): string => path.join(repo, '.codebuddy-plugin', 'marketplace.json');

  function writeMarketplace(plugins: unknown[]): void {
    fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
    fs.writeFileSync(manifestPath(), JSON.stringify({
      name: 'team',
      description: 'team marketplace',
      version: '1.0.0',
      owner: { name: 'team', email: 'team@example.test' },
      plugins,
    }, null, 2) + '\n');
  }

  function readPlugins(): unknown[] {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')).plugins as unknown[];
  }

  function writePlugin(dir: string, manifest: Record<string, unknown>): void {
    const pluginDir = path.join(repo, 'plugins', dir, '.codebuddy-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-marketplace-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('registers a plugins/ directory as a marketplace entry', async () => {
    writeMarketplace([]);
    writePlugin('herdr-codebuddy', {
      name: 'herdr-codebuddy',
      version: '1.0.0',
      description: 'Report agent state to Herdr',
    });

    expect(await refreshMarketplace(repo)).toBe(true);
    expect(readPlugins()).toEqual([{
      name: 'herdr-codebuddy',
      source: './plugins/herdr-codebuddy',
      description: 'Report agent state to Herdr',
      version: '1.0.0',
      strict: false,
    }]);
  });

  it('refreshes a plugin version and removes one that left plugins/', async () => {
    writeMarketplace([{
      name: 'herdr-codebuddy',
      source: './plugins/herdr-codebuddy',
      description: 'old description',
      version: '1.0.0',
      strict: false,
    }]);
    writePlugin('herdr-codebuddy', {
      name: 'herdr-codebuddy',
      version: '2.0.0',
      description: 'new description',
    });

    expect(await refreshMarketplace(repo)).toBe(true);
    expect(readPlugins()).toEqual([{
      name: 'herdr-codebuddy',
      source: './plugins/herdr-codebuddy',
      description: 'new description',
      version: '2.0.0',
      strict: false,
    }]);

    fs.rmSync(path.join(repo, 'plugins'), { recursive: true, force: true });
    expect(await refreshMarketplace(repo)).toBe(true);
    expect(readPlugins()).toEqual([]);
  });

  it('leaves entries teamai does not manage alone', async () => {
    const plugins = [
      {
        name: 'hand-written',
        source: './hand-written',
        description: 'x',
        version: '1.0.0',
        strict: false,
      },
      {
        name: 'fixed',
        source: './fixed',
        description: 'x',
        version: '1.0.0',
        strict: true,
      },
    ];
    writeMarketplace(plugins);

    expect(await refreshMarketplace(repo)).toBe(false);
    expect(readPlugins()).toEqual(plugins);
  });

  it('keeps a plugin entry over a skill of the same name', async () => {
    writeMarketplace([]);
    const skillDir = path.join(repo, 'skills', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: review skill\n---\n');
    writePlugin('review', { name: 'review', version: '3.0.0', description: 'review plugin' });

    expect(await refreshMarketplace(repo)).toBe(true);
    expect(readPlugins()).toEqual([{
      name: 'review',
      source: './plugins/review',
      description: 'review plugin',
      version: '3.0.0',
      strict: false,
    }]);
  });

  it('removes an existing duplicate skill entry when a plugin shadows it', async () => {
    const skillEntry = {
      name: 'review',
      source: './skills/review',
      description: 'review skill',
      version: '1.0.0',
      strict: false,
    };
    const pluginEntry = {
      name: 'review',
      source: './plugins/review',
      description: 'review plugin',
      version: '3.0.0',
      strict: false,
    };
    writeMarketplace([skillEntry, pluginEntry]);
    const skillDir = path.join(repo, 'skills', 'review');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: review skill\n---\n');
    writePlugin('review', { name: 'review', version: '3.0.0', description: 'review plugin' });

    expect(await refreshMarketplace(repo)).toBe(true);
    expect(readPlugins()).toEqual([pluginEntry]);
  });
});
