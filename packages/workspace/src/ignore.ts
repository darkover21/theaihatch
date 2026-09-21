import { promises as fs } from "node:fs";
import path from "node:path";

interface IgnoreRule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly hasSlash: boolean;
  readonly expression: RegExp;
}

function globExpression(pattern: string): RegExp {
  let prefix = "";
  let suffix = "";
  if (pattern.startsWith("**/")) { prefix = "(?:[^/]+/)*"; pattern = pattern.slice(3); }
  if (pattern.endsWith("/**")) { suffix = "(?:/.*)?"; pattern = pattern.slice(0, -3); }
  pattern = pattern.replace(/\/\*\*\//gu, "(?:/[^/]+)*/");
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        expression += "[^/]*";
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[\\^$+.()|{}[\]]/u.test(character ?? "") ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${prefix}${expression}${suffix}$`, "u");
}

function parseRule(line: string): IgnoreRule | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const negated = trimmed.startsWith("!") && !trimmed.startsWith("\\!");
  const withoutNegation = negated ? trimmed.slice(1) : trimmed;
  const directoryOnly = withoutNegation.endsWith("/");
  const withoutTrailingSlash = directoryOnly ? withoutNegation.slice(0, -1) : withoutNegation;
  const anchored = withoutTrailingSlash.startsWith("/");
  const pattern = withoutTrailingSlash.replace(/^\//u, "");
  if (pattern === "") return null;
  const expression = globExpression(pattern);
  return { negated, directoryOnly, anchored, hasSlash: pattern.includes("/"), expression };
}

export class IgnoreMatcher {
  private readonly cache = new Map<string, boolean>();
  private constructor(private readonly rules: readonly IgnoreRule[]) {}

  static async fromWorkspace(rootPath: string): Promise<IgnoreMatcher> {
    const files = [path.join(rootPath, ".gitignore"), path.join(rootPath, ".git", "info", "exclude")];
    const contents = (await Promise.all(files.map(async (file) => fs.readFile(file, "utf8").catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      if (code !== "ENOENT") throw error;
      return "";
    })))).join("\n");
    return new IgnoreMatcher(contents.split(/\r?\n/u).flatMap((line) => {
      const rule = parseRule(line);
      return rule === null ? [] : [rule];
    }));
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (normalized === "." || normalized === "") return false;
    const key = `${normalized}\0${isDirectory ? "d" : "f"}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const parts = normalized.split("/");
    if (parts.some((part) => part === ".git" || part === "node_modules")) return this.remember(key, true);

    let ignored = false;
    const ancestors: string[] = [];
    for (let index = 1; index < parts.length; index += 1) ancestors.push(parts.slice(0, index).join("/"));
    for (const rule of this.rules) {
      const matches = rule.directoryOnly
        ? ancestors.some((candidate) => this.ruleMatches(rule, candidate)) || (isDirectory && this.ruleMatches(rule, normalized))
        : this.ruleMatches(rule, normalized);
      if (matches) ignored = !rule.negated;
    }
    return this.remember(key, ignored);
  }

  private remember(key: string, value: boolean): boolean {
    if (this.cache.size >= 4096) this.cache.clear();
    this.cache.set(key, value);
    return value;
  }

  private ruleMatches(rule: IgnoreRule, normalized: string): boolean {
    if (rule.anchored || rule.hasSlash) {
      return rule.expression.test(normalized);
    }
    return normalized.split("/").some((part) => rule.expression.test(part));
  }
}
