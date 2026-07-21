let initializationQueue: Promise<void> = Promise.resolve();

// ONNX Runtime's WASM backend is process-global. Creating sessions from two
// entry points concurrently can race while the worker/runtime is bootstrapping.
export function serializeOnnxSessionInitialization<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = initializationQueue.catch(() => {}).then(operation);
  initializationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
