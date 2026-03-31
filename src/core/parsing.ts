/**
 * Extracts a balanced substring from input starting at startIndex.
 * Handles nested delimiters and respects string literals (single, double, backticks).
 * Escaped characters within strings are skipped.
 *
 * @param input - The input string to scan
 * @param startIndex - Index where the opening character is located
 * @param open - The opening delimiter (e.g., '(', '[', '{')
 * @param close - The corresponding closing delimiter
 * @returns The balanced substring including delimiters, or null if not found
 */
export function extractBalanced(
  input: string,
  startIndex: number,
  open: string,
  close: string,
): string | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      continue;
    }

    if (quote) {
      continue;
    }

    if (character === open) {
      depth += 1;
    }

    if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

/**
 * Splits a string by a separator at the top level only (ignores separators inside nested
 * parentheses, brackets, braces, and string literals).
 *
 * @param input - The input string to split
 * @param separator - The delimiter to split on
 * @returns Array of trimmed non-empty segments
 */
export function splitTopLevel(input: string, separator: string): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      current += character;
      continue;
    }

    if (!quote) {
      if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
      } else if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      } else if (
        character === separator &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        if (current.trim()) {
          results.push(current.trim());
        }
        current = "";
        continue;
      }
    }

    current += character;
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results;
}

/**
 * Splits a string by a multi-character sequence at top level only.
 *
 * @param input - Source string
 * @param sequence - Delimiter sequence (e.g. "??", "||")
 * @returns Array of split segments, or [trimmed input] when no split occurs
 */
export function splitTopLevelSequence(
  input: string,
  sequence: string,
): string[] {
  const results: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      current += character;
      continue;
    }

    if (!quote) {
      if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
      } else if (character === "[") {
        bracketDepth += 1;
      } else if (character === "]") {
        bracketDepth -= 1;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      } else if (
        input.startsWith(sequence, index) &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        if (current.trim()) {
          results.push(current.trim());
        }
        current = "";
        index += sequence.length - 1;
        continue;
      }
    }

    current += character;
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results.length > 0 ? results : [input.trim()];
}

/**
 * Finds the first top-level terminator character after startIndex.
 * Ignores candidates inside nested parentheses/brackets/braces and string literals.
 *
 * @param input - Source string to scan
 * @param startIndex - Position to begin scanning from
 * @param terminators - Candidate terminator characters (e.g. [";"], ["\n", ";"])
 * @returns Index of the first matching top-level terminator, or -1 when absent
 */
export function findTopLevelTerminator(
  input: string,
  startIndex: number,
  terminators: string[],
): number {
  const terminatorSet = new Set(terminators);
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      continue;
    }

    if (quote) {
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth -= 1;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}") {
      braceDepth -= 1;
      continue;
    }

    if (
      terminatorSet.has(character) &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

/**
 * Escapes regular-expression metacharacters in a string.
 *
 * @param value - Raw string that may contain regex control characters
 * @returns A regex-safe escaped string
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits a string at the first occurrence of `separator`.
 *
 * @param input - Source string
 * @param separator - Delimiter to split on once
 * @returns Tuple of [left, right], where right is undefined when separator is absent
 */
export function splitOnce(
  input: string,
  separator: string,
): [string, string | undefined] {
  const index = input.indexOf(separator);
  if (index < 0) {
    return [input, undefined];
  }

  return [input.slice(0, index), input.slice(index + separator.length)];
}
