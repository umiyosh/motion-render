// Claude Code installs a plugin's packages only when package.json and package-lock.json list the
// same dependencies (#86). The lock once also listed the optional onnxruntime-node under
// "dependencies", so from 1.2.0 the plugin was installed without node_modules and every command
// stopped with ERR_MODULE_NOT_FOUND.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FIELDS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

type Deps = Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;

function read(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function depsOf(value: unknown): Deps {
  if (typeof value !== "object" || value === null) return {};
  const v = value as Record<string, unknown>;
  return Object.fromEntries(FIELDS.filter((f) => v[f] !== undefined).map((f) => [f, v[f]]));
}

function lockRoot(file: string): unknown {
  const lock = read(file);
  if (typeof lock !== "object" || lock === null || !("packages" in lock))
    throw new Error(`${file}: no "packages"`);
  return (lock.packages as Record<string, unknown>)[""];
}

describe("package-lock.json lists the same dependencies as package.json", () => {
  it.each(["", "skills/motion-render"])("in %s/", (dir) => {
    const at = join(ROOT, dir);
    expect(depsOf(lockRoot(join(at, "package-lock.json")))).toEqual(
      depsOf(read(join(at, "package.json")))
    );
  });
});
