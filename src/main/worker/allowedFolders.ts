import * as fs from 'fs';
import * as path from 'path';
import { cleanFolderInput } from '../../shared/pathSafety';
import type { FolderCheck, FolderEntry, FolderListing, FileOutcome, MappingConfig } from '../../shared/types';

/**
 * The folders a remote worker may touch. The list is set on the worker machine only (its config
 * file or environment); the hub cannot read or change it. A path that is not inside one of the
 * listed folders is refused: a job's source and destination, folder browsing and checking,
 * previews, and everything an undo would put back. An empty list refuses everything.
 *
 * Paths are compared after their symlinks are resolved (the nearest existing ancestor is
 * resolved, the rest of the path is appended), so a link inside an allowed folder that points
 * elsewhere does not open a way out. A path with a `..` segment is refused outright rather than
 * guessed at. On Windows the comparison ignores case.
 */
export class AllowedFolders {
  private readonly roots: string[];

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => cleanFolderInput(root)).filter((root) => root.length > 0 && path.isAbsolute(root));
  }

  /** True when no folder is allowed (so everything is refused). */
  get isEmpty(): boolean {
    return this.roots.length === 0;
  }

  /** The configured folders, as written. Shown by the folder browser as its starting points. */
  list(): string[] {
    return [...this.roots];
  }

  /** A sentence for the person at the hub: why a path was refused. Null when the path is allowed. */
  async problemWith(target: string): Promise<string | null> {
    if (this.isEmpty) {
      return 'This machine has no allowed folders, so it refuses every folder. Add one in its worker settings (FILESHUTTLE_WORKER_ALLOWED_FOLDERS or worker.json).';
    }
    const text = cleanFolderInput(target);
    if (!text) return null;
    if (!path.isAbsolute(text)) return `“${target}” is not a full path.`;
    if (text.split(/[\\/]/).includes('..')) return `“${target}” contains “..”, which this machine does not accept.`;
    const real = await realOrNearest(text);
    for (const root of this.roots) {
      if (isInside(real, await realOrNearest(root))) return null;
    }
    return `“${target}” is outside the folders this machine allows.`;
  }

  /** Throws the problem as an Error, or returns when the path is allowed. */
  async assertAllowed(target: string): Promise<void> {
    const problem = await this.problemWith(target);
    if (problem) throw new Error(problem);
  }

  /** The problem with a mapping's folders (first one found), or null. A delete mapping has no destination. */
  async problemWithMapping(config: Pick<MappingConfig, 'sourcePath' | 'destPath' | 'actionType'>): Promise<string | null> {
    const first = await this.problemWith(config.sourcePath);
    if (first) return first;
    if (config.actionType !== 'delete' && config.destPath.trim()) return this.problemWith(config.destPath);
    return null;
  }

  /** The problem with any path an undo would touch (the whole undo is refused if there is one), or null. */
  async problemWithOutcomes(outcomes: readonly FileOutcome[]): Promise<string | null> {
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      for (const p of [outcome.sourcePath, outcome.destPath]) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        const problem = await this.problemWith(p);
        if (problem) return problem;
      }
    }
    return null;
  }

  /** What the folder check answers for a path: the usual answer, unless the path is not allowed. */
  async checkOrRefuse(target: string): Promise<FolderCheck | null> {
    const problem = await this.problemWith(target);
    return problem ? { status: 'invalid', message: problem } : null;
  }

  /** Folder browsing, limited to the allowed folders: the starting list is the allowed folders themselves. */
  async limitListing(requested: string | null | undefined, list: (p: string | null) => Promise<FolderListing>): Promise<FolderListing> {
    const cleaned = typeof requested === 'string' ? cleanFolderInput(requested) : '';
    if (!cleaned) {
      const folders: FolderEntry[] = this.roots.map((root) => ({ name: root, path: root }));
      return {
        path: null,
        parent: null,
        folders,
        truncated: false,
        ...(folders.length ? {} : { error: (await this.problemWith('/')) ?? undefined }),
      };
    }
    const problem = await this.problemWith(cleaned);
    if (problem) return { path: cleaned, parent: null, folders: [], truncated: false, error: problem };
    const listing = await list(cleaned);
    // Never offer a way up out of the allowed folders.
    if (listing.parent && (await this.problemWith(listing.parent))) return { ...listing, parent: null };
    return listing;
  }
}

/** The path with its symlinks resolved as far as it exists, and the rest appended unchanged. */
async function realOrNearest(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `parent` or lies beneath it. Uses the platform's own path rules; case-blind on Windows. */
export function isInside(child: string, parent: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const relative = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false; // another drive
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
