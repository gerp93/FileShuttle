/** Sends a path to the Recycle Bin. Injected so the engine can run (and be tested) outside Electron. */
export type TrashFn = (filePath: string) => Promise<void>;

export const electronTrash: TrashFn = async (filePath) => {
  const { shell } = await import('electron');
  await shell.trashItem(filePath);
};
