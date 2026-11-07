import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'sql.js';
import { cleanFolderInput } from '../../shared/pathSafety';
import { normalizeDailyTimes, validateJobInput } from '../../shared/schedule';
import { CreateJobInput, CreateMappingInput, FilterRule } from '../../shared/types';
import { validateMappingInput } from '../../shared/validation';
import * as repo from '../database/repository';
import { checkFolder } from '../folderCheck';

/**
 * The assistant's whole write surface. It can save mappings and jobs and nothing else, and what it
 * saves is constrained here, in code, not by the prompt:
 *  - a job it saves is always saved DISABLED, so nothing it sets up can run (on a schedule or by a
 *    watched folder) until the user has looked at it and turned it on;
 *  - a mapping it saves has no schedule of its own (jobs own scheduling);
 *  - it can never run, delete, enable, or undo anything.
 */

export interface AssistantMappingInput {
  /** Set to update an existing mapping; leave out to create one. */
  id?: number;
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  actionType: CreateMappingInput['actionType'];
  conflictPolicy: CreateMappingInput['conflictPolicy'];
  filters: FilterRule[];
  keepNewest: number | null;
  keepNewestPerExtension: boolean;
}

export interface AssistantJobInput {
  /** Set to update an existing job; leave out to create one. */
  id?: number;
  name: string;
  scheduleType: CreateJobInput['scheduleType'];
  scheduleIntervalMinutes: number | null;
  scheduleDailyTimes: string[];
  catchUp: boolean;
  /** Mapping ids, in the order the job runs them. */
  mappingIds: number[];
}

/** Turns the assistant's mapping into the app's input. Preserves what the assistant must not change. */
export function toMappingInput(db: Database, input: AssistantMappingInput): CreateMappingInput {
  const existing = input.id != null ? repo.getMapping(db, input.id) : null;
  if (input.id != null && !existing) throw new Error(`There is no mapping with id ${input.id}.`);
  return {
    name: input.name.trim(),
    sourcePath: cleanFolderInput(input.sourcePath),
    destPath: cleanFolderInput(input.destPath),
    recursive: input.recursive,
    conflictPolicy: input.conflictPolicy,
    // Whether a step is switched on is the user's call; a new one is on (it only ever runs inside a job).
    enabled: existing ? existing.enabled : true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    filters: input.filters.map((rule) => ({ ...rule, value: rule.value.trim() })),
    nextMappingId: existing ? existing.nextMappingId : null,
    actionType: input.actionType,
    keepNewest: input.keepNewest,
    keepNewestPerExtension: input.keepNewestPerExtension,
  };
}

export function toJobInput(input: AssistantJobInput): CreateJobInput {
  return {
    name: input.name.trim(),
    // Always off: the user reviews the job and switches it on themselves.
    enabled: false,
    catchUp: input.catchUp,
    scheduleType: input.scheduleType,
    scheduleIntervalMinutes: input.scheduleType === 'interval' ? input.scheduleIntervalMinutes : null,
    scheduleDailyTimes: input.scheduleType === 'daily_at' ? normalizeDailyTimes(input.scheduleDailyTimes) : [],
    mappingIds: input.mappingIds,
  };
}

export interface MappingCheck {
  /** Problems that stop the mapping being saved. */
  errors: string[];
  /** Things worth the user's attention, but not blocking. */
  warnings: string[];
}

/** Everything that can be said about a mapping before saving it, including what is on disk right now. */
export async function checkMapping(db: Database, input: AssistantMappingInput): Promise<MappingCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let converted: CreateMappingInput;
  try {
    converted = toMappingInput(db, input);
  } catch (e) {
    return { errors: [e instanceof Error ? e.message : String(e)], warnings };
  }
  const problem = validateMappingInput(converted);
  if (problem) errors.push(problem);

  const source = await checkFolder(converted.sourcePath, 'source');
  if (source.status !== 'ok' && source.message) {
    (source.status === 'missing' ? warnings : errors).push(`Source folder: ${source.message}`);
  }
  if (converted.actionType !== 'delete') {
    const dest = await checkFolder(converted.destPath, 'destination');
    if (dest.status !== 'ok' && dest.message) {
      (dest.status === 'will_create' || dest.status === 'missing' ? warnings : errors).push(
        `Destination folder: ${dest.message}`
      );
    }
  }
  if (converted.actionType === 'delete') {
    warnings.push('This mapping DELETES the matching files (to the Recycle Bin where available).');
  }
  if (converted.conflictPolicy === 'overwrite' && converted.actionType !== 'delete') {
    warnings.push('Conflict policy is "overwrite": files already at the destination will be replaced.');
  }
  if (converted.actionType === 'delete' && converted.filters.length === 0 && converted.keepNewest == null) {
    warnings.push('A delete mapping with no filters would delete EVERY file in the source folder.');
  }
  if (converted.keepNewest != null && (converted.actionType === 'copy' || converted.actionType === 'zip')) {
    warnings.push('"Keep newest" is ignored for copy and zip mappings.');
  }
  return { errors, warnings };
}

export function checkJob(db: Database, input: AssistantJobInput): MappingCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (input.id != null && !repo.getJob(db, input.id)) errors.push(`There is no job with id ${input.id}.`);
  const problem = validateJobInput(toJobInput(input));
  if (problem) errors.push(problem);
  for (const id of input.mappingIds) {
    const mapping = repo.getMapping(db, id);
    if (!mapping) errors.push(`There is no mapping with id ${id}.`);
    else if (!mapping.enabled) {
      warnings.push(`Mapping "${mapping.name}" is switched off, so this job would skip that step.`);
    }
  }
  if (input.scheduleType === 'watch') {
    warnings.push('A "watch" job runs whenever files appear in the first step\'s source folder, once it is switched on.');
  }
  return { errors, warnings };
}

/** Saves (creates or updates) a mapping. Throws on validation problems. Returns the mapping's id. */
export function saveMapping(db: Database, input: AssistantMappingInput): number {
  const converted = toMappingInput(db, input);
  const problem = validateMappingInput(converted);
  if (problem) throw new Error(problem);
  if (input.id != null) {
    repo.updateMapping(db, input.id, converted);
    return input.id;
  }
  return repo.createMapping(db, converted);
}

/** Saves (creates or updates) a job, switched off. Throws on validation problems. Returns the job's id. */
export function saveJob(db: Database, input: AssistantJobInput): number {
  const check = checkJob(db, input);
  if (check.errors.length) throw new Error(check.errors.join(' '));
  const converted = toJobInput(input);
  if (input.id != null) {
    repo.updateJob(db, input.id, converted);
    return input.id;
  }
  return repo.createJob(db, converted);
}

export interface FolderEntry {
  path: string;
  type: 'file' | 'folder';
  sizeBytes: number | null;
  modified: string;
}

export interface FolderListing {
  folder: string;
  entries: FolderEntry[];
  /** True when the listing stopped at the limit. */
  truncated: boolean;
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  /** Files per extension (lower-case, no dot) among the entries listed. */
  extensionCounts: Record<string, number>;
}

export const FOLDER_LIST_DEFAULT_LIMIT = 100;
export const FOLDER_LIST_MAX_LIMIT = 300;
export const FOLDER_LIST_MAX_DEPTH = 3;

/**
 * Names, sizes and dates of what is in a folder. Never file contents. Breadth-first, so a shallow
 * look is not crowded out by one deep folder.
 */
export async function listFolder(
  rawFolder: string,
  options: { recursive?: boolean; limit?: number } = {}
): Promise<FolderListing> {
  const folder = cleanFolderInput(rawFolder);
  if (!path.isAbsolute(folder)) throw new Error('Give the full path to the folder, for example C:\\Users\\you\\Downloads.');
  const stat = await fs.promises.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('That path is not a folder that can be reached right now.');

  const limit = Math.max(1, Math.min(options.limit ?? FOLDER_LIST_DEFAULT_LIMIT, FOLDER_LIST_MAX_LIMIT));
  const maxDepth = options.recursive ? FOLDER_LIST_MAX_DEPTH : 1;
  const listing: FolderListing = {
    folder,
    entries: [],
    truncated: false,
    fileCount: 0,
    folderCount: 0,
    totalBytes: 0,
    extensionCounts: {},
  };

  let level = [folder];
  for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (listing.entries.length >= limit) {
          listing.truncated = true;
          return listing;
        }
        const full = path.join(dir, name);
        const info = await fs.promises.lstat(full).catch(() => null);
        if (!info) continue;
        const isFolder = info.isDirectory();
        listing.entries.push({
          path: path.relative(folder, full),
          type: isFolder ? 'folder' : 'file',
          sizeBytes: isFolder ? null : info.size,
          modified: info.mtime.toISOString(),
        });
        if (isFolder) {
          listing.folderCount += 1;
          // Do not follow links out of the folder being looked at.
          if (!info.isSymbolicLink()) next.push(full);
        } else {
          listing.fileCount += 1;
          listing.totalBytes += info.size;
          const dot = name.lastIndexOf('.');
          const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
          listing.extensionCounts[ext] = (listing.extensionCounts[ext] ?? 0) + 1;
        }
      }
    }
    level = next;
  }
  return listing;
}
