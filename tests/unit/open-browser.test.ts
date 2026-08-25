import { describe, expect, test } from "bun:test";
import { commandFor, openBrowser } from "../../apps/server/src/open";

describe("commandFor", () => {
  test("platform-specific open commands", () => {
    expect(commandFor("darwin")).toEqual(["open"]);
    // explorer.exe instead of `cmd /c start ""`: cmd's title parsing is
    // fragile and mis-resolved to the wrong application on real machines.
    expect(commandFor("win32")).toEqual(["explorer.exe"]);
    expect(commandFor("linux")).toEqual(["xdg-open"]);
  });
});

describe("openBrowser", () => {
  test("spawns the platform command with the url appended", () => {
    const calls: string[][] = [];
    const ok = openBrowser("http://localhost:3000", cmd => {
      calls.push(cmd);
    });
    expect(ok).toBe(true);
    // Platform here is win32 in CI/dev on Windows, darwin elsewhere, etc. —
    // assert the url is always last and the command is non-empty.
    expect(calls[0]!.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.at(-1)).toBe("http://localhost:3000");
  });

  test("a failing spawn never throws — returns false instead", () => {
    const ok = openBrowser("http://localhost:3000", () => {
      throw new Error("spawn failed");
    });
    expect(ok).toBe(false);
  });
});
