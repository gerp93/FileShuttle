import { isSameFolder, isSameOrInside, normalizeFolder } from './pathSafety';
import type { ActionType } from './types';

export interface WatchStep {
  enabled: boolean;
  actionType: ActionType;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
}

export interface WatchTarget {
  path: string;
  recursive: boolean;
}

/** Folders a job writes into -- anything appearing there is the job's own output, not new input. */
export function outputFolders(steps: WatchStep[]): string[] {
  return steps
    .filter((step) => step.enabled && step.actionType !== 'delete' && step.destPath.trim())
    .map((step) => step.destPath);
}

/**
 * Which folders a watch-mode job should watch: the source of every enabled
 * step (not only the first), minus any folder the job itself writes into --
 * otherwise a job whose second step reads what its first step produced would
 * re-trigger itself on its own output.
 */
export function watchTargets(steps: WatchStep[]): WatchTarget[] {
  const outputs = outputFolders(steps);
  const byFolder = new Map<string, WatchTarget>();

  for (const step of steps) {
    if (!step.enabled || !step.sourcePath.trim()) continue;
    if (outputs.some((out) => isSameFolder(out, step.sourcePath))) continue;
    const key = normalizeFolder(step.sourcePath);
    const existing = byFolder.get(key);
    byFolder.set(key, { path: step.sourcePath, recursive: (existing?.recursive ?? false) || step.recursive });
  }
  return [...byFolder.values()];
}

/** True for a path inside (or equal to) any folder the job writes into. */
export function isJobOutputPath(candidate: string, steps: WatchStep[]): boolean {
  return outputFolders(steps).some((out) => isSameOrInside(candidate, out));
}
