import * as fs from 'fs';
import { DownloadOrigin, parseZoneIdentifier } from '../../shared/downloadSource';

/** A Zone.Identifier stream is a few hundred bytes; never read more than this. */
const MAX_STREAM_BYTES = 16 * 1024;

/**
 * Reads where a file was downloaded from, out of its NTFS `Zone.Identifier`
 * alternate data stream. Resolves to null when there is nothing to read: not
 * Windows, not NTFS, a file that never came from a browser, or a stream that
 * names no URL. Never throws -- an unreadable stream just means "unknown origin".
 */
export async function readDownloadOrigin(filePath: string): Promise<DownloadOrigin | null> {
  if (process.platform !== 'win32') return null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(`${filePath}:Zone.Identifier`, 'r');
    const buffer = Buffer.alloc(MAX_STREAM_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_STREAM_BYTES, 0);
    return parseZoneIdentifier(decodeStream(buffer.subarray(0, bytesRead)));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Browsers write the stream as UTF-8 (Windows' own tools sometimes write UTF-16). */
function decodeStream(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8').replace(/^﻿/, '');
}
