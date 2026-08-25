function cleanLine(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function consumeComment(value, start) {
  if (value[start] !== "/" || value[start + 1] !== "*") return start;
  const end = value.indexOf("*/", start + 2);
  return end < 0 ? value.length : end + 2;
}

function consumeEscape(value, start) {
  let index = start + 1;
  if (index >= value.length) return { value: "", end: index };
  if (value[index] === "\r" && value[index + 1] === "\n") {
    return { value: "", end: index + 2 };
  }
  if (value[index] === "\r" || value[index] === "\n" || value[index] === "\f") {
    return { value: "", end: index + 1 };
  }
  if (/[0-9a-f]/i.test(value[index])) {
    const hexStart = index;
    while (index < value.length && index - hexStart < 6) {
      if (!/[0-9a-f]/i.test(value[index])) break;
      index += 1;
    }
    const codePoint = Number.parseInt(value.slice(hexStart, index), 16);
    if (/\s/.test(value[index] || "")) {
      if (value[index] === "\r" && value[index + 1] === "\n") index += 2;
      else index += 1;
    }
    const decoded =
      !codePoint ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "�"
        : String.fromCodePoint(codePoint);
    return { value: decoded, end: index };
  }
  return { value: value[index], end: index + 1 };
}

function consumeString(value, start) {
  const quote = value[start];
  let index = start + 1;
  let decoded = "";
  while (index < value.length) {
    const character = value[index];
    if (character === quote) {
      return { value: decoded, end: index + 1, closed: true };
    }
    if (character === "\\") {
      const escape = consumeEscape(value, index);
      decoded += escape.value;
      index = escape.end;
      continue;
    }
    if (character === "\r" || character === "\n" || character === "\f") {
      return { value: decoded, end: index, closed: false };
    }
    decoded += character;
    index += 1;
  }
  return { value: decoded, end: index, closed: false };
}

function skipTrivia(value, start) {
  let index = start;
  for (;;) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (value[index] !== "/" || value[index + 1] !== "*") return index;
    index = consumeComment(value, index);
  }
}

function consumeUrlFunction(value, start, functionName) {
  let index = skipTrivia(value, start + functionName.length + 1);
  if (value[index] === '"' || value[index] === "'") {
    const string = consumeString(value, index);
    if (!string.closed) return null;
    index = skipTrivia(value, string.end);
    if (value[index] !== ")") return null;
    return { value: string.value, end: index + 1 };
  }

  let decoded = "";
  while (index < value.length) {
    const character = value[index];
    if (character === ")") {
      return { value: decoded.trim(), end: index + 1 };
    }
    if (character === "/" && value[index + 1] === "*") {
      index = consumeComment(value, index);
      continue;
    }
    if (/\s/.test(character)) {
      index = skipTrivia(value, index);
      if (value[index] !== ")") return null;
      return { value: decoded.trim(), end: index + 1 };
    }
    if (character === '"' || character === "'" || character === "(") {
      return null;
    }
    if (character === "\\") {
      const escape = consumeEscape(value, index);
      decoded += escape.value;
      index = escape.end;
      continue;
    }
    decoded += character;
    index += 1;
  }
  return null;
}

function statementPrefix(value, index) {
  const boundedStart = Math.max(0, index - 1_000);
  const prefix = value.slice(boundedStart, index);
  const boundary = Math.max(
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("{"),
    prefix.lastIndexOf("}"),
  );
  return prefix
    .slice(boundary + 1)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

function cssResourceReferences(input, { allowImports = true } = {}) {
  const value = String(input || "");
  const references = [];
  const lineStarts = [0];
  for (
    let index = value.indexOf("\n");
    index >= 0;
    index = value.indexOf("\n", index + 1)
  ) {
    lineStarts.push(index + 1);
  }
  const lineAt = (position) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= position) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  const add = (raw, kind, position) => {
    const normalized = String(raw || "").trim();
    if (!normalized || normalized.startsWith("#")) return;
    const lineStart = value.lastIndexOf("\n", position - 1) + 1;
    const nextLine = value.indexOf("\n", position);
    const lineEnd = nextLine < 0 ? value.length : nextLine;
    const context = cleanLine(value.slice(lineStart, lineEnd));
    references.push({
      raw: normalized,
      kind,
      line: lineAt(position),
      context:
        context.length > 180 ? `${context.slice(0, 180)}…` : context,
    });
  };

  let index = 0;
  let blockDepth = 0;
  while (index < value.length) {
    if (value[index] === "/" && value[index + 1] === "*") {
      index = consumeComment(value, index);
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      index = consumeString(value, index).end;
      continue;
    }

    const importKeyword = value.slice(index, index + 7).toLowerCase();
    if (
      allowImports &&
      blockDepth === 0 &&
      importKeyword === "@import" &&
      !/[-_a-z0-9]/i.test(value[index + 7] || "")
    ) {
      const targetStart = skipTrivia(value, index + 7);
      if (value[targetStart] === '"' || value[targetStart] === "'") {
        const imported = consumeString(value, targetStart);
        if (imported.closed) add(imported.value, "@import", index);
        index = imported.end;
        continue;
      }
    }

    const functionPrefix = value.slice(index, index + 4).toLowerCase();
    const functionName =
      functionPrefix === "url("
        ? "url"
        : functionPrefix === "src("
          ? "src"
          : "";
    const previous = value[index - 1] || "";
    if (functionName && !/[-_a-z0-9]/i.test(previous)) {
      const parsed = consumeUrlFunction(value, index, functionName);
      if (parsed) {
        const statement = statementPrefix(value, index);
        const atRule = /^@([-_a-z0-9]+)/i.exec(statement)?.[1]?.toLowerCase();
        const customProperty = /^--[-_a-z0-9]+\s*:/i.test(statement);
        const validImport =
          atRule === "import" && allowImports && blockDepth === 0;
        if (!customProperty && (!atRule || validImport)) {
          add(
            parsed.value,
            validImport ? "@import" : `${functionName}()`,
            index,
          );
        }
        index = parsed.end;
        continue;
      }
    }
    if (value[index] === "{") blockDepth += 1;
    else if (value[index] === "}") blockDepth = Math.max(0, blockDepth - 1);
    index += 1;
  }

  return references;
}

module.exports = { cssResourceReferences };
