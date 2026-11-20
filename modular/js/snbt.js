// Lenient SNBT parser for FTB Quests files.
// Accepts both comma-separated (our exporter) and newline-separated (FTB Quests) entries,
// quoted/unquoted keys, numeric suffixes (1b, 2L, 1.5d, ...) and typed arrays ([I; 1, 2]).
// Numbers become JS numbers (the suffix is dropped), so this is for reading, not round-tripping.

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[bBsSlLfFdD]?$/;
const KEY_RE = /[A-Za-z0-9_.+\-]/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

export function parseSNBT(text) {
  let i = 0;

  const fail = msg => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`SNBT parse error (line ${line}): ${msg}`);
  };

  // Commas are optional separators, so treat them as whitespace.
  function skipSpace() {
    while (i < text.length) {
      const c = text[i];
      if (c === ',' || /\s/.test(c)) i++;
      else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else break;
    }
  }

  function parseString() {
    const quote = text[i++];
    let out = '';
    while (i < text.length && text[i] !== quote) {
      let c = text[i++];
      if (c === '\\') {
        c = text[i++];
        if (c === 'u') { out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
        else out += ESCAPES[c] ?? c;
      } else out += c;
    }
    if (i >= text.length) fail('unterminated string');
    i++; // closing quote
    return out;
  }

  function parseKey() {
    if (text[i] === '"' || text[i] === "'") return parseString();
    const start = i;
    while (i < text.length && KEY_RE.test(text[i])) i++;
    if (i === start) fail(`expected a key but found '${text[i] ?? 'end of file'}'`);
    return text.slice(start, i);
  }

  function parseCompound() {
    i++; // {
    const obj = {};
    for (;;) {
      skipSpace();
      if (i >= text.length) fail("missing '}'");
      if (text[i] === '}') { i++; return obj; }
      const key = parseKey();
      skipSpace();
      if (text[i] !== ':') fail(`expected ':' after key '${key}'`);
      i++;
      obj[key] = parseValue();
    }
  }

  function parseList() {
    i++; // [
    skipSpace();
    if (/[BIL]/.test(text[i]) && text[i + 1] === ';') i += 2; // typed array prefix
    const arr = [];
    for (;;) {
      skipSpace();
      if (i >= text.length) fail("missing ']'");
      if (text[i] === ']') { i++; return arr; }
      arr.push(parseValue());
    }
  }

  function parseBare() {
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    const tok = text.slice(start, i);
    if (!tok) fail(`unexpected '${text[i] ?? 'end of file'}'`);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (NUMBER_RE.test(tok)) return parseFloat(tok);
    return tok;
  }

  function parseValue() {
    skipSpace();
    const c = text[i];
    if (c === '{') return parseCompound();
    if (c === '[') return parseList();
    if (c === '"' || c === "'") return parseString();
    return parseBare();
  }

  const value = parseValue();
  skipSpace();
  if (i < text.length) fail(`unexpected trailing content '${text[i]}'`);
  return value;
}
