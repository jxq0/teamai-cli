import { z } from 'zod';

export const PackageScopeSchema = z.enum(['user', 'project', 'local']);
export type PackageScope = z.infer<typeof PackageScopeSchema>;

export const NpmSpecSchema = z.object({
  name: z.string().min(1).refine((name) => !/\s/.test(name), {
    message: 'npm package name must not contain whitespace',
  }),
  version: z.string().min(1).default('*'),
  /** Install as a machine-wide CLI/tool instead of a project dependency. */
  global: z.boolean().optional(),
  /** Registry used for this package. Credentials must stay in npm config/env. */
  registry: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return !url.username
        && !url.password
        && ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }, {
    message: 'npm registry must be a valid http(s) URL without embedded credentials',
  }).optional(),
}).strict();

export const ClaudeMarketplaceSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1).optional(),
}).strict();

export const ClaudePluginSpecSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  scope: PackageScopeSchema.optional(),
}).strict();

export const ClaudeEcosystemSchema = z.object({
  marketplaces: z.array(ClaudeMarketplaceSchema).default([]),
  plugins: z.array(ClaudePluginSpecSchema).default([]),
}).strict();

/** A marketplace whose `repo` is omitted is the team repository itself. */
export const CodeBuddyMarketplaceSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
}).strict();

export const CodeBuddyPluginSpecSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  scope: PackageScopeSchema.optional(),
}).strict();

export const CodeBuddyEcosystemSchema = z.object({
  marketplaces: z.array(CodeBuddyMarketplaceSchema).default([]),
  plugins: z.array(CodeBuddyPluginSpecSchema).default([]),
}).strict();

export const PackageSetSchema = z.object({
  npm: z.array(NpmSpecSchema).optional(),
  claude: ClaudeEcosystemSchema.optional(),
  codebuddy: CodeBuddyEcosystemSchema.optional(),
}).strict();

interface PluginEcosystem {
  marketplaces: { name: string }[];
  plugins: { name: string }[];
}

/** Every plugin must name a declared marketplace, which is how it is resolved. */
function validatePluginEcosystem(
  ecosystem: PluginEcosystem | undefined,
  label: 'Claude' | 'CodeBuddy',
  field: 'claude' | 'codebuddy',
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, marketplace] of (ecosystem?.marketplaces ?? []).entries()) {
    if (names.has(marketplace.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages', field, 'marketplaces', index, 'name'],
        message: `duplicate ${label} marketplace "${marketplace.name}"`,
      });
    }
    names.add(marketplace.name);
  }

  for (const [index, plugin] of (ecosystem?.plugins ?? []).entries()) {
    const separator = plugin.name.lastIndexOf('@');
    const marketplace = separator > 0 ? plugin.name.slice(separator + 1) : '';
    if (!marketplace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages', field, 'plugins', index, 'name'],
        message: `${label} plugin name must use plugin@marketplace format`,
      });
    } else if (!names.has(marketplace)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages', field, 'plugins', index, 'name'],
        message: `${label} marketplace "${marketplace}" is not declared`,
      });
    }
  }
}

export const PackageManifestSchema = z.object({
  name: z.string().default(''),
  packages: PackageSetSchema.default({}),
}).superRefine((manifest, ctx) => {
  validatePluginEcosystem(manifest.packages.claude, 'Claude', 'claude', ctx);
  validatePluginEcosystem(manifest.packages.codebuddy, 'CodeBuddy', 'codebuddy', ctx);
});

export type NpmSpec = z.infer<typeof NpmSpecSchema>;
export type ClaudeMarketplace = z.infer<typeof ClaudeMarketplaceSchema>;
export type ClaudePluginSpec = z.infer<typeof ClaudePluginSpecSchema>;
export type ClaudeEcosystem = z.infer<typeof ClaudeEcosystemSchema>;
export type CodeBuddyMarketplace = z.infer<typeof CodeBuddyMarketplaceSchema>;
export type CodeBuddyPluginSpec = z.infer<typeof CodeBuddyPluginSpecSchema>;
export type CodeBuddyEcosystem = z.infer<typeof CodeBuddyEcosystemSchema>;
export type PackageSet = z.infer<typeof PackageSetSchema>;
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const NpmLockEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.literal('npm').default('npm'),
  global: z.boolean().optional(),
  registry: z.string().optional(),
  integrity: z.string().optional(),
  resolved: z.string().optional(),
});

export const ClaudeMarketplaceLockSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  installLocation: z.string().optional(),
});

export const ClaudePluginLockSchema = z.object({
  id: z.string(),
  version: z.string().default('unknown'),
  scope: PackageScopeSchema.or(z.string()).default('user'),
  enabled: z.boolean().default(true),
  installPath: z.string().optional(),
});

export const CodeBuddyMarketplaceLockSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  repo: z.string().optional(),
  installLocation: z.string().optional(),
});

export const CodeBuddyPluginLockSchema = z.object({
  id: z.string(),
  version: z.string().default('unknown'),
  scope: PackageScopeSchema.or(z.string()).default('user'),
  enabled: z.boolean().default(true),
  installPath: z.string().optional(),
});

export const PackageLockSchema = z.object({
  version: z.literal(1).default(1),
  /** Machine-wide declarations, or the complete declaration in project scope. */
  declarationHash: z.string().optional(),
  /** User-scope local npm declarations must be acknowledged once per cwd. */
  projectDeclarationHashes: z.record(z.string()).optional(),
  packages: z.object({
    npm: z.array(NpmLockEntrySchema).optional(),
    claude: z.object({
      marketplaces: z.array(ClaudeMarketplaceLockSchema).default([]),
      plugins: z.array(ClaudePluginLockSchema).default([]),
    }).optional(),
    codebuddy: z.object({
      marketplaces: z.array(CodeBuddyMarketplaceLockSchema).default([]),
      plugins: z.array(CodeBuddyPluginLockSchema).default([]),
    }).optional(),
  }).default({}),
});

export type NpmLockEntry = z.infer<typeof NpmLockEntrySchema>;
export type ClaudeMarketplaceLock = z.infer<typeof ClaudeMarketplaceLockSchema>;
export type ClaudePluginLock = z.infer<typeof ClaudePluginLockSchema>;
export type CodeBuddyMarketplaceLock = z.infer<typeof CodeBuddyMarketplaceLockSchema>;
export type CodeBuddyPluginLock = z.infer<typeof CodeBuddyPluginLockSchema>;
export type PackageLock = z.infer<typeof PackageLockSchema>;

export interface PackageStatus {
  name: string;
  installed: boolean;
  version?: string;
  enabled?: boolean;
  detail?: string;
}
