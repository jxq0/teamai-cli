import path from 'node:path';

import { formatCommand, type CommandExecutor } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';
import type {
  CodeBuddyEcosystem,
  CodeBuddyMarketplace,
  CodeBuddyMarketplaceLock,
  CodeBuddyPluginLock,
  PackageStatus,
} from '../types.js';
import {
  PackageAdapter,
  type PackageInstallContext,
} from './base.js';

export interface CodeBuddyPluginListItem {
  id?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
}

export interface CodeBuddyMarketplaceListItem {
  name?: string;
  type?: string;
  description?: string;
}

export interface CodeBuddyLockSection {
  marketplaces: CodeBuddyMarketplaceLock[];
  plugins: CodeBuddyPluginLock[];
}

/** Raised when the CodeBuddy CLI is absent, so a pull can skip it quietly. */
export class CodeBuddyCliUnavailableError extends Error {
  constructor() {
    super('CodeBuddy plugin CLI is unavailable. Install or upgrade CodeBuddy, then retry.');
    this.name = 'CodeBuddyCliUnavailableError';
  }
}

/**
 * A nested CodeBuddy CLI inherits the parent session's service port and tries
 * to bind it, which fails with EADDRINUSE. Dropping the two variables that
 * point the child at the parent's server lets the plugin commands run.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SERVER__PORT;
  delete env.CODEBUDDY_SERVICE_PROXY_URL;
  return env;
}

function looksLocal(source: string): boolean {
  return path.isAbsolute(source) || /^\.{1,2}[\\/]/.test(source) || /^[a-zA-Z]:[\\/]/.test(source);
}

function sameSource(declared: string, actual: string, cwd: string): boolean {
  if (looksLocal(declared) || looksLocal(actual)) {
    return path.resolve(cwd, declared) === path.resolve(cwd, actual);
  }
  return declared.replace(/[\\/]+$/, '') === actual.replace(/[\\/]+$/, '');
}

function parseJsonArray<T>(stdout: string): T[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
  return parsed as T[];
}

export class CodeBuddyPluginAdapter extends PackageAdapter<CodeBuddyEcosystem, CodeBuddyLockSection> {
  readonly ecosystem = 'codebuddy' as const;

  constructor(executor?: CommandExecutor) {
    super(executor);
  }

  async detect(_cwd: string): Promise<boolean> {
    try {
      const result = await this.execute('codebuddy', ['plugin', '--help'], {
        timeoutMs: 5_000,
        env: childEnv(),
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async queryPlugins(): Promise<CodeBuddyPluginListItem[]> {
    try {
      const result = await this.execute('codebuddy', ['plugin', 'list', '--json'], {
        timeoutMs: 30_000,
        env: childEnv(),
      });
      if (result.code !== 0 || !result.stdout.trim()) return [];
      return parseJsonArray<CodeBuddyPluginListItem>(result.stdout);
    } catch {
      return [];
    }
  }

  private async queryMarketplaces(): Promise<CodeBuddyMarketplaceListItem[]> {
    try {
      const result = await this.execute('codebuddy', ['plugin', 'marketplace', 'list'], {
        timeoutMs: 30_000,
        env: childEnv(),
      });
      if (result.code !== 0 || !result.stdout.trim()) return [];
      return parseJsonArray<CodeBuddyMarketplaceListItem>(result.stdout);
    } catch {
      return [];
    }
  }

  async registeredMarketplaces(): Promise<CodeBuddyMarketplaceListItem[]> {
    return this.queryMarketplaces();
  }

  /** Where a declaration resolves to: its repo, or the team repository checkout. */
  private sourceFor(marketplace: CodeBuddyMarketplace, context: PackageInstallContext): string {
    const source = marketplace.repo ?? context.teamRepoPath;
    if (!source) {
      throw new Error(
        `CodeBuddy marketplace "${marketplace.name}" has no repo and no team repository checkout was found`,
      );
    }
    return source;
  }

  private async run(
    action: string,
    args: string[],
    context: PackageInstallContext,
    timeoutMs: number,
  ): Promise<void> {
    const result = await this.execute('codebuddy', args, {
      cwd: context.cwd,
      env: childEnv(),
      timeoutMs,
      stream: true,
    });
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim());
      throw new Error(
        `CodeBuddy ${action} failed (exit ${result.code}): ${detail}`,
      );
    }
  }

  async snapshot(
    declaration: CodeBuddyEcosystem,
    context: PackageInstallContext,
  ): Promise<CodeBuddyLockSection> {
    const [marketplaces, plugins] = await Promise.all([
      this.queryMarketplaces(),
      this.queryPlugins(),
    ]);
    const declaredMarketplaces = new Map(
      declaration.marketplaces.map((item) => [item.name, item]),
    );
    const declaredPlugins = new Set(declaration.plugins.map((item) => item.name));

    return {
      marketplaces: marketplaces.flatMap((item) => {
        const declared = item.name ? declaredMarketplaces.get(item.name) : undefined;
        if (!item.name || !declared) return [];
        const repo = declared.repo ?? context.teamRepoPath;
        return [{
          name: item.name,
          ...(item.type ? { source: item.type } : {}),
          ...(repo ? { repo } : {}),
        }];
      }),
      plugins: plugins.flatMap((item) => {
        if (!item.id || !declaredPlugins.has(item.id)) return [];
        return [{
          id: item.id,
          version: item.version ?? 'unknown',
          scope: item.scope ?? 'user',
          enabled: item.enabled ?? true,
          ...(item.installPath ? { installPath: item.installPath } : {}),
        }];
      }),
    };
  }

  async install(
    declaration: CodeBuddyEcosystem,
    context: PackageInstallContext,
  ): Promise<CodeBuddyLockSection> {
    if (declaration.marketplaces.length === 0 && declaration.plugins.length === 0) {
      return { marketplaces: [], plugins: [] };
    }

    if (context.dryRun) {
      for (const marketplace of declaration.marketplaces) {
        const source = this.sourceFor(marketplace, context);
        log.info(`[dry-run] Would run: ${formatCommand('codebuddy', [
          'plugin', 'marketplace', 'add', source, '-n', marketplace.name,
        ])}`);
      }
      for (const plugin of declaration.plugins) {
        log.info(`[dry-run] Would run: ${formatCommand('codebuddy', [
          'plugin', 'install', plugin.name, '--scope', plugin.scope ?? context.scope,
        ])}`);
      }
      return { marketplaces: [], plugins: [] };
    }

    if (!await this.detect(context.cwd)) throw new CodeBuddyCliUnavailableError();

    const registered = new Map(
      (await this.queryMarketplaces()).flatMap(
        (item) => item.name ? [[item.name, item] as const] : [],
      ),
    );
    const previous = new Map(
      (context.previousPackages?.codebuddy?.marketplaces ?? [])
        .map((item) => [item.name, item] as const),
    );

    for (const marketplace of declaration.marketplaces) {
      const source = this.sourceFor(marketplace, context);
      const installed = registered.get(marketplace.name);
      const earlier = previous.get(marketplace.name);
      const sourceChanged = !!earlier?.repo && !sameSource(earlier.repo, source, context.cwd);

      if (installed && sourceChanged) {
        await this.run(
          `marketplace remove "${marketplace.name}"`,
          ['plugin', 'marketplace', 'remove', marketplace.name],
          context,
          120_000,
        );
      }
      if (!installed || sourceChanged) {
        await this.run(
          `marketplace add "${marketplace.name}"`,
          ['plugin', 'marketplace', 'add', source, '-n', marketplace.name],
          context,
          120_000,
        );
      } else if (looksLocal(source)) {
        // A local (team repository) marketplace is a directory teamai owns:
        // re-read it so a version bump in the team repo is visible to install.
        await this.run(
          `marketplace update "${marketplace.name}"`,
          ['plugin', 'marketplace', 'update', marketplace.name],
          context,
          120_000,
        );
      }
    }

    for (const plugin of declaration.plugins) {
      await this.run(
        `plugin install "${plugin.name}"`,
        ['plugin', 'install', plugin.name, '--scope', plugin.scope ?? context.scope],
        context,
        120_000,
      );
    }

    return this.snapshot(declaration, context);
  }

  async status(
    declaration: CodeBuddyEcosystem,
    _context: PackageInstallContext,
  ): Promise<PackageStatus[]> {
    const installed = new Map(
      (await this.queryPlugins()).flatMap(
        (item) => item.id ? [[item.id, item] as const] : [],
      ),
    );
    return declaration.plugins.map((plugin) => {
      const actual = installed.get(plugin.name);
      const versionMismatch = plugin.version
        && actual?.version
        && actual.version !== 'unknown'
        && plugin.version !== actual.version;
      return {
        name: plugin.name,
        installed: !!actual && !versionMismatch,
        ...(actual?.version ? { version: actual.version } : {}),
        ...(actual ? { enabled: actual.enabled ?? true } : {}),
        ...(!actual
          ? { detail: 'declared but not installed' }
          : versionMismatch
            ? { detail: `declared ${plugin.version}, installed ${actual.version}` }
            : {}),
      };
    });
  }

  async marketplaceStatus(
    declaration: CodeBuddyEcosystem,
    _context: PackageInstallContext,
  ): Promise<PackageStatus[]> {
    const registered = new Map(
      (await this.queryMarketplaces()).flatMap(
        (item) => item.name ? [[item.name, item] as const] : [],
      ),
    );
    return declaration.marketplaces.map((marketplace) => {
      const actual = registered.get(marketplace.name);
      return {
        name: marketplace.name,
        installed: !!actual,
        detail: actual
          ? `${actual.type ?? 'unknown'} marketplace`
          : 'declared but not registered',
      };
    });
  }
}
