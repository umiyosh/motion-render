export const QUALITY_BASELINE_VERSION = 2;
export const QUALITY_GATE_SCOPES = new Set(["all", "ts"]);
export const QUALITY_BASELINE_POLICY =
  "Every current quality violation is a repayment target. The baseline exists to prevent increases and track reductions.";
export const REFUSE_WORSENED_BASELINE_MESSAGE =
  "Refusing to update quality baseline because current violations are worse than the baseline.\nFix the regression instead of ratcheting the baseline upward.";

export function issueId(parts) {
  return parts.map((part) => String(part).replaceAll("|", "/")).join("|");
}

export function parseQualityGateArgs(args) {
  const options = {
    scope: "all",
    updateBaseline: false,
    initBaseline: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    if (arg === "--init-baseline") {
      options.initBaseline = true;
      continue;
    }
    if (arg === "--scope") {
      index += 1;
      options.scope = requireQualityGateScope(args[index]);
      continue;
    }
    if (arg.startsWith("--scope=")) {
      options.scope = requireQualityGateScope(arg.slice("--scope=".length));
      continue;
    }

    throw new Error(`Unknown quality gate argument: ${arg}`);
  }

  if (options.scope !== "all" && (options.updateBaseline || options.initBaseline)) {
    throw new Error("Partial quality baseline updates are not supported.");
  }

  return options;
}

export function issueMatchesScope(issue, scope) {
  if (scope === "all") {
    return true;
  }

  if (scope === "ts") {
    return ["eslint", "knip"].includes(issue.tool);
  }

  requireQualityGateScope(scope);
  return false;
}

export function filterIssuesForScope(issues, scope) {
  return issues.filter((issue) => issueMatchesScope(issue, scope));
}

export function parseMetricFromEslintMessage(message, category = "") {
  const parsers = [
    {
      category: "complexity",
      name: "complexity",
      pattern:
        /^(?:Async )?(?:[Ff]unction|[Mm]ethod) '.+' has a complexity of (\d+). Maximum allowed is (\d+)\.$/,
    },
    {
      category: "max-lines-per-function",
      name: "functionLines",
      pattern:
        /^(?:(?:Async )?(?:[Ff]unction|[Mm]ethod) '.+'|(?:Async )?[Aa]rrow function) has too many lines \((\d+)\). Maximum allowed is (\d+)\.$/,
    },
    {
      category: "max-lines",
      name: "lines",
      pattern: /^File has too many lines \((\d+)\). Maximum allowed is (\d+)\.$/,
    },
    {
      category: "max-params",
      name: "arguments",
      pattern:
        /^(?:(?:Async )?(?:[Ff]unction|[Mm]ethod) '.+'|(?:Async )?[Aa]rrow function) has too many parameters \((\d+)\). Maximum allowed is (\d+)\.$/,
    },
  ];

  for (const parser of parsers) {
    if (category && parser.category !== category) {
      continue;
    }
    const match = message.match(parser.pattern);
    if (match) {
      return lowerIsBetterMetric(parser.name, match[1], match[2]);
    }
  }

  return undefined;
}

function requireQualityGateScope(scope) {
  if (!QUALITY_GATE_SCOPES.has(scope)) {
    throw new Error(
      `Invalid quality gate scope: ${scope}. Expected one of: ${[...QUALITY_GATE_SCOPES].join(
        ", "
      )}`
    );
  }
  return scope;
}

export function buildStableKey(issue) {
  if (issue.stableKey) {
    return issue.stableKey;
  }

  if (issue.tool === "eslint") {
    return buildEslintStableKey(issue);
  }

  return issue.id;
}

export function normalizeIssue(issue) {
  const normalized = {
    ...issue,
    line: issue.line ?? null,
    column: issue.column ?? parseLegacyEslintColumn(issue),
  };
  const metric = normalized.metric ?? parseMetric(normalized);
  if (metric) {
    normalized.metric = metric;
  }
  normalized.stableKey = buildStableKey(normalized);
  return normalized;
}

export function normalizeIssues(issues) {
  return dedupeIssues(issues.map((issue) => normalizeIssue(issue)));
}

export function dedupeIssues(issues) {
  const byKey = new Map();
  for (const issue of issues) {
    byKey.set(comparisonKey(issue), issue);
  }
  return [...byKey.values()].sort((a, b) => comparisonKey(a).localeCompare(comparisonKey(b)));
}

export function compareIssues({ currentIssues, baselineIssues }) {
  const normalizedCurrentIssues = normalizeIssues(currentIssues);
  const normalizedBaselineIssues = normalizeIssues(baselineIssues);
  const currentByKey = new Map(
    normalizedCurrentIssues.map((issue) => [comparisonKey(issue), issue])
  );
  const baselineByKey = new Map(
    normalizedBaselineIssues.map((issue) => [comparisonKey(issue), issue])
  );

  const newIssues = normalizedCurrentIssues.filter(
    (issue) => !baselineByKey.has(comparisonKey(issue))
  );
  const resolvedIssues = normalizedBaselineIssues.filter(
    (issue) => !currentByKey.has(comparisonKey(issue))
  );
  const { worsenedIssues, improvedIssues } = compareSharedMetricIssues(currentByKey, baselineByKey);

  return {
    currentIssues: normalizedCurrentIssues,
    baselineIssues: normalizedBaselineIssues,
    newIssues,
    resolvedIssues,
    worsenedIssues,
    improvedIssues,
  };
}

export function canUpdateBaseline(comparison, hasExistingBaseline = true) {
  if (!hasExistingBaseline) {
    return { allowed: true, reason: "initial baseline" };
  }

  if (comparison.newIssues.length > 0 || comparison.worsenedIssues.length > 0) {
    return { allowed: false, reason: REFUSE_WORSENED_BASELINE_MESSAGE };
  }

  return { allowed: true, reason: "baseline does not move upward" };
}

export function buildBaselineDocument({ issues, thresholds }) {
  return {
    version: QUALITY_BASELINE_VERSION,
    policy: QUALITY_BASELINE_POLICY,
    thresholds,
    issues: normalizeIssues(issues),
  };
}

export function buildSummary(comparison) {
  const currentCounts = summarizeByTool(comparison.currentIssues);
  const baselineCounts = summarizeByTool(comparison.baselineIssues);
  const newCounts = summarizeByTool(comparison.newIssues);
  const resolvedCounts = summarizeByTool(comparison.resolvedIssues);
  const worsenedCounts = summarizeByToolComparisons(comparison.worsenedIssues);
  const improvedCounts = summarizeByToolComparisons(comparison.improvedIssues);
  const tools = sortedToolNames([
    currentCounts,
    baselineCounts,
    newCounts,
    resolvedCounts,
    worsenedCounts,
    improvedCounts,
  ]);

  const lines = [
    "## Quality Baseline",
    "",
    "| tool | current | baseline | new | resolved | worsened | improved |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const tool of tools) {
    lines.push(
      `| ${tool} | ${currentCounts.get(tool) ?? 0} | ${baselineCounts.get(tool) ?? 0} | ${newCounts.get(tool) ?? 0} | ${resolvedCounts.get(tool) ?? 0} | ${worsenedCounts.get(tool) ?? 0} | ${improvedCounts.get(tool) ?? 0} |`
    );
  }

  appendIssueSection(lines, "New violations", comparison.newIssues);
  appendIssueSection(lines, "Resolved baseline entries", comparison.resolvedIssues);
  appendComparisonSection(lines, "Worsened baseline entries", comparison.worsenedIssues);
  appendComparisonSection(lines, "Improved baseline entries", comparison.improvedIssues);

  lines.push("", "Baseline entries are repayment targets, not permanent allowances.");
  return `${lines.join("\n")}\n`;
}

export function comparisonHasChanges(comparison) {
  return (
    comparison.newIssues.length > 0 ||
    comparison.resolvedIssues.length > 0 ||
    comparison.worsenedIssues.length > 0 ||
    comparison.improvedIssues.length > 0
  );
}

function buildEslintStableKey(issue) {
  if (issue.category === "max-lines") {
    return issueId(["eslint", issue.category, issue.path, "file"]);
  }

  const functionName = parseFunctionName(issue.detail);
  if (functionName) {
    return issueId(["eslint", issue.category, issue.path, `function:${functionName}`]);
  }

  if (knownEslintMetricCategory(issue.category)) {
    return issueId(["eslint", issue.category, issue.path, lineColumnKey(issue)]);
  }

  return issue.id;
}

function parseMetric(issue) {
  if (issue.tool === "eslint") {
    return parseMetricFromEslintMessage(issue.detail, issue.category);
  }

  return undefined;
}

function lowerIsBetterMetric(name, value, limit) {
  return {
    name,
    value: Number(value),
    limit: Number(limit),
    direction: "lowerIsBetter",
  };
}

function knownEslintMetricCategory(category) {
  return ["complexity", "max-lines", "max-lines-per-function", "max-params"].includes(category);
}

function parseFunctionName(detail) {
  return detail.match(/^(?:Async )?(?:[Ff]unction|[Mm]ethod) '([^']+)' /)?.[1];
}

function parseLegacyEslintColumn(issue) {
  if (issue.tool !== "eslint") {
    return null;
  }

  const parts = issue.id.split("|");
  if (parts.length !== 5) {
    return null;
  }

  const column = Number(parts[4]);
  return Number.isFinite(column) ? column : null;
}

function lineColumnKey(issue) {
  const line = issue.line ?? "unknown";
  const column = issue.column ?? "unknown";
  return `line:${line}:column:${column}`;
}

function comparisonKey(issue) {
  return issue.stableKey ?? issue.id;
}

function compareSharedMetricIssues(currentByKey, baselineByKey) {
  const worsenedIssues = [];
  const improvedIssues = [];

  for (const [key, baseline] of baselineByKey) {
    const current = currentByKey.get(key);
    if (!current || !isComparableMetric(current.metric, baseline.metric)) {
      continue;
    }

    const delta = current.metric.value - baseline.metric.value;
    if (delta > 0) {
      worsenedIssues.push({ baseline, current, delta });
    } else if (delta < 0) {
      improvedIssues.push({ baseline, current, delta });
    }
  }

  return { worsenedIssues, improvedIssues };
}

function isComparableMetric(currentMetric, baselineMetric) {
  return (
    currentMetric &&
    baselineMetric &&
    currentMetric.name === baselineMetric.name &&
    currentMetric.direction === "lowerIsBetter" &&
    baselineMetric.direction === "lowerIsBetter"
  );
}

function summarizeByTool(issues) {
  const counts = new Map();
  for (const issue of issues) {
    counts.set(issue.tool, (counts.get(issue.tool) ?? 0) + 1);
  }
  return counts;
}

function summarizeByToolComparisons(comparisons) {
  const counts = new Map();
  for (const comparison of comparisons) {
    const tool = comparison.current.tool;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return counts;
}

function sortedToolNames(countMaps) {
  return [...new Set(countMaps.flatMap((counts) => [...counts.keys()]))].sort();
}

function appendIssueSection(lines, title, issues) {
  if (issues.length === 0) {
    return;
  }

  lines.push("", `### ${title}`);
  for (const issue of issues.slice(0, 50)) {
    lines.push(`- ${issueLabel(issue)}`);
  }
  appendOverflow(lines, issues.length);
}

function appendComparisonSection(lines, title, comparisons) {
  if (comparisons.length === 0) {
    return;
  }

  lines.push("", `### ${title}`);
  for (const comparison of comparisons.slice(0, 50)) {
    lines.push(`- ${comparisonLabel(comparison)}`);
  }
  appendOverflow(lines, comparisons.length);
}

function appendOverflow(lines, count) {
  if (count > 50) {
    lines.push(`- ...and ${count - 50} more`);
  }
}

function issueLabel(issue) {
  const location = issue.line ? `${issue.path}:${issue.line}` : issue.path;
  return `${issue.tool} ${issue.category} ${location} ${issue.detail}`;
}

function comparisonLabel({ baseline, current, delta }) {
  const metricName = current.metric.name;
  const sign = delta > 0 ? "+" : "";
  return `${current.tool} ${current.category} ${current.path} ${comparisonSubject(current)} baseline: ${baseline.metric.value} ${metricName}, current: ${current.metric.value} ${metricName}, delta: ${sign}${delta}`;
}

function comparisonSubject(issue) {
  const functionName = parseFunctionName(issue.detail);
  if (functionName) {
    return `function:${functionName}`;
  }
  if (issue.category === "max-lines") {
    return "file";
  }
  return issue.line ? `line:${issue.line}` : "";
}

// Knip 6 reports one entry per file with an array per issue type ({ file, exports: [...], types: [...] }).
export function knipIssuesFromReport(report, normalizePath = (path) => path) {
  return (report.issues ?? []).flatMap((entry) => {
    const path = entry.file ? normalizePath(entry.file) : "";
    return Object.entries(entry).flatMap(([type, items]) =>
      Array.isArray(items)
        ? items.map((item, index) => {
            const symbol = item.name ?? item.symbol ?? "";
            return {
              id: issueId(["knip", type, path, symbol || index]),
              tool: "knip",
              category: type,
              path,
              line: item.line ?? null,
              detail: symbol || JSON.stringify(item),
            };
          })
        : []
    );
  });
}
