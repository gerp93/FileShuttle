import { describe, expect, it } from 'vitest';
import { isSameFolder, isSameOrInside, normalizeFolder, validateMappingPaths } from './pathSafety';

describe('normalizeFolder', () => {
  it('unifies slashes, strips trailing ones, and folds case for Windows paths', () => {
    expect(normalizeFolder('C:\\Users\\Me\\Downloads\\')).toBe('c:/users/me/downloads');
    expect(normalizeFolder('c:/USERS/me/downloads')).toBe('c:/users/me/downloads');
  });

  it('keeps case for POSIX paths and the root', () => {
    expect(normalizeFolder('/Home/Me/')).toBe('/Home/Me');
    expect(normalizeFolder('/')).toBe('/');
  });

  it('keeps a drive root intact', () => {
    expect(normalizeFolder('C:\\')).toBe('c:/');
  });
});

describe('isSameFolder / isSameOrInside', () => {
  it('treats differently-written Windows paths as the same folder', () => {
    expect(isSameFolder('C:\\Data\\In', 'c:/data/in/')).toBe(true);
  });

  it('detects nesting', () => {
    expect(isSameOrInside('C:\\Data\\In\\Done', 'C:\\Data\\In')).toBe(true);
    expect(isSameOrInside('C:\\Data\\In', 'C:\\Data\\In')).toBe(true);
    expect(isSameOrInside('C:\\Data', 'C:\\Data\\In')).toBe(false);
  });

  it('does not confuse a sibling that shares a name prefix', () => {
    expect(isSameOrInside('C:\\Data\\Input2', 'C:\\Data\\In')).toBe(false);
    expect(isSameOrInside('/data/input2', '/data/in')).toBe(false);
  });

  it('works under a drive root', () => {
    expect(isSameOrInside('C:\\Anything', 'C:\\')).toBe(true);
  });
});

describe('validateMappingPaths', () => {
  const base = { actionType: 'move' as const, sourcePath: 'C:\\in', destPath: 'C:\\out', recursive: false };

  it('accepts ordinary, separate folders', () => {
    expect(validateMappingPaths(base)).toBeNull();
  });

  it('rejects the same folder for any non-delete action', () => {
    for (const actionType of ['move', 'copy', 'zip', 'unzip'] as const) {
      expect(validateMappingPaths({ ...base, actionType, destPath: 'c:/IN/' })).toMatch(/same folder/);
    }
  });

  it('allows a destination inside the source when subfolders are not walked', () => {
    expect(validateMappingPaths({ ...base, destPath: 'C:\\in\\sorted' })).toBeNull();
  });

  it('rejects a destination inside the source for recursive mappings', () => {
    for (const actionType of ['move', 'copy', 'unzip'] as const) {
      expect(
        validateMappingPaths({ ...base, actionType, recursive: true, destPath: 'C:\\in\\sorted' })
      ).toMatch(/inside the source/);
    }
  });

  it('rejects a destination inside the source for zip even without recursion', () => {
    expect(validateMappingPaths({ ...base, actionType: 'zip', destPath: 'C:\\in\\archive' })).toMatch(
      /zipped into its own archives/
    );
  });

  it('allows the source to be inside the destination', () => {
    expect(validateMappingPaths({ ...base, recursive: true, sourcePath: 'C:\\out\\in', destPath: 'C:\\out' })).toBeNull();
  });

  it('ignores the destination for delete mappings', () => {
    expect(validateMappingPaths({ ...base, actionType: 'delete', destPath: '' })).toBeNull();
    expect(validateMappingPaths({ ...base, actionType: 'delete', destPath: 'C:\\in' })).toBeNull();
  });
});
