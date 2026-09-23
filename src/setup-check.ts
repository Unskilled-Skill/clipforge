type CaptureServices = {
  save: () => Promise<string>;
  prepare: (path: string) => Promise<string>;
};

export async function captureSetupSample(services: CaptureServices, timeoutMs = 45000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Saving the sample timed out. Check OBS and try again.")), timeoutMs);
    });
    return await Promise.race([services.save().then(services.prepare), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
