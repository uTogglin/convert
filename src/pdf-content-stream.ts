// ── PDF Content Stream Parser & Text Removal ─────────────────────────────────
// Tokenizes and parses raw PDF content streams, resolves text positions,
// and removes/zeroes out text operators matched by coordinate.

/* ── Token types ── */

interface NumberToken { type: "number"; value: number; raw: string }
interface NameToken { type: "name"; value: string; raw: string }
interface LiteralStringToken { type: "string"; value: string; raw: string }
interface HexStringToken { type: "hexstring"; value: string; raw: string }
interface ArrayOpenToken { type: "arrayOpen"; raw: string }
interface ArrayCloseToken { type: "arrayClose"; raw: string }
interface OperatorToken { type: "operator"; value: string; raw: string }

type Token =
  | NumberToken | NameToken | LiteralStringToken | HexStringToken
  | ArrayOpenToken | ArrayCloseToken | OperatorToken;

/* ── Instruction = operands + operator ── */

export interface Instruction {
  operands: Token[];
  operator: string;
  /** Byte offset range in the original stream text [start, end) */
  startOffset: number;
  endOffset: number;
}

/* ── Edit descriptor ── */

export interface TextEditPosition {
  pdfX: number;
  pdfY: number;
  /** Tolerance in PDF user-space units for coordinate matching */
  tolerance?: number;
  /** If true, zero out the matched text. If replacement provided, it's handled externally. */
  delete: boolean;
}

/* ── Tokenizer ── */

export function tokenize(stream: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = stream.length;

  while (i < len) {
    const ch = stream[i];

    // Skip whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\0" || ch === "\f") {
      i++;
      continue;
    }

    // Skip comments
    if (ch === "%") {
      while (i < len && stream[i] !== "\n" && stream[i] !== "\r") i++;
      continue;
    }

    // Literal string (...)
    if (ch === "(") {
      const start = i;
      i++; // skip opening (
      let depth = 1;
      let value = "";
      while (i < len && depth > 0) {
        if (stream[i] === "\\") {
          i++;
          if (i < len) {
            const esc = stream[i];
            if (esc === "n") value += "\n";
            else if (esc === "r") value += "\r";
            else if (esc === "t") value += "\t";
            else if (esc === "b") value += "\b";
            else if (esc === "f") value += "\f";
            else if (esc === "(") value += "(";
            else if (esc === ")") value += ")";
            else if (esc === "\\") value += "\\";
            else if (esc >= "0" && esc <= "7") {
              // Octal escape
              let octal = esc;
              if (i + 1 < len && stream[i + 1] >= "0" && stream[i + 1] <= "7") {
                octal += stream[++i];
                if (i + 1 < len && stream[i + 1] >= "0" && stream[i + 1] <= "7") {
                  octal += stream[++i];
                }
              }
              value += String.fromCharCode(parseInt(octal, 8));
            } else {
              value += esc;
            }
          }
        } else if (stream[i] === "(") {
          depth++;
          value += "(";
        } else if (stream[i] === ")") {
          depth--;
          if (depth > 0) value += ")";
        } else {
          value += stream[i];
        }
        i++;
      }
      tokens.push({ type: "string", value, raw: stream.slice(start, i) });
      continue;
    }

    // Hex string <...>
    if (ch === "<" && (i + 1 >= len || stream[i + 1] !== "<")) {
      const start = i;
      i++; // skip <
      let hex = "";
      while (i < len && stream[i] !== ">") {
        if (stream[i] !== " " && stream[i] !== "\t" && stream[i] !== "\r" && stream[i] !== "\n") {
          hex += stream[i];
        }
        i++;
      }
      if (i < len) i++; // skip >
      tokens.push({ type: "hexstring", value: hex, raw: stream.slice(start, i) });
      continue;
    }

    // Array delimiters
    if (ch === "[") {
      tokens.push({ type: "arrayOpen", raw: "[" });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "arrayClose", raw: "]" });
      i++;
      continue;
    }

    // Name /...
    if (ch === "/") {
      const start = i;
      i++; // skip /
      while (i < len && !isDelimiterOrWhitespace(stream[i])) i++;
      const name = stream.slice(start + 1, i);
      tokens.push({ type: "name", value: name, raw: stream.slice(start, i) });
      continue;
    }

    // Number or operator
    if (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9")) {
      const start = i;
      // Try to parse as number
      if (ch === "-" || ch === "+") i++;
      let hasDigit = false;
      let hasDot = false;
      while (i < len && ((stream[i] >= "0" && stream[i] <= "9") || (stream[i] === "." && !hasDot))) {
        if (stream[i] === ".") hasDot = true;
        else hasDigit = true;
        i++;
      }
      const raw = stream.slice(start, i);
      if (hasDigit) {
        tokens.push({ type: "number", value: parseFloat(raw), raw });
        continue;
      }
      // Not a valid number — treat as operator
      i = start;
    }

    // Operator (alphabetic keyword or remaining chars)
    {
      const start = i;
      // PDF operators are alphabetic keywords or special chars like * ' "
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "'" || ch === '"' || ch === "*") {
        while (i < len && !isDelimiterOrWhitespace(stream[i]) && stream[i] !== "/" && stream[i] !== "(" && stream[i] !== "<" && stream[i] !== "[" && stream[i] !== "]") {
          i++;
        }
      } else {
        i++;
      }
      const raw = stream.slice(start, i);
      tokens.push({ type: "operator", value: raw, raw });
    }
  }

  return tokens;
}

function isDelimiterOrWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n"
    || ch === "\0" || ch === "\f"
    || ch === "(" || ch === ")" || ch === "<" || ch === ">"
    || ch === "[" || ch === "]" || ch === "/" || ch === "%";
}

/* ── Parser: group tokens into instructions ── */

const PDF_OPERATORS = new Set([
  // Graphics state
  "q", "Q", "cm", "w", "J", "j", "M", "d", "ri", "i", "gs",
  // Path
  "m", "l", "c", "v", "y", "h", "re",
  // Path painting
  "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n",
  // Clipping
  "W", "W*",
  // Text state
  "Tc", "Tw", "Tz", "TL", "Tf", "Tr", "Ts",
  // Text objects
  "BT", "ET",
  // Text positioning
  "Td", "TD", "Tm", "T*",
  // Text showing
  "Tj", "TJ", "'", '"',
  // Color
  "CS", "cs", "SC", "SCN", "sc", "scn", "G", "g", "RG", "rg", "K", "k",
  // XObject
  "Do",
  // Inline image
  "BI", "ID", "EI",
  // Marked content
  "BMC", "BDC", "EMC", "MP", "DP",
  // Compatibility
  "BX", "EX",
  // Type 3 font
  "d0", "d1",
]);

export function parse(tokens: Token[]): Instruction[] {
  const instructions: Instruction[] = [];
  let operands: Token[] = [];
  let startIdx = 0;

  // Track character positions for offset mapping
  // We use token index ranges for simplicity in replacement
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "operator" && PDF_OPERATORS.has(tok.value)) {
      instructions.push({
        operands: [...operands],
        operator: tok.value,
        startOffset: startIdx,
        endOffset: i,
      });
      operands = [];
      startIdx = i + 1;
    } else {
      operands.push(tok);
    }
  }

  return instructions;
}

/* ── Text position resolver ── */

interface ResolvedTextItem {
  /** PDF user-space X */
  x: number;
  /** PDF user-space Y */
  y: number;
  /** The instruction index in the instructions array */
  instructionIndex: number;
  /** The operator (Tj, TJ, ', ") */
  operator: string;
  /** Font size in points */
  fontSize: number;
  /** Font name */
  fontName: string;
}

export function resolveTextPositions(instructions: Instruction[]): ResolvedTextItem[] {
  const items: ResolvedTextItem[] = [];

  // Text matrix: [a, b, c, d, e, f] — identity initially
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0]; // text line matrix
  let fontSize = 12;
  let fontName = "";
  let inBT = false;

  for (let idx = 0; idx < instructions.length; idx++) {
    const instr = instructions[idx];
    const op = instr.operator;
    const ops = instr.operands;

    if (op === "BT") {
      inBT = true;
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (op === "ET") {
      inBT = false;
      continue;
    }

    if (!inBT) continue;

    if (op === "Tf" && ops.length >= 2) {
      fontName = ops[0].type === "name" ? ops[0].value : "";
      fontSize = ops[1].type === "number" ? ops[1].value : fontSize;
      continue;
    }

    if (op === "Tm" && ops.length >= 6) {
      const nums = ops.filter(o => o.type === "number").map(o => (o as NumberToken).value);
      if (nums.length >= 6) {
        tm = [...nums.slice(0, 6)];
        tlm = [...tm];
      }
      continue;
    }

    if ((op === "Td" || op === "TD") && ops.length >= 2) {
      const tx = ops[0].type === "number" ? (ops[0] as NumberToken).value : 0;
      const ty = ops[1].type === "number" ? (ops[1] as NumberToken).value : 0;
      // Translate the text line matrix
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[0] * tx + tlm[2] * ty + tlm[4], tlm[1] * tx + tlm[3] * ty + tlm[5]];
      tm = [...tlm];
      if (op === "TD") {
        // TD also sets TL = -ty (we don't track TL but note for completeness)
      }
      continue;
    }

    if (op === "T*") {
      // Move to start of next line (equivalent to Td with 0, -TL)
      // Since we don't track TL precisely, just note position stays at tlm
      // This is an approximation
      continue;
    }

    // Text showing operators
    if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      items.push({
        x: tm[4],
        y: tm[5],
        instructionIndex: idx,
        operator: op,
        fontSize: Math.abs(fontSize * tm[3]) || Math.abs(fontSize * tm[0]) || fontSize,
        fontName,
      });
    }
  }

  return items;
}

/* ── Text removal ── */

/**
 * Removes text from a content stream by zeroing out matched Tj/TJ operators.
 * Returns the modified stream text.
 */
export function removeTextFromStream(streamText: string, edits: TextEditPosition[]): string {
  if (edits.length === 0) return streamText;

  const tokens = tokenize(streamText);
  const instructions = parse(tokens);
  const textItems = resolveTextPositions(instructions);

  // Find instructions to zero out
  const toZero = new Set<number>();

  for (const edit of edits) {
    const tolerance = edit.tolerance ?? 2.0;
    for (const item of textItems) {
      if (Math.abs(item.x - edit.pdfX) < tolerance && Math.abs(item.y - edit.pdfY) < tolerance) {
        if (edit.delete) {
          toZero.add(item.instructionIndex);
        }
      }
    }
  }

  if (toZero.size === 0) return streamText;

  // Rebuild the stream, replacing matched text operators with zeroed versions
  // We work on the raw token array, replacing string/hexstring/array content
  const modifiedTokens = tokens.map(t => t.raw);

  for (const instrIdx of toZero) {
    const instr = instructions[instrIdx];
    if (instr.operator === "Tj") {
      // Zero out the single string operand → ()
      for (const op of instr.operands) {
        if (op.type === "string" || op.type === "hexstring") {
          const tokIdx = tokens.indexOf(op);
          if (tokIdx >= 0) {
            modifiedTokens[tokIdx] = op.type === "string" ? "()" : "<>";
          }
        }
      }
    } else if (instr.operator === "TJ") {
      // Zero out all strings in the TJ array
      for (const op of instr.operands) {
        if (op.type === "string" || op.type === "hexstring") {
          const tokIdx = tokens.indexOf(op);
          if (tokIdx >= 0) {
            modifiedTokens[tokIdx] = op.type === "string" ? "()" : "<>";
          }
        }
      }
    } else if (instr.operator === "'" || instr.operator === '"') {
      // ' takes a string, " takes aw ac string
      for (const op of instr.operands) {
        if (op.type === "string" || op.type === "hexstring") {
          const tokIdx = tokens.indexOf(op);
          if (tokIdx >= 0) {
            modifiedTokens[tokIdx] = op.type === "string" ? "()" : "<>";
          }
        }
      }
    }
  }

  return modifiedTokens.join(" ");
}
