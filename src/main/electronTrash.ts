import { shell } from 'electron';
import type { TrashFn } from './engine/trash';

/** Desktop only: Electron's own "move to the Recycle Bin / trash". */
export const electronTrash: TrashFn = async (filePath) => {
  await shell.trashItem(filePath);
};
