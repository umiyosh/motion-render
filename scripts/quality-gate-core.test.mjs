import test from "node:test";
import assert from "node:assert/strict";
import {
  REFUSE_WORSENED_BASELINE_MESSAGE,
  buildBaselineDocument,
  buildSummary,
  canUpdateBaseline,
  compareIssues,
  filterIssuesForScope,
  knipIssuesFromReport,
  normalizeIssue,
  parseQualityGateArgs,
  parseMetricFromEslintMessage,
} from "./quality-gate-core.mjs";

test("existing max-lines が悪化したら worsenedIssues になる", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [appFileLinesIssue(4645, 700)],
  });

  assert.equal(comparison.worsenedIssues.length, 1);
  assert.equal(comparison.worsenedIssues[0].delta, 367);
  assert.equal(comparison.newIssues.length, 0);
  assert.equal(comparison.resolvedIssues.length, 0);
});

test("existing max-lines が改善したら improvedIssues になる", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [appFileLinesIssue(3990, 400)],
  });

  assert.equal(comparison.improvedIssues.length, 1);
  assert.equal(comparison.improvedIssues[0].delta, -288);
});

test("existing max-lines が同値なら差分なしになる", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [appFileLinesIssue(4278, 700)],
  });

  assert.equal(comparison.worsenedIssues.length, 0);
  assert.equal(comparison.improvedIssues.length, 0);
  assert.equal(comparison.newIssues.length, 0);
  assert.equal(comparison.resolvedIssues.length, 0);
});

test("issue が消えたら resolvedIssues になる", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [],
  });

  assert.equal(comparison.resolvedIssues.length, 1);
});

test("新しい issue が出たら newIssues になる", () => {
  const comparison = compareIssues({
    baselineIssues: [],
    currentIssues: [appFileLinesIssue(4278, 526)],
  });

  assert.equal(comparison.newIssues.length, 1);
});

test("App 関数は line number が変わっても stableKey で比較される", () => {
  const comparison = compareIssues({
    baselineIssues: [appFunctionLinesIssue(3634, 223)],
    currentIssues: [appFunctionLinesIssue(3634, 350)],
  });

  assert.equal(
    comparison.currentIssues[0].stableKey,
    "eslint|max-lines-per-function|src/App.tsx|function:App"
  );
  assert.equal(comparison.newIssues.length, 0);
  assert.equal(comparison.resolvedIssues.length, 0);
});

test("protected targets は要求された stableKey で追跡される", () => {
  const issues = [
    appFileLinesIssue(4278, 526),
    appFunctionLinesIssue(3634, 223),
    {
      id: "eslint|complexity|src/App.tsx|223|8",
      tool: "eslint",
      category: "complexity",
      path: "src/App.tsx",
      line: 223,
      column: 8,
      detail: "Function 'App' has a complexity of 116. Maximum allowed is 20.",
    },
    {
      id: "eslint|max-lines-per-function|src/features/playback/model/usePlaybackController.ts|43|8",
      tool: "eslint",
      category: "max-lines-per-function",
      path: "src/features/playback/model/usePlaybackController.ts",
      line: 43,
      column: 8,
      detail: "Function 'usePlaybackController' has too many lines (361). Maximum allowed is 120.",
    },
  ].map((issue) => normalizeIssue(issue));

  assert.deepEqual(
    issues.map((issue) => issue.stableKey),
    [
      "eslint|max-lines|src/App.tsx|file",
      "eslint|max-lines-per-function|src/App.tsx|function:App",
      "eslint|complexity|src/App.tsx|function:App",
      "eslint|max-lines-per-function|src/features/playback/model/usePlaybackController.ts|function:usePlaybackController",
    ]
  );
});

test("quality:update-baseline は worsenedIssues がある場合に拒否される", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [appFileLinesIssue(4645, 700)],
  });

  const decision = canUpdateBaseline(comparison, true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, REFUSE_WORSENED_BASELINE_MESSAGE);
});

test("quality:update-baseline は improvedIssues のみなら許可される", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [appFileLinesIssue(3990, 400)],
  });

  assert.equal(canUpdateBaseline(comparison, true).allowed, true);
});

test("quality:update-baseline は resolvedIssues のみなら許可される", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526)],
    currentIssues: [],
  });

  assert.equal(canUpdateBaseline(comparison, true).allowed, true);
});

test("version 1 baseline issue でも metric と stableKey を補完できる", () => {
  const normalized = normalizeIssue({
    id: "eslint|complexity|src/App.tsx|223|8",
    tool: "eslint",
    category: "complexity",
    path: "src/App.tsx",
    line: 223,
    detail: "Function 'App' has a complexity of 116. Maximum allowed is 20.",
  });

  assert.deepEqual(normalized.metric, {
    name: "complexity",
    value: 116,
    limit: 20,
    direction: "lowerIsBetter",
  });
  assert.equal(normalized.stableKey, "eslint|complexity|src/App.tsx|function:App");
});

test("version 1 baseline の ESLint column を id から補完できる", () => {
  const normalized = normalizeIssue({
    id: "eslint|max-lines-per-function|src/shared/api/appBackend.test.ts|49|30",
    tool: "eslint",
    category: "max-lines-per-function",
    path: "src/shared/api/appBackend.test.ts",
    line: 49,
    detail: "Arrow function has too many lines (290). Maximum allowed is 120.",
  });

  assert.equal(
    normalized.stableKey,
    "eslint|max-lines-per-function|src/shared/api/appBackend.test.ts|line:49:column:30"
  );
});

test("baseline document は version 2 と normalized issue を書き出す", () => {
  const baseline = buildBaselineDocument({
    issues: [appFileLinesIssue(4278, 526)],
    thresholds: {},
  });

  assert.equal(baseline.version, 2);
  assert.equal(baseline.issues[0].stableKey, "eslint|max-lines|src/App.tsx|file");
  assert.equal(baseline.issues[0].metric.value, 4278);
});

test("metric が parse できない issue は従来の id 比較に fallback する", () => {
  const baseline = unparseableIssue("custom|src/example.ts|10");
  const current = unparseableIssue("custom|src/example.ts|10");
  const comparison = compareIssues({
    baselineIssues: [baseline],
    currentIssues: [current],
  });

  assert.equal(comparison.newIssues.length, 0);
  assert.equal(comparison.resolvedIssues.length, 0);
  assert.equal(comparison.currentIssues[0].stableKey, current.id);
});

test("summary に worsened と improved の列とセクションが表示される", () => {
  const comparison = compareIssues({
    baselineIssues: [appFileLinesIssue(4278, 526), appFunctionLinesIssue(3634, 223)],
    currentIssues: [appFileLinesIssue(4645, 700), appFunctionLinesIssue(3500, 350)],
  });

  const summary = buildSummary(comparison);
  assert.match(summary, /worsened \| improved/);
  assert.match(summary, /### Worsened baseline entries/);
  assert.match(summary, /### Improved baseline entries/);
});

test("ESLint metric parser は主要 protected target の metric を読む", () => {
  assert.equal(
    parseMetricFromEslintMessage(
      "Function 'usePlaybackController' has too many lines (361). Maximum allowed is 120.",
      "max-lines-per-function"
    )?.value,
    361
  );
});

test("quality gate args は scope 指定を解釈する", () => {
  assert.deepEqual(parseQualityGateArgs(["--scope", "ts"]), {
    scope: "ts",
    updateBaseline: false,
    initBaseline: false,
  });
  assert.throws(() => parseQualityGateArgs(["--scope=rust"]), /Invalid quality gate scope: rust/);
});

test("partial scope では baseline update を拒否する", () => {
  assert.throws(
    () => parseQualityGateArgs(["--scope", "ts", "--update-baseline"]),
    /Partial quality baseline updates are not supported/
  );
});

test("quality gate scope ts は ESLint と Knip の issue だけを残す", () => {
  const issues = [
    appFileLinesIssue(4278, 526),
    {
      id: "knip|files|src/unused.ts|0",
      tool: "knip",
      category: "files",
      path: "src/unused.ts",
      line: null,
      detail: "unused",
    },
    unparseableIssue("custom|src/example.ts|10"),
  ];

  assert.deepEqual(
    filterIssuesForScope(issues, "ts").map((issue) => issue.tool),
    ["eslint", "knip"]
  );
  assert.equal(filterIssuesForScope(issues, "all").length, 3);
});

function appFileLinesIssue(value, line) {
  return {
    id: `eslint|max-lines|src/App.tsx|${line}|1`,
    tool: "eslint",
    category: "max-lines",
    path: "src/App.tsx",
    line,
    column: 1,
    detail: `File has too many lines (${value}). Maximum allowed is 500.`,
  };
}

function appFunctionLinesIssue(value, line) {
  return {
    id: `eslint|max-lines-per-function|src/App.tsx|${line}|8`,
    tool: "eslint",
    category: "max-lines-per-function",
    path: "src/App.tsx",
    line,
    column: 8,
    detail: `Function 'App' has too many lines (${value}). Maximum allowed is 120.`,
  };
}

function unparseableIssue(id) {
  return {
    id,
    tool: "custom",
    category: "unknown",
    path: "src/example.ts",
    line: 10,
    detail: "unparseable detail",
  };
}

test("Knip 6 のファイル単位の JSON から種類ごとの issue を作る", () => {
  const issues = knipIssuesFromReport({
    issues: [
      {
        file: "src/a.ts",
        exports: [{ name: "unusedFn", line: 3, col: 17 }],
        types: [{ name: "UnusedType", line: 9 }],
        dependencies: [],
        binaries: [{ name: "ffmpeg" }],
      },
    ],
  });

  assert.deepEqual(
    issues.map((issue) => [issue.category, issue.path, issue.detail, issue.line]),
    [
      ["exports", "src/a.ts", "unusedFn", 3],
      ["types", "src/a.ts", "UnusedType", 9],
      ["binaries", "src/a.ts", "ffmpeg", null],
    ]
  );
});

test("async 関数の complexity も関数名と metric で追跡する", () => {
  const normalized = normalizeIssue({
    id: "eslint|complexity|skills/motion-render/scripts/cli.ts|210|1",
    tool: "eslint",
    category: "complexity",
    path: "skills/motion-render/scripts/cli.ts",
    line: 210,
    column: 1,
    detail: "Async function 'main' has a complexity of 25. Maximum allowed is 20.",
  });

  assert.equal(
    normalized.stableKey,
    "eslint|complexity|skills/motion-render/scripts/cli.ts|function:main"
  );
  assert.equal(normalized.metric.value, 25);
});
