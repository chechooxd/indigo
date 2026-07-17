/**
 * @indigodb/parser — Lexer
 *
 * Defines all Chevrotain tokens for the .indigo schema language.
 * Token order matters: longer/more-specific patterns must appear before
 * shorter/general ones (e.g., DoubleAt before At, keywords before Identifier).
 */

import { createToken, Lexer } from "chevrotain";

// ─── Whitespace & Comments (skipped) ─────────────────────────────────────────

export const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /\s+/,
  group: Lexer.SKIPPED,
});

export const LineComment = createToken({
  name: "LineComment",
  pattern: /\/\/[^\n]*/,
  group: Lexer.SKIPPED,
});

export const BlockComment = createToken({
  name: "BlockComment",
  pattern: /\/\*[\s\S]*?\*\//,
  group: Lexer.SKIPPED,
});

// ─── Keywords ────────────────────────────────────────────────────────────────

export const ModelKeyword = createToken({
  name: "ModelKeyword",
  pattern: /model/,
  longer_alt: undefined,
});

export const EnumKeyword = createToken({
  name: "EnumKeyword",
  pattern: /enum/,
  longer_alt: undefined,
});

export const DatasourceKeyword = createToken({
  name: "DatasourceKeyword",
  pattern: /datasource/,
  longer_alt: undefined,
});

export const GeneratorKeyword = createToken({
  name: "GeneratorKeyword",
  pattern: /generator/,
  longer_alt: undefined,
});

export const TrueKeyword = createToken({
  name: "TrueKeyword",
  pattern: /true/,
  longer_alt: undefined,
});

export const FalseKeyword = createToken({
  name: "FalseKeyword",
  pattern: /false/,
  longer_alt: undefined,
});

// ─── Identifier (MUST come after keywords) ───────────────────────────────────

export const Identifier = createToken({
  name: "Identifier",
  pattern: /[a-zA-Z_]\w*/,
});

// Set longer_alt so keywords don't swallow identifiers that start with them
ModelKeyword.LONGER_ALT = Identifier;
EnumKeyword.LONGER_ALT = Identifier;
DatasourceKeyword.LONGER_ALT = Identifier;
GeneratorKeyword.LONGER_ALT = Identifier;
TrueKeyword.LONGER_ALT = Identifier;
FalseKeyword.LONGER_ALT = Identifier;

// ─── Literals ────────────────────────────────────────────────────────────────

export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"(?:[^"\\]|\\.)*"/,
});

export const NumberLiteral = createToken({
  name: "NumberLiteral",
  pattern: /-?\d+(\.\d+)?/,
});

// ─── Punctuation ─────────────────────────────────────────────────────────────

export const DoubleAt = createToken({ name: "DoubleAt", pattern: /@@/ });
export const At = createToken({ name: "At", pattern: /@/ });
export const LCurly = createToken({ name: "LCurly", pattern: /\{/ });
export const RCurly = createToken({ name: "RCurly", pattern: /\}/ });
export const LParen = createToken({ name: "LParen", pattern: /\(/ });
export const RParen = createToken({ name: "RParen", pattern: /\)/ });
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });
export const Colon = createToken({ name: "Colon", pattern: /:/ });
export const QuestionMark = createToken({ name: "QuestionMark", pattern: /\?/ });
export const Equals = createToken({ name: "Equals", pattern: /=/ });

// ─── Token List ──────────────────────────────────────────────────────────────
// Order matters: longer/more-specific tokens must appear earlier.

export const allTokens = [
  // Skipped
  WhiteSpace,
  LineComment,
  BlockComment,

  // Literals (before Identifier to avoid collision)
  StringLiteral,
  NumberLiteral,

  // Multi-char punctuation before single-char
  DoubleAt,
  At,

  // Keywords (before Identifier)
  ModelKeyword,
  EnumKeyword,
  DatasourceKeyword,
  GeneratorKeyword,
  TrueKeyword,
  FalseKeyword,

  // Identifier
  Identifier,

  // Single-char punctuation
  LCurly,
  RCurly,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Colon,
  QuestionMark,
  Equals,
];

/** The Chevrotain Lexer instance for the .indigo schema language. */
export const IndigoLexer = new Lexer(allTokens, {
  ensureOptimizations: true,
});
