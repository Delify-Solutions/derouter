// An incremental check of JSON text as it arrives: is what has been read so far a
// complete JSON value, the start (a prefix) of one, or something that can never
// become one? Used by the SSE mask (publicModel.js) to decide, line by line,
// whether data spread over several `data:` lines must be held for the rest of its
// value or released now.
//
// A pushdown automaton over the JSON grammar (RFC 8259): a stack of open
// containers and what may come next (a value, a key, a colon, a comma or a
// closer). Strings are followed character by character (escapes, \u sequences,
// no raw control characters: a line break inside a string makes the text
// invalid, which is how a value whose line ends inside a string is detected).
// Numbers are only checked for their character set and the final JSON.parse is
// the authority on them; a prefix that is valid here and a number JSON.parse
// rejects is released through the per-line fallback like any broken value.
// O(1) work per character, memory O(nesting depth). Relative-import safe.

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_CHARS = new Set([..."0123456789+-.eE"].map((c) => c.charCodeAt(0)));
const ESCAPES = new Set([..."\"\\/bfnrtu"].map((c) => c.charCodeAt(0)));
const HEX = /[0-9a-fA-F]/;

/** Result of `feed`: more text may complete it, it is complete, or it never can be. */
export const PREFIX = Object.freeze({ INCOMPLETE: "incomplete", COMPLETE: "complete", INVALID: "invalid" });

/**
 * @returns {{ feed(text: string): string, readonly status: string }}
 */
export function createJsonPrefixParser() {
  const stack = []; // "{" or "["
  // value | firstValueOrEnd | firstKeyOrEnd | key | colon | commaOrEnd | done |
  // string | literal | number | invalid
  let mode = "value";
  let stringRole = "value"; // the string being read is a "key" or a "value"
  let escape = false;
  let unicodeLeft = 0;
  let literalRest = "";

  const afterValue = () => { mode = stack.length ? "commaOrEnd" : "done"; };

  const startValue = (ch) => {
    if (ch === 0x7b) { stack.push("{"); mode = "firstKeyOrEnd"; return; } // {
    if (ch === 0x5b) { stack.push("["); mode = "firstValueOrEnd"; return; } // [
    if (ch === 0x22) { mode = "string"; stringRole = "value"; return; } // "
    if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) { mode = "number"; return; } // - 0-9
    if (ch === 0x74) { mode = "literal"; literalRest = "rue"; return; } // t
    if (ch === 0x66) { mode = "literal"; literalRest = "alse"; return; } // f
    if (ch === 0x6e) { mode = "literal"; literalRest = "ull"; return; } // n
    mode = "invalid";
  };

  const close = (ch) => {
    const want = ch === 0x7d ? "{" : "[";
    if (stack[stack.length - 1] !== want) { mode = "invalid"; return; }
    stack.pop();
    afterValue();
  };

  const step = (ch, c) => {
    switch (mode) {
      case "string":
        if (unicodeLeft > 0) {
          if (!HEX.test(c)) mode = "invalid";
          else unicodeLeft -= 1;
        } else if (escape) {
          if (!ESCAPES.has(ch)) mode = "invalid";
          else if (ch === 0x75) unicodeLeft = 4; // u
          escape = false;
        } else if (ch === 0x5c) {
          escape = true;
        } else if (ch === 0x22) {
          if (stringRole === "key") mode = "colon";
          else afterValue();
        } else if (ch < 0x20) {
          mode = "invalid"; // raw control character (a line break) inside a string
        }
        return;
      case "literal":
        if (c !== literalRest[0]) { mode = "invalid"; return; }
        literalRest = literalRest.slice(1);
        if (!literalRest) afterValue();
        return;
      case "number":
        if (NUMBER_CHARS.has(ch)) return;
        afterValue();
        step(ch, c); // the character after a number belongs to what follows it
        return;
      default:
        break;
    }
    if (WS.has(ch)) return;
    switch (mode) {
      case "value":
        startValue(ch);
        return;
      case "firstValueOrEnd":
        if (ch === 0x5d) close(ch);
        else startValue(ch);
        return;
      case "firstKeyOrEnd":
        if (ch === 0x7d) close(ch);
        else if (ch === 0x22) { mode = "string"; stringRole = "key"; }
        else mode = "invalid";
        return;
      case "key":
        if (ch === 0x22) { mode = "string"; stringRole = "key"; }
        else mode = "invalid";
        return;
      case "colon":
        mode = ch === 0x3a ? "value" : "invalid";
        return;
      case "commaOrEnd":
        if (ch === 0x2c) mode = stack[stack.length - 1] === "{" ? "key" : "value";
        else if (ch === 0x7d || ch === 0x5d) close(ch);
        else mode = "invalid";
        return;
      case "done":
      default:
        mode = "invalid";
    }
  };

  const status = () => {
    if (mode === "invalid") return PREFIX.INVALID;
    if (mode === "done" || (mode === "number" && stack.length === 0)) return PREFIX.COMPLETE;
    return PREFIX.INCOMPLETE;
  };

  return {
    feed(text) {
      for (let i = 0; i < text.length && mode !== "invalid"; i += 1) step(text.charCodeAt(i), text[i]);
      return status();
    },
    get status() { return status(); },
  };
}
