import { guardedRenameSync, ownedArtifactRm, probeProcessAlive } from "./mutation-guard.mjs";
/**
 * Transactional npm self-update: stage -> verify -> swap -> rollback (#1942 / #1849).
 *
 * The legacy path ran `npm install -g` straight into the live global tree, so a
 * failure after npm removed the old files left a file-less package skeleton with no
 * recovery. This module stages the new version into a SIBLING directory of the live
 * package (same volume, so directory renames are atomic-ish and never cross devices),
 * verifies the staged tree with a manifest before anything live is touched, then swaps
 * live -> backup -> stage-into-live with a reverse-rename rollback on failure and a
 * recovery marker on double fault.
 *
 * Layout (siblings, never children — a child would travel WITH the live rename and the
 * live dir cannot move into its own subtree):
 *   <scopeDir>/opencodex                      live package
 *   <scopeDir>/.ocx-staging-<ts>/             npm --prefix root (contains node_modules/...)
 *   <scopeDir>/.ocx-backup-<ts>/opencodex     previous live tree during/after the swap
 *   <scopeDir>/.ocx-recovery.json             double-fault marker with a one-line restore
 *
 * A staging directory is created exclusively and immediately carries an ownership marker
 * (`.ocx-update-owner.json`). Later updates report leftovers but do not delete them: a marker
 * proves provenance only while this process owns the fresh path, not after another local
 * process could have replaced it. Other neighbouring entries are likewise left alone (#5624).
 */
import { probeSpawnSync } from "./mutation-guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isInMarkedPnpmCustomStore } from "./pnpm-store-layout.mjs";

/**
 * Dependency lookup confined to the candidate's OWN tree. This is the npm contract and it
 * must stay lexical: Node's resolver walks the ancestor directory chain, so a global npm
 * candidate at <prefix>/lib/node_modules/@scope/pkg could satisfy its bundled-Bun
 * requirement from <prefix>/lib/node_modules/bun, which belongs to a different package.
 * That verdict is not cosmetic — it accepts a stage that cannot start (D2), skips the
 * post-swap rollback, and lets bootRestoreProbe reap the only known-good backup.
 */
function candidateTreeDependencyDir(packageDir, name) {
  const dir = join(packageDir, "node_modules", ...name.split("/"));
  return existsSync(join(dir, "package.json")) ? dir : undefined;
}

/**
 * The candidate's own bun directory, whether or not it carries a readable package.json.
 * The size gate keys on the DIRECTORY, matching the pre-carry verifier: a half-extracted
 * node_modules/bun holding a truncated binary and no manifest is still a broken tree, and
 * bun is not always among the sentinels, so the sentinel loop cannot be relied on to catch it.
 */
function ownTreeBunDir(packageDir) {
  const dir = join(packageDir, "node_modules", "bun");
  return existsSync(dir) ? dir : undefined;
}

/** The node_modules directory a package sits directly inside, or undefined. */
function enclosingNodeModules(packageDir) {
  const parent = dirname(packageDir);
  if (basename(parent) === "node_modules") return parent;
  // Scoped packages live one level deeper: <node_modules>/@scope/name.
  const grandparent = dirname(parent);
  if (basename(parent).startsWith("@") && basename(grandparent) === "node_modules") return grandparent;
  return undefined;
}

/** pnpm's own bookkeeping at the root of a node_modules tree it manages. */
function isPnpmManagedRoot(nodeModulesDir) {
  if (!nodeModulesDir) return false;
  if (nodeModulesDir.split(/[\\/]/).includes(".pnpm")) return true;
  return existsSync(join(nodeModulesDir, ".pnpm")) || existsSync(join(nodeModulesDir, ".modules.yaml"));
}

/**
 * Containment is checked on canonical paths, with a separator boundary rather than a
 * string prefix so a sibling with a similar name cannot count as part of the store.
 */
function inside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Follow one link's own text component by component, as the operating system does. Collapsing ".."
 * first would hide a relay such as `../outside/relay/../../store/...`. A step down must land inside
 * an allowed root or on an ancestor of one (pnpm's relative links climb through those ancestors); a
 * step through another link before the last component is refused, because ".." after it would be
 * resolved from that link's target rather than from the spelling checked here.
 */
function followLinkText(linkPath, text, spellings) {
  const raw = String(text);
  const root = isAbsolute(raw) ? parse(raw).root : "";
  const parts = raw.slice(root.length).split(sep === "\\" ? /[\\/]+/ : /\/+/).filter(part => part && part !== ".");
  let current = root ? resolve(root) : dirname(linkPath);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "..") { current = dirname(current); continue; }
    current = join(current, parts[index]);
    if (!spellings.some(root => inside(current, root) || inside(root, current))) throw new Error("link is outside the selected store");
    if (index < parts.length - 1) {
      let stat;
      try { stat = lstatSync(current); } catch { throw new Error("link is outside the selected store"); }
      if (stat.isSymbolicLink()) throw new Error("link is outside the selected store");
    }
  }
  return current;
}

/** Resolve every link after entering a store; an external hop cannot vouch for a later return. */
function resolveStoreLinkChain(path, store, alias, alternateRoot, alternateAlias) {
  const roots = alternateRoot ? [store, alternateRoot] : [store];
  const spellings = [store, alias, alternateRoot, alternateAlias].filter(Boolean);
  const normalize = value => {
    const target = resolve(value);
    if (alias && inside(target, alias)) return resolve(store, relative(alias, target));
    if (alternateAlias && inside(target, alternateAlias)) return resolve(alternateRoot, relative(alternateAlias, target));
    return target;
  };
  let pending = normalize(path), hops = 0;
  for (;;) {
    const root = roots.find(candidate => inside(pending, candidate));
    if (!root) throw new Error("link is outside the selected store");
    const parts = relative(root, pending).split(sep).filter(Boolean);
    let prefix = root, changed = false;
    for (let index = 0; index < parts.length; index += 1) {
      prefix = join(prefix, parts[index]);
      if (!lstatSync(prefix).isSymbolicLink()) continue;
      if (++hops > 64) throw new Error("too many store link hops");
      const target = normalize(followLinkText(prefix, readlinkSync(prefix), spellings));
      if (!roots.some(candidate => inside(target, candidate))) throw new Error("link is outside the selected store");
      pending = resolve(target, ...parts.slice(index + 1));
      changed = true;
      break;
    }
    if (!changed) return prefix;
  }
}

/** "none" without a v<N>/links component, "isolated" when a .pnpm store sits below the last one, else "links". */
function linksComponentState(path) {
  const parts = String(path).split(/[\\/]+/);
  let links = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (/^links$/i.test(parts[i]) && /^v\d+$/i.test(parts[i - 1])) links = i;
  }
  if (links < 0) return "none";
  for (let i = links + 1; i < parts.length - 1; i += 1) {
    if (/^node_modules$/i.test(parts[i]) && /^\.pnpm$/i.test(parts[i + 1])) return "isolated";
  }
  return "links";
}

/** The spelling up to and including its last v<N>/links component, or null without one. */
function linksRoot(path) {
  const parts = String(path).split(/[\\/]+/);
  let links = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (/^links$/i.test(parts[i]) && /^v\d+$/i.test(parts[i - 1])) links = i;
  }
  return links < 0 ? null : parts.slice(0, links + 1).join(sep) || sep;
}

/** Retain intermediate spellings: realpath alone hides a links directory behind another symlink. */
function packagePathUsesGlobalLinks(packageDir, store, storeAlias = store) {
  let path = resolve(packageDir);
  let found = false;
  // Spellings with a v<N>/links component. Each classifies unless the package finally lands in an isolated
  // install (a node_modules/.pnpm store) inside that same links directory: an isolated group's top-level link
  // into its own .pnpm store is not a global-store link, while a link that leaves for anywhere else is.
  const linkRoots = [];
  for (let hop = 0; hop < 64; hop += 1) {
    if (store && (inside(path, store) || (storeAlias && inside(path, storeAlias)))) {
      resolveStoreLinkChain(path, store, storeAlias);
    }
    // Every effective spelling, the listed one first, is judged. The isolated-install exception covers the
    // default store/v<N>/links spelling too: a global-store link instance never contains node_modules/.pnpm
    // below its links directory.
    const state = linksComponentState(path);
    if (state === "links") linkRoots.push(linksRoot(path));
    found ||= state === "none" && Boolean(store && inside(path, join(store, "links")));
    // Store markers classify on every effective spelling, not only the final realpath, so a listed path below a
    // marked store whose package link points elsewhere still demands the store proof.
    found ||= isInMarkedPnpmCustomStore(path.replaceAll("\\", "/"), existsSync);
    const root = parse(path).root;
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    let prefix = root, changed = false;
    for (let i = 0; i < parts.length; i += 1) {
      prefix = join(prefix, parts[i]);
      if (lstatSync(prefix).isSymbolicLink()) {
        const target = resolve(dirname(prefix), readlinkSync(prefix));
        const remaining = parts.slice(i + 1);
        // Judge the effective spelling (target plus the rest of the path), so a package reached through a
        // group link classifies exactly as the same location reached directly.
        path = resolve(target, ...remaining);
        changed = true;
        break;
      }
    }
    // The joined spelling after a hop is judged at the top of the next iteration; the final location was
    // judged in this one (owner decision B: a package listed directly inside v<N>/links needs the proof).
    if (!changed) {
      const isolated = linksComponentState(path) === "isolated";
      return found || linkRoots.some(root => !(isolated && inside(path, root)));
    }
  }
  throw new Error("pnpm package symlink chain is too long");
}

/**
 * True unless this root spelling is canonical: no "." or ".." segment (path.resolve would delete them
 * without visiting the links they cross), no link or junction component, and realpath returns the same
 * path (case folded; a case-only symlink is caught by the component walk).
 */
function spellingHasLinkComponent(path) {
  const raw = String(path);
  const { root } = parse(raw);
  const parts = raw.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (!root || parts.some(part => part === "." || part === "..")) return true;
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  const fold = value => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return fold(realpathSync.native(raw)) !== fold(raw);
}

/**
 * Whether any spelling of this package passes through pnpm store links. This only classifies which
 * proof the updater must obtain; it never accepts a package. An unreadable chain throws.
 */
export function pnpmPackageUsesGlobalStoreLinks(packageDir) {
  if (packagePathUsesGlobalLinks(packageDir, undefined)) return true;
  // A configured virtual-store directory inside a custom store has no \`links\` component; pnpm's
  // store markers route it to the same store proof.
  return isInMarkedPnpmCustomStore(realpathSync(packageDir).replaceAll("\\", "/"), existsSync);
}

/**
 * Dependency roots this package INSTANCE owns. pnpm exposes dependencies in several shapes —
 * symlinks inside the package's own node_modules, a package root that is itself a symlink into
 * the virtual store, or a hoisted group root — so the npm rule alone rejects healthy trees.
 * Ownership is still bounded: an enclosing node_modules counts only when pnpm's own metadata
 * says pnpm manages it, or when the package's realpath group sits in pnpm's global virtual
 * store, which keeps an unrelated ancestor installation out.
 */
function ownedDependencyRoots(packageDir, store) {
  const roots = [];
  const add = dir => { if (dir && !roots.includes(dir)) roots.push(dir); };
  const lexicalGroup = enclosingNodeModules(packageDir);
  add(join(packageDir, "node_modules"));
  let real;
  try { real = realpathSync(packageDir); } catch { /* keep the lexical path only */ }
  if (real && real !== packageDir) add(join(real, "node_modules"));
  if (isPnpmManagedRoot(lexicalGroup)) add(lexicalGroup);
  const realGroup = real ? enclosingNodeModules(real) : undefined;
  if (isPnpmManagedRoot(realGroup) || (store && realGroup && inside(realGroup, store))) add(realGroup);
  return roots;
}

/**
 * pnpm dependency lookup. Probing the owned roots directly, rather than filtering whatever
 * Node's resolver returned, is deliberate: require.resolve reports the REALPATH of the
 * resolved file, so a dependency reached through pnpm's own node_modules symlink comes back
 * as a virtual-store path that no lexical ownership test can recognise. existsSync follows
 * the symlink, which is exactly the pnpm graph edge that proves ownership.
 */
function pnpmOwnedDependencyDir(packageDir, name, store, globalLinks, escaped, roots = ownedDependencyRoots(packageDir, store), storeAlias = store) {
  let matched;
  for (const root of roots) {
    const dir = join(root, ...name.split("/"));
    if (globalLinks) {
      if (name.startsWith("@") && name.includes("/")) {
        const scope = join(root, name.split("/")[0]);
        let scopeStat;
        try { scopeStat = lstatSync(scope); } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency link could not be resolved: " + name);
          continue;
        }
        if (scopeStat.isSymbolicLink()) {
          try { if (!inside(realpathSync(scope), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; } }
          catch { escaped.add("pnpm dependency link could not be resolved: " + name); continue; }
        }
      }
      try { lstatSync(dir); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency link could not be resolved: " + name);
        continue;
      }
      try {
        const realRoot = realpathSync(root);
        if (!inside(realRoot, store)) { escaped.add("pnpm dependency root is outside the selected store: " + name); continue; }
        if (!inside(realpathSync(dir), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; }
        if (!inside(resolveStoreLinkChain(join(realRoot, ...name.split("/")), store, storeAlias), store)) { escaped.add("pnpm dependency link escapes the selected store: " + name); continue; }
      } catch (error) {
        escaped.add(error?.message === "link is outside the selected store"
          ? "pnpm dependency link escapes the selected store: " + name : "pnpm dependency link could not be resolved: " + name);
        continue;
      }
    }
    if (globalLinks) {
      try {
        if (statSync(dir).isDirectory() && !existsSync(join(dir, "package.json"))) {
          escaped.add("pnpm dependency manifest could not be read: " + name); continue;
        }
      } catch { escaped.add("pnpm dependency link could not be resolved: " + name); continue; }
    }
    if (!matched && existsSync(join(dir, "package.json"))) matched = dir;
  }
  return matched;
}

/** A missing owned entry may still resolve through Node's ancestor lookup. */
function inspectAncestorDependency(packageDir, name, store, escaped) {
  for (let parent = dirname(packageDir); ; parent = dirname(parent)) {
    const candidate = join(parent, "node_modules", ...name.split("/"));
    for (const path of [candidate, candidate + ".js", candidate + ".json", candidate + ".node"]) {
      try { lstatSync(path); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency fallback could not be inspected: " + name);
        continue;
      }
      try {
        const resolved = realpathSync(path);
        escaped.add(inside(resolved, store) ? "pnpm dependency resolves outside its package group: " + name
          : "pnpm dependency can resolve outside the selected store: " + name);
      } catch { escaped.add("pnpm dependency fallback could not be resolved: " + name); }
      return;
    }
    if (parent === dirname(parent)) return;
  }
}

/**
 * Ancestor node_modules inside the store must keep their links in the store. Above the store the walk
 * stops: a user's ~/node_modules is not part of the package. A declared dependency that is missing in
 * the store and resolves from outside is refused separately (inspectAncestorDependency). With
 * preserved symlinks Node walks the lexical ancestors, so that walk keeps every root.
 */
function inspectAncestorRoots(packageDir, store, escaped, preserved = false, storeAlias = store, metadataSeen) {
  for (let parent = dirname(packageDir); ; parent = dirname(parent)) {
    if (!preserved && !inside(parent, store)) return;
    if (basename(parent) !== "node_modules") {
      const root = join(parent, "node_modules");
      let exists = true;
      try { lstatSync(root); } catch (error) {
        exists = false;
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm ancestor dependency root could not be resolved");
      }
      if (exists) {
        try {
          if (!inside(realpathSync(root), store)) escaped.add(preserved
            ? "pnpm preserved-symlink lookup root is outside the selected store" : "pnpm ancestor dependency root is outside the selected store");
          else {
            resolveStoreLinkChain(root, store, storeAlias);
            inspectPnpmMetadata(root, store, escaped, "ancestor dependency lookup", storeAlias, metadataSeen);
          }
        }
        catch { escaped.add("pnpm ancestor dependency root could not be resolved"); }
      }
    }
    if (parent === dirname(parent)) return;
  }
}

/** Resolve existing ancestors too, so a missing entry cannot hide an escaping symlink. */
function canonicalProspectivePath(path) {
  const missing = [];
  for (let current = path; ; current = dirname(current)) {
    try { return resolve(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if ((error?.code !== "ENOENT" && error?.code !== "ENOTDIR") || current === dirname(current)) throw error;
      missing.push(basename(current));
    }
  }
}

function inspectPackageEntries(packageDir, manifest, store, escaped, alternateRoot) {
  const values = [manifest.main, manifest.module, manifest.bin, manifest.exports];
  const pending = [...values];
  while (pending.length) {
    const entry = pending.pop();
    if (entry && typeof entry === "object") { pending.push(...Object.values(entry)); continue; }
    if (typeof entry !== "string" || !entry) continue;
    try {
      const target = canonicalProspectivePath(resolve(packageDir, entry));
      if (!inside(target, store) && (!alternateRoot || !inside(target, alternateRoot))) {
        escaped.add("pnpm package entry point is outside the selected store");
      }
    } catch { escaped.add("pnpm package entry point could not be resolved"); }
  }
}

/** pnpm's metadata and executable directories are not packages, but their links still must stay inside the store. */
function inspectPnpmMetadata(path, store, escaped, kind, storeAlias = store, seen = new Set()) {
  const pending = [path];
  while (pending.length) {
    const current = pending.pop();
    let real;
    try {
      if (inside(current, store) && (current === path || lstatSync(current).isSymbolicLink())) {
        resolveStoreLinkChain(current, store, storeAlias);
      }
      real = realpathSync(current);
    }
    catch (error) {
      escaped.add("pnpm " + kind + (error?.message === "link is outside the selected store"
        ? " link escapes the selected store: " : " link could not be resolved: ") + basename(current));
      continue;
    }
    if (!inside(real, store)) { escaped.add("pnpm " + kind + " link escapes the selected store: " + basename(current)); continue; }
    if (seen.has(real)) continue;
    if (seen.size >= 10000) { escaped.add("pnpm metadata graph exceeds verification limit"); return; }
    seen.add(real);
    try {
      if (statSync(real).isDirectory()) for (const entry of readdirSync(real, { withFileTypes: true })) {
        if (!entry.isFile()) pending.push(join(real, entry.name));
      }
    }
    catch { escaped.add("pnpm " + kind + " link could not be resolved: " + basename(current)); }
  }
}

/**
 * Node's built-in global lookup paths, computed the way Node's module loader builds Module.globalPaths
 * (before NODE_PATH): $HOME/.node_modules and $HOME/.node_libraries (USERPROFILE on Windows), then
 * <prefix>/lib/node, where prefix is the executable's directory on Windows and its parent elsewhere.
 */
function nodeGlobalLookupPaths() {
  const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  const prefix = process.platform === "win32" ? resolve(process.execPath, "..") : resolve(process.execPath, "..", "..");
  return [...(home ? [resolve(home, ".node_modules"), resolve(home, ".node_libraries")] : []), resolve(prefix, "lib", "node")];
}

/**
 * Node's global search paths (Module.globalPaths, NODE_PATH) that lie inside the store must keep their
 * links there. Paths outside the store are the user's environment, not the package: they are not
 * evidence that the package left its store, and a missing declared dependency they could supply is
 * refused by inspectAncestorDependency's missing-dependency rule.
 */
function inspectGlobalLookupRoots(store, escaped, storeAlias = store) {
  const lookupRoots = new Set([...nodeGlobalLookupPaths(), ...String(process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean)]);
  for (const raw of lookupRoots) {
    const root = resolve(raw);
    try { lstatSync(root); } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm global dependency lookup root could not be resolved");
      continue;
    }
    try {
      let real;
      // A dangling entry supplies nothing, like a missing one.
      try { real = realpathSync(root); } catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue; throw error; }
      // Only a root whose own spelling lies in the store is part of it; an outside link into the store is
      // the user's environment, like any other outside entry. An in-store spelling must stay in the store.
      if (!(inside(root, store) || (storeAlias && inside(root, resolve(storeAlias))))) continue;
      if (!inside(real, store)) { escaped.add("pnpm global dependency lookup root is outside the selected store"); continue; }
      resolveStoreLinkChain(root, store, storeAlias);
    } catch { escaped.add("pnpm global dependency lookup root could not be resolved"); continue; }
    inspectPnpmMetadata(root, store, escaped, "global dependency lookup", storeAlias);
  }
}

/** Find nested module roots and validate package links without following them outside the store. */
function nestedPnpmRoots(packageDir, store, escaped, budget, storeAlias = store) {
  const pending = [packageDir], seen = new Set(), roots = [];
  while (pending.length) {
    const current = pending.pop();
    let real;
    try { real = realpathSync(current); } catch { escaped.add("pnpm package path could not be resolved"); continue; }
    if (!inside(real, store)) { escaped.add("pnpm package link escapes the selected store"); continue; }
    const manifestPath = join(current, "package.json");
    try {
      lstatSync(manifestPath);
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        inspectPackageEntries(current, manifest, store, escaped);
        if (current !== real) inspectPackageEntries(real, manifest, store, escaped);
      } catch { escaped.add("pnpm nested package manifest could not be read"); }
    } catch (error) {
      if (error?.code !== "ENOENT") escaped.add("pnpm nested package manifest could not be read");
    }
    if (seen.has(real)) continue;
    if (budget.remaining-- <= 0) { escaped.add("pnpm package traversal exceeds verification limit"); return roots; }
    seen.add(real);
    try {
      for (const entry of readdirSync(real, { withFileTypes: true })) {
        const child = join(current, entry.name);
        if (entry.name === "node_modules") {
          try { roots.push(resolveStoreLinkChain(child, store, storeAlias)); }
          catch { escaped.add("pnpm dependency root could not be resolved"); }
          continue;
        }
        // On Windows readdir reports junctions and directory symlinks as directories; lstat decides there.
        let isLink = entry.isSymbolicLink();
        if (!isLink && entry.isDirectory() && process.platform === "win32") {
          try { isLink = lstatSync(join(real, entry.name)).isSymbolicLink(); }
          catch { escaped.add("pnpm package link could not be resolved"); continue; }
        }
        if (!isLink && entry.isDirectory()) pending.push(child);
        else if (isLink) {
          try {
            const target = resolveStoreLinkChain(child, store, storeAlias);
            if (!inside(target, store)) escaped.add("pnpm package link escapes the selected store");
            else if (statSync(target).isDirectory()) pending.push(target);
          } catch (error) { escaped.add(error?.message === "link is outside the selected store"
            ? "pnpm package link escapes the selected store" : "pnpm package link could not be resolved"); }
        }
      }
    } catch { escaped.add("pnpm package directory could not be inspected"); }
  }
  return roots;
}

/** Check reachable global-store package roots and declared dependency links, including cycles. */
function inspectGlobalPnpmGraph(packageDir, store, escaped, storeAlias = store) {
  const pending = [packageDir], seen = new Set(), enumeratedRoots = new Set();
  const ancestorMetadataSeen = new Set(), metadataSeen = new Map(), budget = { remaining: 100000 };
  inspectGlobalLookupRoots(store, escaped, storeAlias);
  while (pending.length) {
    const spelling = pending.pop();
    let path;
    try { path = realpathSync(spelling); } catch { escaped.add("pnpm dependency package could not be resolved"); continue; }
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(spelling, "package.json"), "utf8")); }
    catch { escaped.add("pnpm dependency manifest could not be read"); continue; }
    inspectPackageEntries(spelling, manifest, store, escaped);
    if (path !== spelling) inspectPackageEntries(path, manifest, store, escaped);
    if (seen.has(path)) continue;
    if (seen.size >= 10000) { escaped.add("pnpm dependency graph exceeds verification limit"); return; }
    seen.add(path);
    inspectAncestorRoots(path, store, escaped, false, storeAlias, ancestorMetadataSeen);
    const names = new Set();
    const nestedRoots = nestedPnpmRoots(spelling, store, escaped, budget, storeAlias);
    const ownRoot = join(path, "node_modules"), groupRoot = enclosingNodeModules(path);
    const enqueueRootEntry = (root, name) => {
      const dependency = pnpmOwnedDependencyDir(path, name, store, true, escaped, [root], storeAlias);
      if (dependency) pending.push(dependency);
    };
    for (const root of [...new Set([ownRoot, groupRoot, ...nestedRoots])]) {
      if (!root) continue;
      try { lstatSync(root); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") escaped.add("pnpm dependency root could not be resolved");
        continue;
      }
      try {
        const realRoot = realpathSync(root);
        if (!inside(realRoot, store)) { escaped.add("pnpm dependency root is outside the selected store"); continue; }
        if (inside(root, store) || (storeAlias && inside(root, storeAlias))) resolveStoreLinkChain(root, store, storeAlias);
        // Link hops for each spelling were checked above; expand the physical group once.
        if (enumeratedRoots.has(realRoot)) continue;
        enumeratedRoots.add(realRoot);
        for (const name of readdirSync(root)) {
          if ([".bin", ".pnpm", ".modules.yaml"].includes(name)) {
            const kind = name === ".bin" ? "binary" : "metadata";
            if (!metadataSeen.has(kind)) metadataSeen.set(kind, new Set());
            inspectPnpmMetadata(join(root, name), store, escaped, kind, storeAlias, metadataSeen.get(kind));
            continue;
          }
          if (!name.startsWith("@")) { enqueueRootEntry(root, name); continue; }
          const scope = join(root, name);
          try {
            if (!inside(realpathSync(scope), store)) { escaped.add("pnpm dependency scope is outside the selected store: " + name); continue; }
            if (statSync(scope).isDirectory()) for (const child of readdirSync(scope)) enqueueRootEntry(root, name + "/" + child);
          } catch { escaped.add("pnpm dependency scope could not be resolved: " + name); }
        }
      } catch { escaped.add("pnpm dependency root could not be resolved"); }
    }
    for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) names.add(name);
    for (const name of names) {
      const dependency = pnpmOwnedDependencyDir(path, name, store, true, escaped, undefined, storeAlias);
      if (dependency) pending.push(dependency);
      for (const root of nestedRoots) {
        if (root === ownRoot || root === groupRoot) continue;
        const nested = pnpmOwnedDependencyDir(path, name, store, true, escaped, [root], storeAlias);
        if (nested) pending.push(nested);
      }
      if (!dependency) {
        // pnpm can leave even non-optional peers absent when peer auto-install and strict checking are disabled.
        const required = Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name);
        if (required) {
          escaped.add("pnpm required dependency is missing from the selected store: " + name);
        }
        if (Object.hasOwn(manifest.dependencies ?? {}, name) || Object.hasOwn(manifest.optionalDependencies ?? {}, name)
          || Object.hasOwn(manifest.peerDependencies ?? {}, name)) inspectAncestorDependency(path, name, store, escaped);
      }
    }
  }
}

/** Verification manifest for a staged (or live) package tree. */
function verifyTreeWithDependencyLookup(packageDir, expectedVersion, dependencyDir, inspectAllLinks = false, allowPackageRootSymlink = false) {
  const failures = [];
  let canonicalRoot;
  try {
    const rootStat = lstatSync(packageDir);
    const allowedSymlink = allowPackageRootSymlink && rootStat.isSymbolicLink();
    if ((!rootStat.isDirectory() && !allowedSymlink) || (rootStat.isSymbolicLink() && !allowedSymlink)) {
      return { ok: false, failures: ["package root must be a regular directory"] };
    }
    canonicalRoot = realpathSync(packageDir);
    const canonicalRootStat = lstatSync(canonicalRoot);
    if (!canonicalRootStat.isDirectory() || canonicalRootStat.isSymbolicLink()) {
      return { ok: false, failures: ["package root must resolve to a regular directory"] };
    }
  } catch (error) {
    return { ok: false, failures: ["package root unreadable: " + (error?.message ?? String(error))] };
  }
  const regularFile = (parts, label, minimumSize = 0) => {
    const path = join(packageDir, ...parts);
    for (let index = 0; index < parts.length; index += 1) {
      const ancestor = join(packageDir, ...parts.slice(0, index + 1));
      try {
        const stat = lstatSync(ancestor);
        if (stat.isSymbolicLink()) return label + " must not be a symlink";
      } catch {
        return label + " absent";
      }
    }
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimumSize) return label + " missing or truncated";
      if (!canonicalPathIsContained(canonicalRoot, realpathSync(path))) return label + " escapes package root";
      return null;
    } catch {
      return label + " absent";
    }
  };
  let pkg;
  try {
    const packageJsonFailure = regularFile(["package.json"], "package.json");
    if (packageJsonFailure) return { ok: false, failures: [packageJsonFailure] };
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, failures: ["package.json unreadable: " + (error?.message ?? String(error))] };
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    failures.push("package.json version " + pkg.version + " != expected " + expectedVersion);
  }
  const launcher = join(packageDir, "bin", "ocx.mjs");
  const launcherFailure = regularFile(["bin", "ocx.mjs"], "bin/ocx.mjs", 1024);
  if (launcherFailure) failures.push(launcherFailure);
  // The bundled Bun binary is the load-bearing artifact: without it the launcher exits
  // before serving anything, and a boot probe that called this tree healthy would reap
  // the only backup (review High 3). Size-gate the real binary, not just its package.json.
  const bunPkgDir = dependencyDir(packageDir, "bun") ?? ownTreeBunDir(packageDir);
  if (bunPkgDir) {
    let bunRootUnsafe = false;
    let canonicalBunRoot;
    try {
      canonicalBunRoot = realpathSync(bunPkgDir);
      if (dependencyDir === candidateTreeDependencyDir) {
        const nodeModules = lstatSync(join(packageDir, "node_modules"));
        if (!nodeModules.isDirectory() || nodeModules.isSymbolicLink()) bunRootUnsafe = true;
      }
    } catch {
      bunRootUnsafe = true;
    }
    const bunTree = bunRootUnsafe ? { largest: undefined, unsafe: true } : findLargestFile(bunPkgDir, canonicalBunRoot);
    if (bunTree.unsafe || !bunTree.largest || bunTree.largest.size < 10 * 1024 * 1024) {
      failures.push("bundled Bun binary missing or truncated (< 10MB)");
    }
  }
  // Sentinel direct deps: each must have an intact package.json. The bundled Bun dep is
  // the load-bearing one — without it the launcher cannot start the proxy at all.
  const deps = Object.keys(pkg.dependencies ?? {});
  if (inspectAllLinks) for (const name of new Set([...deps, ...Object.keys(pkg.optionalDependencies ?? {})])) dependencyDir(packageDir, name);
  const sentinels = deps.filter(name => name === "bun" || name === "zod").length > 0
    ? deps.filter(name => name === "bun" || name === "zod")
    : deps.slice(0, 2);
  for (const name of sentinels) {
    if (dependencyDir === candidateTreeDependencyDir) {
      try {
        const nodeModules = lstatSync(join(packageDir, "node_modules"));
        if (!nodeModules.isDirectory() || nodeModules.isSymbolicLink()) {
          failures.push("sentinel dependency missing: " + name);
          continue;
        }
      } catch {
        failures.push("sentinel dependency missing: " + name);
        continue;
      }
    }
    const dependencyRoot = dependencyDir(packageDir, name);
    if (!dependencyRoot) {
      failures.push("sentinel dependency missing: " + name);
      continue;
    }
    try {
      const canonicalDependencyRoot = realpathSync(dependencyRoot);
      const manifestPath = join(dependencyRoot, "package.json");
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
        || !canonicalPathIsContained(canonicalDependencyRoot, realpathSync(manifestPath))) {
        failures.push("sentinel dependency missing: " + name);
      }
    } catch {
      failures.push("sentinel dependency missing: " + name);
    }
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

/**
 * npm (and every recovery decision): the candidate must be self-contained. Used by
 * transactionalNpmUpdate's stage and post-swap checks and by bootRestoreProbe.
 */
export function verifyInstallTree(packageDir, expectedVersion) {
  return verifyTreeWithDependencyLookup(packageDir, expectedVersion, candidateTreeDependencyDir);
}

/**
 * Verify a package exposed through pnpm's global virtual store. pnpm 10/11 may use an
 * isolated virtual store, a custom virtualStoreDir, global virtual-store links, or a
 * hoisted linker, so the dependency may sit outside the package directory — but it must
 * still be reachable through a root this package instance owns.
 */
export function verifyPnpmInstallTree(packageDir, expectedVersion, store, globalRoot, lexicalStore = store) {
  let real, canonicalGlobalRoot;
  try { real = realpathSync(packageDir); } catch { return { ok: false, failures: ["pnpm package path could not be resolved"] }; }
  try { if (store) store = realpathSync(store); } catch { return { ok: false, failures: ["pnpm configured store could not be resolved"] }; }
  if (globalRoot && (!store || !inside(real, store))) {
    try {
      canonicalGlobalRoot = realpathSync(globalRoot);
      if (!inside(real, canonicalGlobalRoot)) return { ok: false, failures: ["pnpm package is outside the selected store and global group"] };
    } catch { return { ok: false, failures: ["pnpm global group could not be resolved"] }; }
  }
  let globalLinks;
  try {
    globalLinks = packagePathUsesGlobalLinks(packageDir, store, lexicalStore) || (store && inside(real, store));
  } catch (error) { return { ok: false, failures: [error?.message === "link is outside the selected store"
    ? "pnpm global links are outside the selected store" : "pnpm package symlink chain could not be resolved"] }; }
  if (globalLinks && (!store || !inside(real, store))) {
    return { ok: false, failures: ["pnpm global links are outside the selected store"] };
  }
  if (globalLinks) {
    // The reported package spelling is walked as written below; resolve() would delete "." and ".."
    // segments without visiting the links they cross, so such a spelling is refused first.
    if (String(packageDir).split(/[\\/]+/).some(part => part === "." || part === "..")) {
      return { ok: false, failures: ["pnpm package path is not canonical"] };
    }
    // Hop roots are only as narrow as their spelling: a link component in the lexical store or global
    // group would make its target, and any relay below it, count as inside.
    for (const root of [lexicalStore, globalRoot]) {
      // A missing group authorizes nothing (see below), so only an existing spelling is inspected.
      if (!root || !existsSync(root)) continue;
      try { if (spellingHasLinkComponent(root)) return { ok: false, failures: ["pnpm store or global group path is not canonical"] }; }
      catch { return { ok: false, failures: ["pnpm store or global group path could not be resolved"] }; }
    }
    // Every hop from the reported spelling to the package must stay inside the selected global group
    // or the selected store; a relay elsewhere cannot vouch for a link that later returns to the store.
    // A group that cannot be resolved authorizes nothing: the path must then start inside the store.
    let canonicalGroup;
    try { if (globalRoot) canonicalGroup = realpathSync(globalRoot); } catch { canonicalGroup = undefined; }
    try {
      const end = canonicalGroup
        ? resolveStoreLinkChain(resolve(packageDir), store, lexicalStore, canonicalGroup, resolve(globalRoot))
        : resolveStoreLinkChain(resolve(packageDir), store, lexicalStore);
      if (!inside(end, store)) throw new Error("link is outside the selected store");
    } catch (error) {
      return { ok: false, failures: [error?.message === "link is outside the selected store"
        ? "pnpm global links are outside the selected store" : "pnpm package symlink chain could not be resolved"] };
    }
  }
  const escaped = new Set();
  if (globalLinks && /(?:^|[\s"'])--preserve-symlinks(?:-main)?(?=$|[\s"'])/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ""].join(" "))) {
    inspectAncestorRoots(resolve(packageDir), store, escaped, true, lexicalStore);
  }
  const result = verifyTreeWithDependencyLookup(packageDir, expectedVersion,
    (path, name) => pnpmOwnedDependencyDir(path, name, store, globalLinks, escaped, undefined, lexicalStore), globalLinks, true);
  if (globalLinks) inspectGlobalPnpmGraph(real, store, escaped, lexicalStore);
  if (escaped.size) return { ok: false, failures: [...escaped].concat(result.failures) };
  return result;
}

function stampedName(prefix) {
  return prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-");
}

export const UPDATE_OWNER_MARKER = ".ocx-update-owner.json";
const STAGE_PREFIX = ".ocx-staging-";
/**
 * A marked stage younger than this is reported as recent. npm's staging install is bounded at
 * three minutes by the launcher; the floor distinguishes likely in-flight work from leftovers.
 */
export const STALE_STAGE_MIN_AGE_MS = 30 * 60 * 1000;
const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** Create a fresh staging directory that did not exist before, and mark it as ours. */
function createOwnedStage(scopeDir, pkgName, deps = {}) {
  const mkdir = deps.mkdir ?? mkdirSync;
  const stageRoot = join(scopeDir, stampedName(".ocx-staging") + "-" + randomBytes(4).toString("hex"));
  // Not recursive: an existing directory of the same name must fail, never be reused.
  mkdir(stageRoot);
  try {
    writeFileSync(join(stageRoot, UPDATE_OWNER_MARKER), JSON.stringify({
      schema: 1,
      kind: "staging",
      pkgName,
      pid: process.pid,
      createdAt: (deps.now ?? Date.now)(),
    }), { flag: "wx" });
    // npm's strict script policy plans the global tree before it creates the prefix layout, so
    // `-g --prefix` into a bare stage fails with ENOENT on <stage>/lib (#5760). POSIX global
    // prefixes keep packages under lib/; Windows installs into the prefix itself.
    if (process.platform !== "win32") mkdir(join(stageRoot, "lib"));
  } catch (error) {
    // Created by this call and not yet handed to npm: remove it rather than leave a partial stage.
    try { ownedArtifactRm(stageRoot, { recursive: true, force: true }); } catch { /* reported by the caller */ }
    throw error;
  }
  return stageRoot;
}

/** The marker of a real (non-link) staging directory this updater created, or null. */
function readOwnedStageMarker(dir, pkgName) {
  try {
    const dirStat = lstatSync(dir);
    // A symlink or junction is never ours to delete: removing through it reaches its target.
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const markerPath = join(dir, UPDATE_OWNER_MARKER);
    if (!lstatSync(markerPath).isFile()) return null;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker?.schema !== 1 || marker.kind !== "staging" || marker.pkgName !== pkgName) return null;
    if (typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) return null;
    return marker;
  } catch {
    return null;
  }
}

function removeWithRetry(rm, target, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      ownedArtifactRm(target, { recursive: true, force: true }, rm);
      return null;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "EUNKNOWN";
      if (!RETRYABLE_REMOVE_CODES.has(code) || attempt >= attempts - 1) return code;
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* brief synchronous backoff, as renameWithRetry */ }
    }
  }
}

/**
 * Remove an owned staging directory. The marker goes last and only once everything else is
 * gone, so a tree held open by a running executable (the reported locked `bunx.exe`) stays
 * provably ours and the next update can finish the job.
 */
export function removeOwnedStage(stageRoot, deps = {}) {
  const rm = deps.rm;
  let names;
  try {
    names = readdirSync(stageRoot);
  } catch (error) {
    return error?.code === "ENOENT" ? { removed: true } : { removed: false, code: error?.code ?? "EUNKNOWN" };
  }
  let failure = null;
  for (const name of names) {
    if (name === UPDATE_OWNER_MARKER) continue;
    const code = removeWithRetry(rm, join(stageRoot, name));
    if (code && !failure) failure = code;
  }
  if (failure) return { removed: false, code: failure };
  const markerCode = removeWithRetry(rm, join(stageRoot, UPDATE_OWNER_MARKER));
  if (markerCode) return { removed: false, code: markerCode };
  const dirCode = removeWithRetry(rm, stageRoot);
  return dirCode ? { removed: false, code: dirCode } : { removed: true };
}

/**
 * Report what earlier update attempts left next to the package. A marker is forgeable and a
 * pathname can be replaced after inspection, so no later process may recursively delete a
 * leftover by that pathname. Never throws or fails the update: fresh unique stages step around it.
 */
export function sweepUpdateLeftovers({ packageDir, pkgName, log = () => {}, deps = {} }) {
  const scopeDir = dirname(packageDir);
  const now = (deps.now ?? Date.now)();
  const result = { inUse: [], recent: [], notOwned: [] };
  let names = [];
  try {
    names = readdirSync(scopeDir);
  } catch {
    return result;
  }
  // npm renames a package it is replacing to ".<name>-<random>" during a direct global install.
  const renameAsidePrefix = "." + basename(packageDir) + "-";
  for (const name of names.sort()) {
    const full = join(scopeDir, name);
    if (name.startsWith(STAGE_PREFIX)) {
      const marker = readOwnedStageMarker(full, pkgName);
      if (!marker) {
        result.notOwned.push(full);
      } else if (now - marker.createdAt < STALE_STAGE_MIN_AGE_MS) {
        result.recent.push(full);
      } else {
        result.inUse.push({ path: full, code: "ESTALE" });
      }
    } else if (name.startsWith(renameAsidePrefix)) {
      result.notOwned.push(full);
    }
  }
  // Names only: the full path under a user-scoped npm prefix carries the account name, and
  // this logger is the launcher's console.
  for (const entry of result.inUse) {
    log(entry.code === "ESTALE"
      ? "Left an earlier update's staging directory in place; delete it by hand once no OpenCodex process is running from it: " + basename(entry.path)
      : "Left an earlier update's staging directory in place (could not remove it: " + entry.code + "): " + basename(entry.path));
  }
  for (const path of result.notOwned) {
    log("Not removing " + basename(path) + " next to the package: this updater did not create it. Delete it by hand once no OpenCodex process is running from it.");
  }
  return result;
}

/** Whether the launcher that ran this npm update can still drive service/tray recovery. */
export function launcherUsableAfterNpmUpdate(tx) {
  return Boolean(tx?.recoveryUnsafe !== true
    && (tx?.ok || tx?.rolledBack === true || ["stage", "verify", "authorize", "pending-marker", "swap-backup"].includes(tx?.phase)));
}

/** Largest regular file under a directory tree (bounded depth) — locates the Bun binary. */
function canonicalPathIsContained(rootPath, childPath, platform = process.platform) {
  const root = normalizePathIdentity(rootPath, platform);
  const child = normalizePathIdentity(childPath, platform);
  const remainder = relative(root, child);
  return remainder.length > 0 && !remainder.startsWith("..") && !isAbsolute(remainder);
}

function findLargestFile(root, canonicalPackageRoot, depth = 3) {
  let best;
  let names = [];
  try { names = readdirSync(root); } catch { return { largest: undefined, unsafe: true }; }
  for (const name of names) {
    const full = join(root, name);
    let st;
    try { st = lstatSync(full); } catch { return { largest: undefined, unsafe: true }; }
    if (st.isSymbolicLink()) return { largest: undefined, unsafe: true };
    if (st.isFile()) {
      try {
        if (!canonicalPathIsContained(canonicalPackageRoot, realpathSync(full))) {
          return { largest: undefined, unsafe: true };
        }
      } catch {
        return { largest: undefined, unsafe: true };
      }
      if (!best || st.size > best.size) best = { path: full, size: st.size };
    } else if (st.isDirectory() && depth > 0) {
      const sub = findLargestFile(full, canonicalPackageRoot, depth - 1);
      if (sub.unsafe) return sub;
      if (sub.largest && (!best || sub.largest.size > best.size)) best = sub.largest;
    }
  }
  return { largest: best, unsafe: false };
}

/** Bounded Windows-class rename retry: EPERM/EBUSY/EACCES from AV/indexers clears in ms. */
function renameWithRetry(rename, from, to, authorize = () => true, attempts = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      guardedRenameSync(authorize, from, to, rename);
      return;
    } catch (error) {
      const code = error?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= attempts - 1) throw error;
      // Synchronous bounded backoff (launcher context has no async loop here).
      const until = Date.now() + 100 * (attempt + 1);
      while (Date.now() < until) { /* spin briefly; total worst case ~1.5s */ }
    }
  }
}

function recoveryMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-recovery.json");
}

function pendingMarkerPath(scopeDir) {
  return join(scopeDir, ".ocx-transaction.json");
}

function normalizePathIdentity(path, platform = process.platform) {
  const normalized = resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIdentity(path, deps = {}) {
  const realpath = deps.realpath ?? realpathSync;
  const platform = deps.platform ?? process.platform;
  const suffix = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  let canonical;
  try { canonical = resolve(realpath(existing), ...suffix); } catch { canonical = resolve(path); }
  return normalizePathIdentity(canonical, platform);
}

function readPendingMarker(scopeDir) {
  const markerPath = pendingMarkerPath(scopeDir);
  let markerStat;
  try {
    markerStat = lstatSync(markerPath);
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "absent" : "invalid" };
  }
  try {
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return { state: "invalid" };
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!parsed || parsed.state !== "pending" || typeof parsed.id !== "string" || parsed.id.length === 0
      || !Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid <= 0
      || typeof parsed.live !== "string" || typeof parsed.backup !== "string") return { state: "invalid" };
    return { state: "pending", id: parsed.id, ownerPid: parsed.ownerPid, live: parsed.live, backup: parsed.backup };
  } catch {
    return { state: "invalid" };
  }
}

function pendingMarkerMatches(marker, transaction) {
  return marker.state === "pending"
    && marker.id === transaction.id
    && marker.ownerPid === transaction.ownerPid
    && pathIdentity(marker.live) === pathIdentity(transaction.live)
    && pathIdentity(marker.backup) === pathIdentity(transaction.backup);
}

function safeBackupIdentity(scopeDir, backupPath, deps = {}) {
  const realpath = deps.realpath ?? realpathSync;
  const platform = deps.platform ?? process.platform;
  const scope = pathIdentity(scopeDir, deps);
  const requestedBackup = resolve(backupPath);
  const requestedRoot = dirname(requestedBackup);
  if (pathIdentity(dirname(requestedRoot), deps) !== scope
    || !basename(requestedRoot).startsWith(".ocx-backup-")
    || basename(backupPath) !== "opencodex"
    || requestedBackup !== resolve(requestedRoot, "opencodex")) return null;
  try {
    const rootStat = lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const canonicalRoot = realpath(requestedRoot);
    const canonicalName = platform === "win32" ? basename(canonicalRoot).toLowerCase() : basename(canonicalRoot);
    const requestedName = platform === "win32" ? basename(requestedRoot).toLowerCase() : basename(requestedRoot);
    if (normalizePathIdentity(dirname(canonicalRoot), platform) !== scope
      || canonicalName !== requestedName) return null;
    const canonicalBackup = resolve(canonicalRoot, "opencodex");
    if (existsSync(requestedBackup)) {
      const backupStat = lstatSync(requestedBackup);
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) return null;
    }
    return canonicalBackup;
  } catch {
    return null;
  }
}

function writePendingMarker(scopeDir, transaction, deps) {
  const writeFile = deps.writeFile ?? writeFileSync;
  const linkMarker = deps.linkMarker ?? linkSync;
  const remove = (target, options) => ownedArtifactRm(target, options, deps.remove);
  const markerPath = pendingMarkerPath(scopeDir);
  const temporaryPath = join(scopeDir, `.ocx-transaction-${transaction.id}.tmp`);
  try {
    if (existsSync(markerPath)) throw new Error("pending transaction marker already exists");
    writeFile(temporaryPath, JSON.stringify({ state: "pending", ...transaction }, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    linkMarker(temporaryPath, markerPath);
    remove(temporaryPath, { force: true });
    const written = readPendingMarker(scopeDir);
    if (!pendingMarkerMatches(written, transaction)) {
      throw new Error("pending transaction marker failed readback verification");
    }
    return { written: true };
  } catch (error) {
    try { remove(temporaryPath, { force: true }); } catch { /* best effort */ }
    return { written: false, error: error?.message ?? String(error) };
  }
}

function writeRecoveryMarker(scopeDir, payload, deps = {}) {
  const writeFile = deps.writeRecoveryFile ?? deps.writeFile ?? writeFileSync;
  const linkMarker = deps.linkMarker ?? linkSync;
  const remove = (target, options) => ownedArtifactRm(target, options, deps.remove);
  const markerPath = recoveryMarkerPath(scopeDir);
  const temporaryPath = join(scopeDir, `.ocx-recovery-${randomUUID()}.tmp`);
  try {
    if (existsSync(markerPath)) throw new Error("recovery marker already exists");
    writeFile(temporaryPath, JSON.stringify(payload, null, 2), { flag: "wx", mode: 0o600 });
    linkMarker(temporaryPath, markerPath);
    remove(temporaryPath, { force: true });
    const written = lstatSync(markerPath);
    if (!written.isFile() || written.isSymbolicLink()) throw new Error("recovery marker is not a regular file");
    return { written: true };
  } catch (error) {
    try { remove(temporaryPath, { force: true }); } catch { /* best effort */ }
    return { written: false, error: error?.message ?? String(error) };
  }
}

function directoryIdentity(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(path, expected) {
  const current = directoryIdentity(path);
  return current !== null && expected !== null
    && current.dev === expected.dev
    && current.ino === expected.ino;
}

function stagedTreeIdentity(stageRoot, stagedPackage, realpath = realpathSync) {
  const root = directoryIdentity(stageRoot);
  const packageIdentity = directoryIdentity(stagedPackage);
  if (root === null || packageIdentity === null) return null;
  try {
    const canonicalRoot = realpath(stageRoot);
    const canonicalPackage = realpath(stagedPackage);
    if (!canonicalPathIsContained(canonicalRoot, canonicalPackage)) return null;
  } catch {
    return null;
  }
  return { root, package: packageIdentity };
}

function sameStagedTreeIdentity(stageRoot, stagedPackage, expected, realpath = realpathSync) {
  return expected !== null
    && sameDirectoryIdentity(stageRoot, expected.root)
    && sameDirectoryIdentity(stagedPackage, expected.package)
    && stagedTreeIdentity(stageRoot, stagedPackage, realpath) !== null;
}

/** Startup probe: restore a backup when the live tree is broken (D4 power-loss rows). */
export function bootRestoreProbe(packageDir, deps = {}) {
  const rename = deps.rename;
  const remove = (target, options) => ownedArtifactRm(target, options, deps.remove);
  const readDirectory = deps.readDirectory ?? readdirSync;
  const pathDeps = { realpath: deps.realpath ?? realpathSync, platform: deps.platform ?? process.platform };
  const isProcessAlive = deps.isProcessAlive ?? ((pid) => {
    try {
      probeProcessAlive(pid);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });
  const scopeDir = dirname(packageDir);
  const pending = readPendingMarker(scopeDir);
  const recovery = (() => {
    try { return JSON.parse(readFileSync(recoveryMarkerPath(scopeDir), "utf8")); } catch { return null; }
  })();
  const oldPackageAlreadyRestored = recovery?.error === "previous package restored but pending marker cleanup failed";
  let backups = [];
  try {
    backups = readDirectory(scopeDir).filter(name => name.startsWith(".ocx-backup-")).sort();
  } catch (error) {
    return { action: "failed", error: "package scope could not be enumerated: " + (error?.message ?? String(error)) };
  }
  for (const name of backups) {
    if (safeBackupIdentity(scopeDir, join(scopeDir, name, "opencodex"), pathDeps) === null) {
      return { action: "failed", error: "package scope contains an unsafe transactional backup" };
    }
  }
  if (pending.state === "invalid") return { action: "failed", error: "pending transaction marker is invalid" };
  if (pending.state === "pending" && pathIdentity(pending.live, pathDeps) !== pathIdentity(packageDir, pathDeps)) {
    return { action: "failed", error: "pending transaction marker does not match this package and backup set" };
  }
  if (pending.state === "pending" && isProcessAlive(pending.ownerPid)) {
    const markedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
    return markedBackup !== null
      ? { action: "pending", from: markedBackup }
      : { action: "failed", error: "pending transaction marker does not match this package and backup set" };
  }
  if (backups.length === 0) {
    if (pending.state !== "pending") return { action: "none" };
    const liveOk = existsSync(join(packageDir, "package.json")) && verifyInstallTree(packageDir).ok;
    if (!liveOk) return { action: "failed", error: "pending transaction backup is missing" };
    if (!oldPackageAlreadyRestored && existsSync(dirname(pathIdentity(pending.backup)))) {
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    try {
      remove(pendingMarkerPath(scopeDir), { force: true });
      const preparedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
      if (preparedBackup !== null) {
        try { remove(dirname(preparedBackup), { recursive: true, force: true }); } catch { /* empty prepared backup root only */ }
      }
      if (oldPackageAlreadyRestored) {
        try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* stale diagnostic only */ }
      }
      return { action: "aborted" };
    } catch (error) {
      return { action: "failed", error: "dead prepared transaction marker could not be removed: " + (error?.message ?? String(error)) };
    }
  }
  const liveOk = existsSync(join(packageDir, "package.json"))
    && verifyInstallTree(packageDir).ok;
  if (pending.state === "pending" && recovery?.reason === "restored-backup-verification-failed") {
    return { action: "failed", error: "pending transaction backup failed verification during rollback" };
  }
  if (pending.state === "pending"
    && liveOk
    && !oldPackageAlreadyRestored
    && existsSync(join(pending.backup, "package.json"))) {
    return {
      action: "failed",
      error: "pending transaction owner exited after a complete live package landed; refusing to overwrite it automatically",
    };
  }
  const newestBackup = join(scopeDir, backups[backups.length - 1], "opencodex");
  let restoreBackup = newestBackup;
  if (pending.state === "pending") {
    const markedBackup = safeBackupIdentity(scopeDir, pending.backup, pathDeps);
    if (markedBackup === null) {
      return { action: "failed", error: "pending transaction marker does not match this package and backup set" };
    }
    const belongsToBackups = backups.some(name =>
      pathIdentity(join(scopeDir, name, "opencodex"), pathDeps) === pathIdentity(markedBackup, pathDeps));
    if (!belongsToBackups) {
      if (liveOk) {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "restored transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    if (!existsSync(join(markedBackup, "package.json"))) {
      if (liveOk && recovery?.error === "previous package restored but pending marker cleanup failed") {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* stale diagnostic only */ }
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "restored transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      if (liveOk) {
        try {
          remove(pendingMarkerPath(scopeDir), { force: true });
          try { remove(dirname(markedBackup), { recursive: true, force: true }); } catch { /* empty prepared backup root only */ }
          return { action: "aborted" };
        } catch (error) {
          return { action: "failed", error: "dead prepared transaction marker could not be removed: " + (error?.message ?? String(error)) };
        }
      }
      return { action: "failed", error: "pending transaction backup is missing" };
    }
    restoreBackup = markedBackup;
  }
  if (liveOk && pending.state !== "pending") {
    // Live is healthy: the backups are leftovers from a completed swap. Reap them.
    for (const name of backups) {
      try { ownedArtifactRm(join(scopeDir, name), { recursive: true, force: true }); } catch { /* keep */ }
    }
    try { ownedArtifactRm(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* keep */ }
    return { action: "reaped", count: backups.length };
  }
  if (!existsSync(join(restoreBackup, "package.json"))) return { action: "none" };
  let backupCheck;
  try {
    backupCheck = verifyInstallTree(restoreBackup);
  } catch (error) {
    backupCheck = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!backupCheck.ok) {
    return {
      action: "failed",
      error: "pending transaction backup failed verification: " + backupCheck.failures.join("; "),
    };
  }
  try {
    try { ownedArtifactRm(packageDir, { recursive: true, force: true }); } catch { /* may not exist */ }
    guardedRenameSync(() => true, restoreBackup, packageDir, rename);
    if (pending.state === "pending") {
      remove(pendingMarkerPath(scopeDir), { force: true });
      try { remove(dirname(restoreBackup), { recursive: true, force: true }); } catch { /* empty backup root only */ }
    }
    return { action: "restored", from: restoreBackup };
  } catch (error) {
    return { action: "failed", error: error?.message ?? String(error) };
  }
}

/**
 * Run the transactional update. `runNpm(args, opts)` is injected so the caller keeps
 * its hardened npm resolution (npm-invocation.mjs) and logging.
 */
function* npmUpdateTransaction({
  packageDir,
  pkgName,
  targetVersion,
  tag,
  packageSpec,
  installArgs,
  cachePath,
  mayReplacePackage = () => true,
  verifyStage = verifyInstallTree,
  verifyLive = verifyInstallTree,
  verifyRollback = verifyInstallTree,
  log = () => {},
  deferCommit = false,
  deps = {},
}) {
  const rename = deps.rename;
  const realpath = deps.realpath ?? realpathSync;
  const remove = (target, options) => ownedArtifactRm(target, options, deps.remove);
  const scopeDir = dirname(packageDir);
  const preexistingPending = readPendingMarker(scopeDir);
  if (preexistingPending.state !== "absent") {
    return { ok: false, phase: "pending-existing", recoveryUnsafe: true, error: "an earlier package transaction still requires recovery" };
  }
  // Earlier staging paths are reported; a fresh stage uses a unique path.
  try { sweepUpdateLeftovers({ packageDir, pkgName, log, deps }); } catch { /* report-only */ }
  let stageRoot;
  // GLOBAL-style staging (-g --prefix): npm nests the package's dependencies INSIDE the
  // package dir, exactly like the live global tree this stage will replace. A local-style
  // install would hoist bun/zod to stageRoot/node_modules — siblings that the swap would
  // leave behind, shipping a dependency-less live tree (release-audit blocker).
  // Layout: <stageRoot>/lib/node_modules/<pkg> on POSIX, <stageRoot>/node_modules/<pkg>
  // on Windows.

  // D1: stage to the side. --prefix keeps npm entirely inside stageRoot; the live tree
  // and the npm bin shims are untouched until the swap. A failure HERE (mkdir EACCES,
  // ENOSPC) must NOT fall back to the destructive legacy install (review High 4): the
  // caller sees a normal phase failure with live untouched.
  try {
    stageRoot = createOwnedStage(scopeDir, pkgName, deps);
  } catch (error) {
    return { ok: false, phase: "stage", error: "could not create staging directory: " + (error?.message ?? String(error)) };
  }
  const ownedStageIdentity = directoryIdentity(stageRoot);
  const stagedCandidatesIn = root => [
    join(root, "lib", "node_modules", ...pkgName.split("/")),
    join(root, "node_modules", ...pkgName.split("/")),
  ];
  const discardStage = () => {
    if (!sameDirectoryIdentity(stageRoot, ownedStageIdentity)
      || readOwnedStageMarker(stageRoot, pkgName) === null) {
      log("Left this update's staging path in place because ownership changed: " + basename(stageRoot));
      return;
    }
    const removal = removeOwnedStage(stageRoot, deps);
    if (!removal.removed) {
      // EACCES/EUNKNOWN do not prove an open file, so the message names the failure
      // without blaming a process; the code stays for whoever reads the log.
      log("Left this update's staging directory in place (could not remove it: " + removal.code + "); later updates will not remove it either — delete it by hand once no OpenCodex process is running from it: " + basename(stageRoot));
    }
  };
  const spec = packageSpec || pkgName + "@" + (targetVersion || tag);
  log("Staging " + spec + " into " + basename(stageRoot) + " next to the package");
  // npm 12 blocks lifecycle scripts by default. Bun's postinstall copies the selected
  // @oven/bun-* executable into bun/bin, so a successful npm exit without this narrow
  // approval leaves the staged tree intentionally incomplete. Allow only the package
  // whose executable the manifest verifies below; never broaden this to all scripts.
  // --prefix <stage> also moves npm's globalconfig to <stage>/etc/npmrc, so a `cache=` from the
  // operator's global npmrc would be dropped and npm would fall back to its default root. Pin
  // the cache the pre-flight resolved and checked, so staging uses that exact root (#6288).
  const cacheArgs = typeof cachePath === "string" && cachePath.length > 0 ? ["--cache", cachePath] : [];
  const install = yield [
    "install", "-g", "--prefix", stageRoot, ...cacheArgs,
    ...(installArgs || ["--allow-scripts=bun", "--no-audit", "--no-fund"]), spec,
  ];
  if (install.status !== 0 || install.error || install.processTreeExited === false) {
    if (install.processTreeExited === false) {
      log("Left this update's staging directory in place: process-tree exit was not confirmed; stop the installer before removing " + basename(stageRoot));
    } else discardStage();
    const detail = install.error
      ? [install.error.code, install.error.message].filter(Boolean).join(": ")
      : install.signal ?? install.status ?? "?";
    return { ok: false, phase: "stage", ...(install.processTreeExited === false ? { processTreeExited: false } : {}), error: "npm staging install failed (" + detail + ")" };
  }
  const stagedPackage = stagedCandidatesIn(stageRoot).find(dir => existsSync(join(dir, "package.json")));
  if (!stagedPackage) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged package directory not found under " + stageRoot };
  }

  // Bind the verifier's result to this exact staged root and package. npm's successful
  // exit only proves it wrote a path; every directory can be replaced before the swap.
  const stageIdentity = stagedTreeIdentity(stageRoot, stagedPackage, realpath);
  if (stageIdentity === null) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged package path is unsafe" };
  }

  // D2: verify INSIDE the stage. Live is still untouched on any failure here.
  let staged;
  try {
    staged = verifyStage(stagedPackage, targetVersion || undefined);
  } catch (error) {
    staged = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!staged.ok) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged tree failed verification: " + staged.failures.join("; ") };
  }
  if (!sameStagedTreeIdentity(stageRoot, stagedPackage, stageIdentity, realpath)) {
    discardStage();
    return { ok: false, phase: "verify", error: "staged package object identity changed during verification" };
  }

  // The installer may have awaited a supervisor. Only a synchronous true authorizes
  // the live swap; errors, promises and refusals leave live untouched.
  let authorized = false;
  try { authorized = mayReplacePackage() === true; } catch { /* fail closed */ }
  if (!authorized) {
    discardStage();
    return { ok: false, phase: "authorize", error: "package replacement authority changed; rerun from the beginning" };
  }
  // D3: swap. live -> backup, stage -> live, re-verify live, rollback on failure.
  const backupRoot = join(scopeDir, stampedName(".ocx-backup"));
  const backupPackage = join(backupRoot, "opencodex");
  let pendingTransaction;
  try {
    mkdirSync(backupRoot, { recursive: true });
  } catch (error) {
    discardStage();
    return { ok: false, phase: "swap-backup", error: "could not create backup directory: " + (error?.message ?? String(error)) };
  }
  pendingTransaction = {
    id: randomUUID(),
    ownerPid: process.pid,
    live: pathIdentity(packageDir),
    backup: pathIdentity(backupPackage),
  };
  const marker = writePendingMarker(scopeDir, pendingTransaction, deps);
  if (!marker.written) {
    let markerAbsent = false;
    try { lstatSync(pendingMarkerPath(scopeDir)); } catch (error) { markerAbsent = error?.code === "ENOENT"; }
    if (!markerAbsent) {
      return {
        ok: false,
        phase: "pending-marker",
        recoveryUnsafe: true,
        error: "could not record a trustworthy pending transaction: " + marker.error,
      };
    }
    discardStage();
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, phase: "pending-marker", error: "could not record pending transaction: " + marker.error };
  }
  try {
    renameWithRetry(rename, packageDir, backupPackage, () => {
      if (!pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) return false;
      try { return mayReplacePackage() === true && pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction); } catch { return false; }
    });
  } catch (error) {
    if (!pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) {
      return { ok: false, phase: "pending-owner", recoveryUnsafe: true, error: "pending transaction marker is missing or belongs to another transaction" };
    }
    let markerCleanupError;
    if (pendingTransaction) {
      try { remove(pendingMarkerPath(scopeDir), { force: true }); } catch (cleanupError) { markerCleanupError = cleanupError; }
    }
    discardStage();
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return markerCleanupError === undefined
      ? { ok: false, phase: error?.code === "EUPDATEAUTHORITY" ? "authorize" : "swap-backup", error: "could not move live tree aside: " + (error?.message ?? String(error)) }
      : {
        ok: false,
        phase: "double-fault",
        recoveryUnsafe: true,
        markerCleanupFailed: true,
        error: "live tree stayed intact but pending marker cleanup failed: " + (markerCleanupError?.message ?? String(markerCleanupError)),
      };
  }
  const backupIdentity = {
    root: directoryIdentity(backupRoot),
    package: directoryIdentity(backupPackage),
  };
  let canonicalBackup;
  try {
    if (backupIdentity.root === null || backupIdentity.package === null) {
      throw new Error("backup object identity could not be recorded");
    }
    canonicalBackup = realpath(backupPackage);
  } catch (error) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      deps,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
      quarantineRoot: sameDirectoryIdentity(stageRoot, ownedStageIdentity) ? stageRoot : undefined,
    });
    if (rollback.ok) discardStage();
    return rollback.ok
      ? {
          ok: false,
          phase: "post-verify",
          rolledBack: true,
          error: "canonical backup lookup failed after package swap: " + (error?.message ?? String(error)),
        }
      : rollback;
  }
  try {
    if (!sameStagedTreeIdentity(stageRoot, stagedPackage, stageIdentity, realpath)) {
      throw new Error("staged package object identity changed before placement");
    }
    renameWithRetry(rename, stagedPackage, packageDir);
  } catch (error) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      deps,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
      quarantineRoot: sameDirectoryIdentity(stageRoot, ownedStageIdentity) ? stageRoot : undefined,
    });
    if (rollback.ok) discardStage();
    return rollback.ok
      ? { ok: false, phase: "swap-live", rolledBack: true, error: "could not place staged tree: " + (error?.message ?? String(error)) }
      : rollback;
  }
  let liveCheck;
  try {
    liveCheck = verifyLive(packageDir, targetVersion || undefined);
  } catch (error) {
    liveCheck = { ok: false, failures: [error?.message ?? String(error)] };
  }
  if (!liveCheck.ok) {
    const rollback = rollbackPackageSwap({
      packageDir,
      backupPackage,
      backupRoot,
      scopeDir,
      rename,
      deps,
      remove,
      pendingTransaction,
      backupIdentity,
      verifyRollback,
      quarantineRoot: sameDirectoryIdentity(stageRoot, ownedStageIdentity) ? stageRoot : undefined,
    });
    if (rollback.ok) discardStage();
    return rollback.ok
      ? { ok: false, phase: "post-verify", rolledBack: true, error: "live tree failed post-swap verification: " + liveCheck.failures.join("; ") }
      : rollback;
  }
  // Success: stage scaffolding is disposable now; the backup stays until the next
  // healthy boot reaps it (bootRestoreProbe) — the process that spawned this update may
  // still hold the old cwd.
  discardStage();
  if (deferCommit) {
    let state = "pending";
    const verifyOwnership = () => {
      const marker = readPendingMarker(scopeDir);
      return pendingMarkerMatches(marker, pendingTransaction)
        ? { ok: true }
        : { ok: false, phase: "pending-owner", recoveryUnsafe: true, error: "pending transaction marker is missing or belongs to another transaction" };
    };
    const verifyBackupObject = () => safeBackupIdentity(scopeDir, backupPackage) !== null
      && sameDirectoryIdentity(backupRoot, backupIdentity.root)
      && sameDirectoryIdentity(backupPackage, backupIdentity.package)
      ? { ok: true }
      : { ok: false, phase: "pending-owner", recoveryUnsafe: true, error: "transactional backup object identity changed" };
    const commit = () => {
      if (state === "committed") return { ok: true, phase: "committed" };
      if (state !== "pending") return { ok: false, phase: state, error: "transaction is no longer pending" };
      const ownership = verifyOwnership();
      if (!ownership.ok) return ownership;
      const backupObject = verifyBackupObject();
      if (!backupObject.ok) return backupObject;
      try {
        remove(pendingMarkerPath(scopeDir), { force: true });
        state = "committed";
        try { remove(backupRoot, { recursive: true, force: true }); } catch { /* next healthy probe can reap */ }
        try { remove(recoveryMarkerPath(scopeDir), { force: true }); } catch { /* best effort */ }
        return { ok: true, phase: "committed" };
      } catch (error) {
        return { ok: false, phase: "commit", error: error?.message ?? String(error) };
      }
    };
    const rollback = () => {
      if (state === "rolled-back") return { ok: true, phase: "rolled-back" };
      if (state !== "pending") return { ok: false, phase: state, error: "transaction is no longer pending" };
      const ownership = verifyOwnership();
      if (!ownership.ok) return ownership;
      const result = rollbackPackageSwap({
        packageDir,
        backupPackage,
        backupRoot,
        scopeDir,
        rename,
        deps,
        remove,
        pendingTransaction,
        backupIdentity,
        verifyRollback,
      });
      if (result.ok) state = "rolled-back";
      return result;
    };
    return { ok: true, phase: "pending", backup: canonicalBackup, commit, rollback };
  }
  if (!pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) {
    return { ok: false, phase: "pending-owner", recoveryUnsafe: true, backup: backupPackage, error: "pending transaction marker is missing or belongs to another transaction" };
  }
  try {
    remove(pendingMarkerPath(scopeDir), { force: true });
  } catch (error) {
    return { ok: false, phase: "commit", recoveryUnsafe: true, backup: backupPackage, error: "completed package swap but could not clear pending marker: " + (error?.message ?? String(error)) };
  }
  return { ok: true, phase: "done", backup: backupPackage };
}

/** Keep synchronous callers while the Node launcher awaits the install/exit barrier. */
export function transactionalNpmUpdate(options) {
  const transaction = npmUpdateTransaction(options);
  const step = transaction.next();
  if (step.done) return step.value;
  // Preserve the legacy status-only transaction on POSIX and for existing callers.
  const install = options.runNpm(step.value);
  return transaction.next({ status: install.status }).value;
}

export async function transactionalNpmUpdateAsync(options) {
  const transaction = npmUpdateTransaction(options);
  const step = transaction.next();
  if (step.done) return step.value;
  let install;
  try { install = await options.runNpm(step.value); }
  catch (error) { install = { status: null, error, processTreeExited: false }; }
  if (install.processTreeExited !== true && !(install.groupExited === true && typeof install.status === "number")) install = { ...install, status: null, processTreeExited: false,
    error: install.error ?? { code: "EINSTALLJOIN", message: "npm process-tree exit was not confirmed" } };
  return transaction.next(install).value;
}

function rollbackPackageSwap({
  packageDir,
  backupPackage,
  backupRoot,
  scopeDir,
  rename,
  deps,
  remove,
  pendingTransaction,
  backupIdentity,
  verifyRollback,
  quarantineRoot,
}) {
  if (pendingTransaction && !pendingMarkerMatches(readPendingMarker(scopeDir), pendingTransaction)) {
    return {
      ok: false,
      phase: "pending-owner",
      recoveryUnsafe: true,
      error: "pending transaction marker is missing or belongs to another transaction",
    };
  }
  const recoveryMarker = payload => writeRecoveryMarker(scopeDir, payload, deps);
  const backupObjectMatches = () => backupIdentity
    && safeBackupIdentity(scopeDir, backupPackage) !== null
    && sameDirectoryIdentity(backupRoot, backupIdentity.root)
    && sameDirectoryIdentity(backupPackage, backupIdentity.package);
  const failedLive = quarantineRoot
    ? join(quarantineRoot, "rejected")
    : join(scopeDir, stampedName(".ocx-failed-live"));
  let quarantinedLive = false;
  const restoreQuarantinedLive = () => {
    if (!quarantinedLive) return { ok: true };
    try {
      if (existsSync(packageDir)) {
        throw new Error("live package path is occupied; refusing to delete it while restoring quarantined live");
      }
      renameWithRetry(rename, failedLive, packageDir);
      quarantinedLive = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
  if (!backupObjectMatches()) {
    const marker = recoveryMarker({
      at: new Date().toISOString(),
      backup: backupPackage,
      live: packageDir,
      error: "transactional backup object identity changed before rollback",
    });
    return {
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
      markerWriteFailed: !marker.written,
      error: marker.written
        ? "transactional backup object identity changed; recovery marker written"
        : "transactional backup object identity changed; recovery marker could not be written: " + marker.error,
    };
  }
  try {
    if (existsSync(packageDir)) {
      renameWithRetry(rename, packageDir, failedLive);
      quarantinedLive = true;
    }
    if (!backupObjectMatches()) {
      const restoredLive = restoreQuarantinedLive();
      const marker = recoveryMarker({
        at: new Date().toISOString(),
        backup: backupPackage,
        live: packageDir,
        error: "transactional backup object identity changed during rollback",
        failedLive: restoredLive.ok ? undefined : failedLive,
        liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
      });
      return {
        ok: false,
        phase: "double-fault",
        rolledBack: false,
        recoveryUnsafe: true,
        markerWriteFailed: !marker.written,
        error: restoredLive.ok
          ? "transactional backup object identity changed during rollback"
          : "transactional backup object identity changed and failed live could not be restored: " + restoredLive.error,
      };
    }
    renameWithRetry(rename, backupPackage, packageDir);
    let restored;
    try {
      restored = verifyRollback(packageDir);
    } catch (error) {
      restored = { ok: false, failures: [error?.message ?? String(error)] };
    }
    if (!restored.ok) {
      let backupPreserveError;
      try {
        if (existsSync(backupPackage)) {
          throw new Error("transactional backup path was unexpectedly occupied");
        }
        renameWithRetry(rename, packageDir, backupPackage);
        if (!backupObjectMatches()) {
          throw new Error("restored backup object identity changed while preserving it");
        }
      } catch (error) {
        backupPreserveError = error?.message ?? String(error);
      }
      const restoredLive = restoreQuarantinedLive();
      const marker = recoveryMarker({
        at: new Date().toISOString(),
        reason: "restored-backup-verification-failed",
        backup: backupPackage,
        live: packageDir,
        error: "restored package failed verification: " + restored.failures.join("; "),
        backupPreserveError,
        failedLive: restoredLive.ok ? undefined : failedLive,
        liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
      });
      return {
        ok: false,
        phase: "double-fault",
        rolledBack: false,
        recoveryUnsafe: true,
        markerWriteFailed: !marker.written,
        error: backupPreserveError
          ? "restored package failed verification and could not be preserved at its backup path: " + backupPreserveError
          : marker.written
            ? "restored package failed verification; recovery marker written"
            : "restored package failed verification; recovery marker could not be written: " + marker.error,
      };
    }
    if (quarantinedLive) {
      try { remove(failedLive, { recursive: true, force: true }); } catch { /* verified old live already restored */ }
      quarantinedLive = false;
    }
    if (pendingTransaction) {
      try {
        remove(pendingMarkerPath(scopeDir), { force: true });
      } catch (error) {
        const marker = recoveryMarker({
          at: new Date().toISOString(),
          backup: backupPackage,
          live: packageDir,
          error: "previous package restored but pending marker cleanup failed",
          markerCleanupError: String(error?.message ?? error),
        });
        return {
          ok: false,
          phase: "double-fault",
          rolledBack: true,
          recoveryUnsafe: true,
          markerCleanupFailed: true,
          markerWriteFailed: !marker.written,
          error: marker.written
            ? "previous package restored but pending marker cleanup failed; recovery marker written"
            : "previous package restored but pending and recovery marker cleanup failed: " + marker.error,
        };
      }
    }
    try { remove(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: true, phase: "rolled-back" };
  } catch (rollbackError) {
    const restoredLive = restoreQuarantinedLive();
    const marker = recoveryMarker({
      at: new Date().toISOString(),
      backup: backupPackage,
      live: packageDir,
      restore: 'move "' + backupPackage + '" back to "' + packageDir + '"',
      rollbackError: String(rollbackError?.message ?? rollbackError),
      failedLive: restoredLive.ok ? undefined : failedLive,
      liveRestoreError: restoredLive.ok ? undefined : restoredLive.error,
    });
    return {
      ok: false,
      phase: "double-fault",
      rolledBack: false,
      recoveryUnsafe: true,
      markerWriteFailed: !marker.written,
      error: marker.written
        ? "deferred rollback failed; recovery marker written"
        : "deferred rollback failed; recovery marker could not be written: " + marker.error,
    };
  }
}
