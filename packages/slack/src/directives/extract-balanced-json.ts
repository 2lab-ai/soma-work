/**
 * Extract the first balanced JSON object from `text`, scanning forward from
 * `startIndex`. Returns the raw JSON substring (braces included) or `null` if
 * no balanced object is found.
 *
 * String literals and escape sequences are respected so braces inside strings
 * do not affect nesting depth. Shared by the directive handlers and the
 * user-choice extractor, which all locate a directive marker and then need to
 * slice out the JSON payload that follows it.
 */
export function extractBalancedJson(text: string, startIndex: number): string | null {
  let braceCount = 0;
  let inString = false;
  let escape = false;
  let jsonStart = -1;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (braceCount === 0) jsonStart = i;
      braceCount++;
    } else if (char === '}') {
      braceCount--;
      if (braceCount === 0 && jsonStart !== -1) {
        return text.substring(jsonStart, i + 1);
      }
    }
  }

  return null;
}
