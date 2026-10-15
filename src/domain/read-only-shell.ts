type ShellToken = { kind: "word" | "separator" | "redirect"; value: string };

// This is deliberately a small shell grammar. Unsupported syntax stays subject to
// the mutation gate; a harmless prefix must never exempt the rest of a command.
export function isReadOnlyShellCommand(command: string): boolean {
  const tokens = tokenize(command.trim());
  if (!tokens?.length) return false;
  let words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "word") {
      words.push(token.value);
    } else if (token.kind === "redirect") {
      if (token.value === "2>&1") continue;
      const target = tokens[++index];
      if (!target || target.kind !== "word" || target.value !== "/dev/null") return false;
    } else {
      if (!isReadOnlySegment(words)) return false;
      words = [];
      if (index === tokens.length - 1) return token.value === ";" || token.value === "\n";
    }
  }
  return isReadOnlySegment(words);
}

function tokenize(command: string): ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let word = "";
  let wordStarted = false;
  let unquotedGlob = false;
  let unsafeExpansion = false;
  const flush = () => {
    // A bare glob can expand to option-looking filenames (find's -delete,
    // git's --output, rg's --pre). An attached long-option value keeps its
    // option name after expansion and is still checked by the command validator.
    if (unquotedGlob && !/^--[a-zA-Z][a-zA-Z-]*=/.test(word)) unsafeExpansion = true;
    if (wordStarted) tokens.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
    unquotedGlob = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "'" || char === '"') {
      wordStarted = true;
      const quote = char;
      let closed = false;
      while (++index < command.length) {
        const quoted = command[index]!;
        if (quoted === quote) { closed = true; break; }
        if (quote === '"' && (quoted === "$" || quoted === "`" || quoted === "\\")) return undefined;
        word += quoted;
      }
      if (!closed) return undefined;
    } else if (char === "\\") {
      const escaped = command[++index];
      if (!escaped || escaped === "\n" || escaped === "\r") return undefined;
      wordStarted = true;
      word += escaped;
    } else if (char === ">") {
      const descriptor = wordStarted && /^\d+$/.test(word) ? word : "";
      if (descriptor) { word = ""; wordStarted = false; }
      flush();
      if (command[index + 1] === ">") return undefined;
      if (command[index + 1] === "&") {
        if (descriptor !== "2" || command[index + 2] !== "1" || /[\w-]/.test(command[index + 3] ?? "")) return undefined;
        tokens.push({ kind: "redirect", value: "2>&1" });
        index += 2;
      } else {
        if (descriptor && descriptor !== "1" && descriptor !== "2") return undefined;
        tokens.push({ kind: "redirect", value: ">" });
      }
    } else if (char === ";" || char === "|" || char === "&" || char === "\n") {
      flush();
      let separator = char;
      if ((char === "|" || char === "&") && command[index + 1] === char) {
        separator += char;
        index += 1;
      } else if (char === "&") return undefined;
      tokens.push({ kind: "separator", value: separator });
    } else if (/\s/.test(char)) {
      flush();
    } else if (/[`$()<{}#]/.test(char)) {
      return undefined;
    } else {
      wordStarted = true;
      if (char === "*" || char === "?" || char === "[") unquotedGlob = true;
      word += char;
    }
  }
  flush();
  return unsafeExpansion ? undefined : tokens;
}

interface SafeOptions {
  short?: string;
  shortValues?: string;
  long?: string[];
  longValues?: string[];
  numeric?: boolean;
}

function safeOptions(args: string[], options: SafeOptions): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return true;
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (options.numeric && /^-\d+$/.test(arg)) continue;
    if (arg.startsWith("--")) {
      const [name, ...value] = arg.slice(2).split("=");
      if (options.longValues?.includes(name!)) {
        if (!value.length && args[++index] === undefined) return false;
      } else if (!options.long?.includes(name!) || value.length) return false;
      continue;
    }
    for (let letterIndex = 1; letterIndex < arg.length; letterIndex += 1) {
      const letter = arg[letterIndex]!;
      if (options.shortValues?.includes(letter)) {
        if (letterIndex === arg.length - 1 && args[++index] === undefined) return false;
        break;
      }
      if (!options.short?.includes(letter)) return false;
    }
  }
  return true;
}

function isReadOnlySegment(words: string[]): boolean {
  const [command, ...args] = words;
  switch (command) {
    case "echo": return true;
    case "cd": return (args.length === 1 && !args[0]!.startsWith("-"))
      || (args.length === 2 && args[0] === "--");
    case "pwd": return safeOptions(args, { short: "LP" });
    case "ls": return safeOptions(args, {
      short: "aAbBcCdDfFgGhHiIklLmNnOpqQrRsStTuUvwxX1Z", shortValues: "Iw",
      long: ["all", "almost-all", "directory", "recursive", "human-readable", "numeric-uid-gid", "full-time", "inode", "size", "reverse", "classify"],
      longValues: ["color", "sort", "time", "time-style", "format", "ignore", "hide", "quoting-style", "block-size", "width"],
    });
    case "grep": return safeOptions(args, {
      short: "EFGPivwxyonHhslLcqrbRIazZ", shortValues: "efmABC",
      long: ["extended-regexp", "fixed-strings", "perl-regexp", "ignore-case", "invert-match", "word-regexp", "line-regexp", "line-number", "recursive", "dereference-recursive", "files-with-matches", "files-without-match", "count", "quiet", "no-messages", "only-matching", "with-filename", "no-filename", "text", "binary-files"],
      longValues: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "color", "binary-files"],
    });
    case "rg": return safeOptions(args, {
      short: "nNirlLwWvFUPsScqHhIaz0", shortValues: "efgdtTmABC",
      long: ["hidden", "files", "no-ignore", "no-ignore-vcs", "ignore-case", "case-sensitive", "smart-case", "fixed-strings", "line-number", "no-line-number", "count", "count-matches", "files-with-matches", "files-without-match", "only-matching", "multiline", "multiline-dotall", "pcre2", "text", "json", "no-heading", "heading", "follow", "quiet", "no-messages", "no-config", "stats"],
      longValues: ["regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "max-depth", "max-filesize", "after-context", "before-context", "context", "color", "sort", "sortr", "encoding", "threads"],
    });
    case "cat": return safeOptions(args, { short: "AbEenstTv", long: ["number", "number-nonblank", "show-all", "show-ends", "show-tabs", "show-nonprinting", "squeeze-blank"] });
    case "head":
    case "tail": return safeOptions(args, { short: "qvz", shortValues: "nc", numeric: true, long: ["quiet", "silent", "verbose", "zero-terminated"], longValues: ["lines", "bytes"] });
    case "wc": return safeOptions(args, { short: "clmwL", long: ["bytes", "chars", "lines", "words", "max-line-length"] });
    case "stat": return safeOptions(args, { short: "fLt", shortValues: "c", long: ["dereference", "file-system", "terse"], longValues: ["format", "printf"] });
    case "which": return safeOptions(args, { short: "as", long: ["all"] });
    case "type": return safeOptions(args, { short: "afptP" });
    case "find": return safeFind(args);
    case "git": return safeGit(args);
    case "node": return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
    default: return false;
  }
}

function safeFind(args: string[]): boolean {
  const flags = new Set(["-H", "-L", "-P", "-not", "!", "-a", "-and", "-o", "-or", "-print", "-print0", "-empty", "-readable", "-writable", "-executable", "-true", "-false", "-prune", "-depth", "-xdev", "-mount"]);
  const valueFlags = new Set(["-maxdepth", "-mindepth", "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-user", "-group", "-perm", "-regex", "-iregex", "-regextype"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      if (args[++index] === undefined) return false;
    } else if (arg.startsWith("-") && !flags.has(arg)) return false;
  }
  return true;
}

function safeGit(args: string[]): boolean {
  const [subcommand, ...options] = args;
  if (!subcommand || !["status", "diff", "log", "show"].includes(subcommand)) return false;
  const flags = options.slice(0, options.indexOf("--") < 0 ? options.length : options.indexOf("--"));
  const patchRequested = flags.some((arg) => arg === "--patch" || arg.startsWith("--unified") || /^-[^-]*[pUW]/.test(arg));
  const summaryOnly = flags.some((arg) => ["--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--summary", "--raw", "--no-patch"].includes(arg)) && !patchRequested;
  const mayInvokeDiffHelpers = subcommand === "show" || (subcommand === "diff" && !summaryOnly)
    || (subcommand === "log" && patchRequested);
  if (mayInvokeDiffHelpers && (!flags.includes("--no-ext-diff") || !flags.includes("--no-textconv"))) return false;
  return safeOptions(options, {
    short: "sbpzMCRwW", shortValues: "Un", numeric: true,
    long: ["short", "branch", "porcelain", "stat", "numstat", "shortstat", "name-only", "name-status", "summary", "check", "cached", "staged", "raw", "patch", "no-patch", "oneline", "graph", "all", "reverse", "no-ext-diff", "no-textconv", "no-renames", "relative", "color", "no-color", "ignore-all-space", "ignore-space-change", "ignore-space-at-eol", "exit-code", "quiet"],
    longValues: ["format", "pretty", "max-count", "since", "until", "author", "grep", "unified", "diff-filter"],
  });
}
