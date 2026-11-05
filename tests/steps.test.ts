// The log of a run's steps (steps.jsonl) and the table made from it.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readSteps,
  stepRows,
  stepsTable,
  timed,
  workOf,
} from "../skills/motion-render/scripts/steps.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");

function work(): string {
  const dir = tempDir("mr-steps-");
  writeFileSync(join(dir, "script.json"), "{}");
  mkdirSync(join(dir, "film"));
  return dir;
}

const step = (cmd: string, start: number, end: number, ok = true) => ({ cmd, start, end, ok });

describe("workOf", () => {
  it("finds the work dir of a work dir and of its film dir, and nothing elsewhere", () => {
    const dir = work();
    expect(workOf(dir)).toBe(dir);
    expect(workOf(join(dir, "film"))).toBe(dir);
    expect(workOf(tempDir())).toBeNull();
  });
});

describe("timed", () => {
  it("logs a command that succeeds and one that fails", async () => {
    const dir = work();
    expect(await timed(dir, "narrate", () => 1)).toBe(1);
    await expect(
      timed(dir, "check", () => Promise.reject(new Error("3 layout issues")))
    ).rejects.toThrow("3 layout issues");
    expect(readSteps(dir).map(({ cmd, ok }) => [cmd, ok])).toEqual([
      ["narrate", true],
      ["check", false],
    ]);
  });

  it("logs nothing without a work dir, and skips a broken line", async () => {
    expect(await timed(null, "check", () => "ok")).toBe("ok");
    const dir = work();
    writeFileSync(join(dir, "steps.jsonl"), '{"cmd":"kit","start":1,"end":2,"ok":true}\n{"cmd":');
    expect(readSteps(dir)).toEqual([step("kit", 1, 2)]);
  });
});

describe("stepRows", () => {
  it("gives the time between foreground commands to Claude and lists background ones beside it", () => {
    const rows = stepRows(
      [
        step("narrate", 120_000, 140_000),
        step("bgm", 141_000, 170_000),
        step("sfx", 142_000, 160_000),
        step("kit", 140_500, 141_000),
        step("check", 400_000, 430_000, false),
        step("check", 431_500, 450_000),
      ].sort((a, b) => a.start - b.start),
      0
    );
    expect(rows).toEqual([
      { at: 0, step: "Claude", seconds: 120 },
      { at: 120, step: "narrate", seconds: 20 },
      { at: 140.5, step: "kit", seconds: 0.5 },
      { at: 141, step: "bgm (background)", seconds: 29 },
      { at: 142, step: "sfx (background)", seconds: 18 },
      { at: 141, step: "Claude", seconds: 259 },
      { at: 400, step: "check (failed)", seconds: 30 },
      { at: 430, step: "Claude", seconds: 1.5 },
      { at: 431.5, step: "check", seconds: 18.5 },
    ]);
  });

  it("counts commands that overlap once", () => {
    const rows = stepRows([step("check", 0, 10_000), step("check", 2_000, 12_000)], 0);
    expect(rows.map((r) => r.step)).toEqual(["check", "check"]);
  });
});

describe("the times command", () => {
  it("prints the commands the CLI logged as a table with totals", () => {
    const dir = work();
    writeFileSync(join(dir, "timing.json"), JSON.stringify({ total: 1, scenes: [] }));
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    run("kit", dir);
    const log = readFileSync(join(dir, "steps.jsonl"), "utf8");
    expect(log).toMatch(/"cmd":"kit"/);
    const table = run("times", dir);
    expect(table).toContain("| Start | Step | Time |");
    expect(table).toMatch(/\| kit \| \d+\.\d s \|/);
    expect(table).toMatch(/^total .*: Claude .*, waiting on commands /m);
    expect(stepsTable(tempDir())).toMatch(/^no steps logged/);
  });
});
