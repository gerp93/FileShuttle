/** Resolves after SIGTERM or SIGINT, once `stop` has finished. */
export function waitForSignal(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const handler = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down`);
      stop().then(resolve, (err) => {
        console.error('error while shutting down:', err);
        resolve();
      });
    };
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  });
}
