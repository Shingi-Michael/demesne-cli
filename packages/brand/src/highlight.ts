import type { Painter } from "./index.ts";

/// A small, dependency-free syntax highlighter for fenced code blocks.
///
/// It is intentionally line-oriented and lossless: every character of the
/// input appears in the output, only wrapped in ANSI styles, so widths and
/// copy/paste behavior are unchanged. Unknown languages fall back to a common
/// C-like keyword set. When the painter is disabled the input is returned
/// byte-for-byte unchanged, which keeps `NO_COLOR` output clean.

export interface CodeHighlightState {
  inBlockComment: boolean;
}

interface LanguageSpec {
  keywords: Set<string>;
  lineComment: string | null;
  blockComments: boolean;
  hashComment?: boolean;
  variables?: boolean;
  decorators?: boolean;
  typesByCase?: boolean;
  preprocessor?: boolean;
}

const TYPESCRIPT_KEYWORDS = [
  "abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean", "break", "case",
  "catch", "class", "const", "continue", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "infer", "instanceof", "interface", "is", "keyof", "let", "namespace", "never",
  "new", "null", "number", "object", "of", "package", "private", "protected", "public", "readonly",
  "return", "satisfies", "set", "static", "string", "super", "switch", "symbol", "this", "throw",
  "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "yield",
];

const GO_KEYWORDS = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var", "nil", "true", "false", "make", "new", "len", "cap", "append",
];

const RUST_KEYWORDS = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
  "use", "where", "while", "Some", "None", "Ok", "Err",
];

const PYTHON_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "match", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try",
  "while", "with", "yield", "case",
];

const BASH_KEYWORDS = [
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "function", "in", "return", "exit", "local", "export", "source", "set", "unset", "trap", "readonly",
];

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  diff: "diff",
  patch: "diff",
};

const SPECS: Record<string, LanguageSpec> = {
  typescript: { keywords: new Set(TYPESCRIPT_KEYWORDS), lineComment: "//", blockComments: true, typesByCase: true },
  javascript: { keywords: new Set(TYPESCRIPT_KEYWORDS), lineComment: "//", blockComments: true, typesByCase: true },
  go: { keywords: new Set(GO_KEYWORDS), lineComment: "//", blockComments: true, typesByCase: true },
  rust: { keywords: new Set(RUST_KEYWORDS), lineComment: "//", blockComments: true, typesByCase: true },
  python: { keywords: new Set(PYTHON_KEYWORDS), lineComment: "#", blockComments: false, hashComment: true, decorators: true, typesByCase: true },
  bash: { keywords: new Set(BASH_KEYWORDS), lineComment: "#", blockComments: false, hashComment: true, variables: true },
};

export function normalizeLanguage(info: string): string {
  const token = info.trim().toLowerCase().split(/[\s,:{}]/, 1)[0] ?? "";
  return LANGUAGE_ALIASES[token] ?? token;
}

export function highlightCode(
  code: string,
  language: string,
  painter: Painter,
  state?: CodeHighlightState,
): string {
  if (!painter.enabled) return code;
  const normalized = normalizeLanguage(language);
  if (normalized === "diff") return highlightDiff(code, painter);
  if (normalized === "json") return highlightJson(code, painter);
  if (normalized === "yaml") return highlightYaml(code, painter);
  const spec = SPECS[normalized] ?? SPECS.typescript!;
  return highlightTokens(code, painter, spec, state);
}

function highlightTokens(code: string, painter: Painter, spec: LanguageSpec, state?: CodeHighlightState): string {
  let result = "";
  let index = 0;
  while (index < code.length) {
    const rest = code.slice(index);

    if (state?.inBlockComment) {
      const end = rest.indexOf("*/");
      if (end === -1) return result + painter.dim(rest);
      result += painter.dim(rest.slice(0, end + 2));
      index += end + 2;
      state.inBlockComment = false;
      continue;
    }

    if (spec.blockComments && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) {
        if (state) state.inBlockComment = true;
        return result + painter.dim(rest);
      }
      result += painter.dim(rest.slice(0, end + 2));
      index += end + 2;
      continue;
    }

    if (spec.lineComment && rest.startsWith(spec.lineComment)) {
      return result + painter.dim(rest);
    }

    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = stringEnd(rest, quote);
      result += painter.text(rest.slice(0, end), "citron");
      index += end;
      continue;
    }

    if (spec.variables && rest[0] === "$") {
      const variable = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(rest);
      if (variable) {
        result += painter.text(variable[0], "electricBright");
        index += variable[0].length;
        continue;
      }
    }

    if (spec.decorators && rest[0] === "@") {
      const decorator = /^@[A-Za-z_][\w.]*/.exec(rest);
      if (decorator) {
        result += painter.text(decorator[0], "electric");
        index += decorator[0].length;
        continue;
      }
    }

    if (spec.preprocessor && rest[0] === "#") {
      result += painter.bold("#", "electric");
      index += 1;
      continue;
    }

    const number = /^\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number && !/[\w$]/.test(rest[number[0].length] ?? "")) {
      result += painter.text(number[0], "electricBright");
      index += number[0].length;
      continue;
    }

    const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (identifier) {
      const word = identifier[0];
      const after = rest.slice(word.length);
      if (spec.keywords.has(word)) {
        result += painter.bold(word, "electric");
      } else if (spec.typesByCase && /^[A-Z]/.test(word) && word.length > 1) {
        result += painter.text(word, "secondary");
      } else if (/^\s*\(/.test(after)) {
        result += painter.text(word, "paper");
      } else {
        result += word;
      }
      index += word.length;
      continue;
    }

    result += rest[0];
    index += 1;
  }
  return result;
}

function highlightJson(code: string, painter: Painter): string {
  const key = /^(\s*)"((?:\\.|[^"\\])*)"(\s*:)/.exec(code);
  if (key) {
    return `${key[1]}${painter.text(`"${key[2]}"`, "electric")}${key[3]}`
      + highlightJson(code.slice(key[0].length), painter);
  }
  let result = "";
  let index = 0;
  while (index < code.length) {
    const rest = code.slice(index);
    const quote = rest[0];
    if (quote === '"') {
      const end = stringEnd(rest, quote);
      result += painter.text(rest.slice(0, end), "citron");
      index += end;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      result += painter.text(number[0], "electricBright");
      index += number[0].length;
      continue;
    }
    const literal = /^(true|false|null)\b/.exec(rest);
    if (literal) {
      result += painter.bold(literal[0], "electric");
      index += literal[0].length;
      continue;
    }
    result += rest[0];
    index += 1;
  }
  return result;
}

function highlightYaml(code: string, painter: Painter): string {
  const comment = code.indexOf("#");
  const body = comment === -1 ? code : code.slice(0, comment);
  const trailing = comment === -1 ? "" : painter.dim(code.slice(comment));
  const key = /^(\s*(?:- )?)([\w.$-]+)(\s*:)(.*)$/.exec(body);
  if (key) {
    const value = key[4]!;
    const renderedValue = /^\s*["']/.test(value)
      ? painter.text(value, "citron")
      : value.replace(/\b(true|false|null|yes|no)\b/gi, (match) => painter.bold(match, "electric"))
        .replace(/\b\d+(?:\.\d+)?\b/g, (match) => painter.text(match, "electricBright"));
    return `${key[1]}${painter.text(key[2]!, "electric")}${key[3]}${renderedValue}${trailing}`;
  }
  return body + trailing;
}

function highlightDiff(code: string, painter: Painter): string {
  if (/^(?:\+\+\+|---|diff |index |@@)/.test(code)) {
    return /^@@/.test(code) ? painter.text(code, "electric") : painter.dim(code);
  }
  if (code.startsWith("+")) return painter.text(code, "citron");
  if (code.startsWith("-")) return painter.text(code, "signal");
  return code;
}

function stringEnd(value: string, quote: string): number {
  let index = 1;
  while (index < value.length) {
    if (value[index] === "\\") {
      index += 2;
      continue;
    }
    if (value[index] === quote) return index + 1;
    index += 1;
  }
  return value.length;
}
