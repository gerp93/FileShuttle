import { Database } from 'sql.js';
import { RunResult } from '../../shared/types';
import * as repo from '../database/repository';
import { saveDatabase } from '../database/schema';
import { runMapping, undoRun } from '../engine/mover';

export function persistDb(db: Database): void {
  saveDatabase(db);
}

export async function executeMapping(
  db: Database,
  mappingId: number,
  triggerType: 'manual' | 'scheduled' | 'undo'
): Promise<RunResult> {
  const record = repo.getMapping(db, mappingId);
  if (!record) {
    throw new Error(`No mapping with id ${mappingId}`);
  }
  const chainResults = await runChain(db, mappingId, triggerType, new Set());
  persistDb(db);
  return chainResults[0][1];
}

async function runChain(
  db: Database,
  mappingId: number,
  triggerType: 'manual' | 'scheduled' | 'undo',
  visited: Set<number>
): Promise<Array<[number, RunResult]>> {
  const results: Array<[number, RunResult]> = [];
  let currentId: number | null = mappingId;
  let triggeredByRunId: number | null = null;

  while (currentId !== null && !visited.has(currentId)) {
    const record = repo.getMapping(db, currentId);
    if (!record) break;
    visited.add(currentId);

    const result = await runMapping(repo.toMappingConfig(record));
    const status = computeStatus(result);
    const runId = repo.recordRun(db, {
      mappingId: currentId,
      mappingNameSnapshot: record.name,
      triggerType,
      result,
      status,
      triggeredByRunId,
    });
    results.push([currentId, result]);

    triggeredByRunId = runId;
    currentId = record.nextMappingId;
  }

  return results;
}

export function executeUndo(db: Database, runId: number): RunResult {
  const originalRun = repo.getRun(db, runId);
  if (!originalRun) {
    throw new Error(`No run with id ${runId}`);
  }

  const fileOutcomes = repo.getRunDetail(db, runId);
  const result = undoRun(fileOutcomes);
  const status = computeStatus(result);

  const undoRunId = repo.recordRun(db, {
    mappingId: originalRun.mappingId,
    mappingNameSnapshot: `Undo of “${baseMappingName(db, originalRun)}”`,
    triggerType: 'undo',
    result,
    status,
  });
  repo.markRunUndone(db, runId, undoRunId);
  persistDb(db);
  return result;
}

function baseMappingName(db: Database, run: { mappingId: number; mappingNameSnapshot: string }): string {
  const record = repo.getMapping(db, run.mappingId);
  if (record) return record.name;
  const snapshot = run.mappingNameSnapshot;
  if (snapshot.startsWith('Undo of “') && snapshot.endsWith('”')) {
    return snapshot.slice('Undo of “'.length, -1);
  }
  return snapshot;
}

export async function executeAllEnabled(
  db: Database,
  triggerType: 'manual' | 'scheduled'
): Promise<Array<[number, RunResult]>> {
  const visited = new Set<number>();
  const allResults: Array<[number, RunResult]> = [];
  for (const record of repo.listMappings(db, true)) {
    if (visited.has(record.id)) continue;
    allResults.push(...(await runChain(db, record.id, triggerType, visited)));
  }
  persistDb(db);
  return allResults;
}

function computeStatus(result: RunResult): 'success' | 'partial' | 'error' {
  const accomplished = result.filesMoved + result.filesDeleted;
  if (result.filesErrored && !accomplished) return 'error';
  if ((result.filesErrored || result.filesSkipped) && accomplished) return 'partial';
  return 'success';
}
