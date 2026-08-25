"use strict";

const ASCII_WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]);
const MAX_SAFE_DELAY = String(Number.MAX_SAFE_INTEGER);

function isAsciiDigit(character) {
  return character >= "0" && character <= "9";
}

function skipAsciiWhitespace(input, position) {
  let next = position;
  while (next < input.length && ASCII_WHITESPACE.has(input[next])) next += 1;
  return next;
}

function parsedDelay(timeString) {
  if (!timeString) return { delay: 0, overflow: false };
  const normalized = timeString.replace(/^0+/, "") || "0";
  const overflow =
    normalized.length > MAX_SAFE_DELAY.length ||
    (normalized.length === MAX_SAFE_DELAY.length &&
      normalized > MAX_SAFE_DELAY);
  return overflow
    ? { delay: Number.MAX_SAFE_INTEGER, overflow: true }
    : { delay: Number(normalized), overflow: false };
}

function quotedUrlFrom(input, position) {
  let next = position;
  let quote = "";
  if (input[next] === "'" || input[next] === '"') {
    quote = input[next];
    next += 1;
  }
  let urlString = input.slice(next);
  if (quote) {
    const closingQuote = urlString.indexOf(quote);
    if (closingQuote >= 0) urlString = urlString.slice(0, closingQuote);
  }
  return urlString;
}

function explicitUrlString(input, position) {
  const original = input.slice(position);
  if (!["u", "U"].includes(input[position])) {
    return quotedUrlFrom(input, position);
  }

  let next = position + 1;
  if (!["r", "R"].includes(input[next])) return original;
  next += 1;
  if (!["l", "L"].includes(input[next])) return original;
  next += 1;
  next = skipAsciiWhitespace(input, next);
  if (input[next] !== "=") return original;
  next += 1;
  next = skipAsciiWhitespace(input, next);
  return quotedUrlFrom(input, next);
}

function parseMetaRefresh(inputValue, documentUrl, baseUrl = documentUrl) {
  const raw = String(inputValue ?? "");
  let position = skipAsciiWhitespace(raw, 0);
  const delayStart = position;
  while (position < raw.length && isAsciiDigit(raw[position])) position += 1;
  const timeString = raw.slice(delayStart, position);
  if (!timeString && raw[position] !== ".") return null;

  const { delay, overflow } = parsedDelay(timeString);
  while (
    position < raw.length &&
    (isAsciiDigit(raw[position]) || raw[position] === ".")
  ) {
    position += 1;
  }
  const delayRaw = raw.slice(delayStart, position);

  if (position < raw.length) {
    const separator = raw[position];
    if (
      separator !== ";" &&
      separator !== "," &&
      !ASCII_WHITESPACE.has(separator)
    ) {
      return null;
    }
    position = skipAsciiWhitespace(raw, position);
    if (raw[position] === ";" || raw[position] === ",") position += 1;
    position = skipAsciiWhitespace(raw, position);
  }

  if (position >= raw.length) {
    return {
      raw,
      delay,
      delayRaw,
      delayOverflow: overflow,
      explicitUrl: false,
      targetRaw: "",
      url: new URL(documentUrl).href,
      isReload: true,
    };
  }

  const targetRaw = explicitUrlString(raw, position);
  let target;
  try {
    target = new URL(targetRaw, baseUrl);
  } catch {
    return null;
  }
  if (target.protocol.toLowerCase() === "javascript:") return null;

  return {
    raw,
    delay,
    delayRaw,
    delayOverflow: overflow,
    explicitUrl: true,
    targetRaw,
    url: target.href,
    isReload: false,
  };
}

module.exports = {
  parseMetaRefresh,
};
