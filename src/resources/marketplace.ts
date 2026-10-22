import path from 'node:path';
import { readFileSafe, writeFile, pathExists, listDirs } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

// ─── Marketplace refresh ────────────────────────────────
//
//  When the team repo contains .codebuddy-plugin/marketplace.json,
//  push of skills keeps the plugins list in sync, and a plugins/ directory
//  of full CodeBuddy plugins is registered alongside them.
//
//  Strategy: read existing marketplace.json → rebuild the entries teamai
//  manages from the actual skills/ and plugins/ directories → write back
//  if changed.
//
//  Only strict:false entries whose source points at ./skills/ or ./plugins/
//  are auto-managed. Every other entry is left alone.

const MARKETPLACE_PATH = '.codebuddy-plugin/marketplace.json';
const SKILL_MD = 'SKILL.md';
const SKILLS_DIR = 'skills';
const PLUGINS_DIR = 'plugins';
const PLUGIN_MANIFEST = path.join('.codebuddy-plugin', 'plugin.json');
const SKILL_SOURCE_PREFIX = './skills/';
const PLUGIN_SOURCE_PREFIX = './plugins/';

interface MarketplacePlugin {
  name: string;
  source: string;
  description: string;
  version: string;
  category?: string;
  keywords?: string[];
  strict: false;
  [key: string]: unknown;
}

interface MarketplaceJson {
  name: string;
  description: string;
  version: string;
  owner: { name: string; email: string };
  plugins: MarketplacePlugin[];
  [key: string]: unknown;
}

interface CodeBuddyPluginManifest {
  name?: unknown;
  description?: unknown;
  version?: unknown;
}

/**
 * Extract the description from a SKILL.md frontmatter.
 * Reads the YAML frontmatter between --- delimiters.
 */
async function extractSkillDescription(skillDir: string): Promise<string> {
  const skillMdPath = path.join(skillDir, SKILL_MD);
  const content = await readFileSafe(skillMdPath);
  if (!content) return '';

  const { data } = parseFrontmatter(content);
  const desc = data['description'];
  if (!desc) return '';

  return String(desc).replace(/\s+/g, ' ').trim();
}

/**
 * Read one plugin directory into its marketplace entry, or null when the
 * directory holds no plugin manifest. The entry name follows the manifest so
 * a renamed directory still registers under the plugin's own name.
 */
async function extractPluginEntry(repoPath: string, dir: string): Promise<MarketplacePlugin | null> {
  const manifestPath = path.join(repoPath, PLUGINS_DIR, dir, PLUGIN_MANIFEST);
  const raw = await readFileSafe(manifestPath);
  if (!raw) return null;

  let manifest: CodeBuddyPluginManifest;
  try {
    manifest = JSON.parse(raw) as CodeBuddyPluginManifest;
  } catch {
    log.warn(`Failed to parse ${manifestPath}, skipping that plugin`);
    return null;
  }

  const name = typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : dir;
  const description = typeof manifest.description === 'string'
    ? manifest.description.replace(/\s+/g, ' ').trim()
    : '';
  const version = typeof manifest.version === 'string' && manifest.version.trim()
    ? manifest.version.trim()
    : '1.0.0';

  return {
    name,
    source: `./${PLUGINS_DIR}/${dir}`,
    description: description || `${name} plugin`,
    version,
    strict: false,
  };
}

function managedBy(source: unknown, prefix: string): boolean {
  return typeof source === 'string' && source.startsWith(prefix);
}

/**
 * Refresh .codebuddy-plugin/marketplace.json to reflect the current skills/
 * and plugins/ state. Only entries teamai manages are touched.
 *
 * - New skills in skills/ → added with a default entry
 * - Removed skills → entry removed from the array
 * - New plugins in plugins/ → added from their plugin.json
 * - Removed plugins → entry removed from the array
 * - Existing entries → description and version refreshed from the source
 *
 * Returns true if the file was modified, false if no changes needed.
 * Returns false (no-op) if marketplace.json does not exist.
 */
export async function refreshMarketplace(repoPath: string): Promise<boolean> {
  const marketplacePath = path.join(repoPath, MARKETPLACE_PATH);
  if (!await pathExists(marketplacePath)) {
    return false;
  }

  const raw = await readFileSafe(marketplacePath);
  if (!raw) return false;

  let marketplace: MarketplaceJson;
  try {
    marketplace = JSON.parse(raw) as MarketplaceJson;
  } catch {
    log.warn('Failed to parse marketplace.json, skipping refresh');
    return false;
  }

  if (!Array.isArray(marketplace.plugins)) return false;

  // Collect current skill names from skills/ directory (flat layout only,
  // namespaced skills are not registered in marketplace).
  const skillsDir = path.join(repoPath, SKILLS_DIR);
  const currentSkills = new Set<string>();
  for (const dir of await listDirs(skillsDir)) {
    if (await pathExists(path.join(skillsDir, dir, SKILL_MD))) currentSkills.add(dir);
  }

  // Collect the full plugins a team puts in plugins/<name>/. A directory
  // without .codebuddy-plugin/plugin.json is not a plugin and stays out.
  const pluginsDir = path.join(repoPath, PLUGINS_DIR);
  const currentPlugins = new Map<string, MarketplacePlugin>();
  for (const dir of (await listDirs(pluginsDir)).sort()) {
    const entry = await extractPluginEntry(repoPath, dir);
    if (!entry) continue;
    if (currentPlugins.has(entry.name)) {
      log.warn(`plugins/${dir} registers "${entry.name}" again; keeping the last directory`);
    }
    currentPlugins.set(entry.name, entry);
  }

  const nonAutoPlugins: MarketplacePlugin[] = [];
  const unmanagedAutoPlugins: MarketplacePlugin[] = [];
  const existingSkills = new Map<string, MarketplacePlugin>();
  const existingPlugins = new Map<string, MarketplacePlugin>();
  for (const plugin of marketplace.plugins) {
    if (plugin.strict !== false) {
      nonAutoPlugins.push(plugin);
    } else if (managedBy(plugin.source, SKILL_SOURCE_PREFIX)) {
      existingSkills.set(plugin.name, plugin);
    } else if (managedBy(plugin.source, PLUGIN_SOURCE_PREFIX)) {
      existingPlugins.set(plugin.name, plugin);
    } else {
      // strict:false, but not a source teamai writes. Keep it.
      unmanagedAutoPlugins.push(plugin);
    }
  }

  let changed = false;
  const updatedSkills: MarketplacePlugin[] = [];
  const updatedPlugins: MarketplacePlugin[] = [];

  // Update existing entries and add new skills
  for (const skillName of currentSkills) {
    const existing = existingSkills.get(skillName);
    if (existing) {
      // Refresh description from SKILL.md
      const desc = await extractSkillDescription(path.join(skillsDir, skillName));
      if (desc && desc !== existing.description) {
        existing.description = desc;
        changed = true;
      }
      updatedSkills.push(existing);
      existingSkills.delete(skillName);
    } else {
      // New skill — add with default entry
      const desc = await extractSkillDescription(path.join(skillsDir, skillName));
      updatedSkills.push({
        name: skillName,
        source: `./${SKILLS_DIR}/${skillName}`,
        description: desc || `${skillName} skill`,
        version: '1.0.0',
        strict: false,
      });
      changed = true;
      log.debug(`Added ${skillName} to marketplace.json`);
    }
  }

  // Update existing entries and add new plugins
  for (const [name, entry] of currentPlugins) {
    const existing = existingPlugins.get(name);
    if (existing) {
      if (existing.description !== entry.description
        || existing.version !== entry.version
        || existing.source !== entry.source) {
        existing.description = entry.description;
        existing.version = entry.version;
        existing.source = entry.source;
        changed = true;
      }
      updatedPlugins.push(existing);
      existingPlugins.delete(name);
    } else {
      updatedPlugins.push(entry);
      changed = true;
      log.debug(`Added ${name} to marketplace.json`);
    }
  }

  // Remaining entries are skills or plugins that were removed.
  if (existingSkills.size > 0 || existingPlugins.size > 0) {
    changed = true;
    for (const name of [...existingSkills.keys(), ...existingPlugins.keys()]) {
      log.debug(`Removed ${name} from marketplace.json`);
    }
  }

  // A marketplace entry name must be unique. A plugin is the fuller artifact,
  // so it wins over the auto-generated skill entry of the same name.
  const pluginNames = new Set(updatedPlugins.map((entry) => entry.name));
  const keptSkills = updatedSkills.filter((entry) => {
    if (!pluginNames.has(entry.name)) return true;
    log.warn(`plugins/${entry.name} replaces the skill entry of the same name in marketplace.json`);
    changed = true;
    return false;
  });

  if (!changed) return false;

  // Sort by name for stable output
  keptSkills.sort((a, b) => a.name.localeCompare(b.name));
  updatedPlugins.sort((a, b) => a.name.localeCompare(b.name));

  // Merge: unmanaged entries first, then what teamai manages
  marketplace.plugins = [...nonAutoPlugins, ...unmanagedAutoPlugins, ...keptSkills, ...updatedPlugins];

  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
  log.debug(`Refreshed marketplace.json (${keptSkills.length} skills, ${updatedPlugins.length} plugins)`);
  return true;
}
