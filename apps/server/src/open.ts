/**
 * Cross-platform browser opener (kept injectable for unit tests).
 * Mirrors what Prisma Studio does after binding its port.
 */

export type SpawnFn = (command: string[]) => unknown;

/** The command that opens a URL on the given platform. */
export function commandFor(platform: string): string[] {
  if (platform === "darwin") return ["open"];
  if (platform === "win32") {
    // NOT `cmd /c start ""`: cmd's title-argument parsing is fragile when the
    // args are re-quoted by a runtime, and a mangled line can resolve to an
    // arbitrary registered handler. explorer.exe delegates straight to the
    // default http handler with no parsing games.
    return ["explorer.exe"];
  }
  return ["xdg-open"];
}

/** Best effort: never let a failed browser launch crash the server. */
export function openBrowser(url: string, spawn: SpawnFn = defaultSpawn): boolean {
  try {
    spawn([...commandFor(process.platform), url]);
    return true;
  } catch {
    return false;
  }
}

const defaultSpawn: SpawnFn = command => {
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
};
