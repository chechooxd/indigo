//! Lexer for the `.indigo` language (port of parser/src/lexer.ts).
//!
//! Keywords are matched post-lex from identifiers, replicating Chevrotain's
//! `LONGER_ALT = Identifier` semantics exactly: `Tables` is an identifier,
//! `Table` is a keyword. Spans are 1-based line/column like Chevrotain.
//! Illegal characters are collected as errors (all of them, not just the
//! first) and skipped so lexing continues.

use logos::Logos;

use crate::error::CompilerError;

#[derive(Logos, Clone, Copy, Debug, PartialEq, Eq)]
#[logos(skip r"[ \t\r\n\u{000C}]+")]
#[logos(skip r"//[^\n]*")]
#[logos(skip r"/\*([^*]|\*+[^*/])*\*+/")]
enum RawToken {
    #[token("@@")]
    DoubleAt,
    #[token("@")]
    At,
    #[token("{")]
    LBrace,
    #[token("}")]
    RBrace,
    #[token("(")]
    LParen,
    #[token(")")]
    RParen,
    #[token("[")]
    LBracket,
    #[token("]")]
    RBracket,
    #[token(",")]
    Comma,
    #[token(".")]
    Dot,
    #[token(":")]
    Colon,
    #[token("?")]
    QuestionMark,
    #[token("=")]
    Equals,
    #[token("==")]
    EqEq,
    #[regex(r#""([^"\\]|\\.)*""#)]
    StringLiteral,
    #[regex(r"-?[0-9]+(\.[0-9]+)?")]
    NumberLiteral,
    #[regex(r"[a-zA-Z_][a-zA-Z0-9_]*")]
    Identifier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    DoubleAt,
    At,
    LBrace,
    RBrace,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Dot,
    Colon,
    QuestionMark,
    Equals,
    EqEq,
    StringLiteral,
    NumberLiteral,
    Identifier,
    KwTable,
    KwTableGroup,
    KwEnum,
    KwDatasource,
    KwGenerator,
    KwTrue,
    KwFalse,
    Eof,
}

impl TokenKind {
    pub fn describe(self) -> &'static str {
        match self {
            TokenKind::DoubleAt => "'@@'",
            TokenKind::At => "'@'",
            TokenKind::LBrace => "'{'",
            TokenKind::RBrace => "'}'",
            TokenKind::LParen => "'('",
            TokenKind::RParen => "')'",
            TokenKind::LBracket => "'['",
            TokenKind::RBracket => "']'",
            TokenKind::Comma => "','",
            TokenKind::Dot => "'.'",
            TokenKind::Colon => "':'",
            TokenKind::QuestionMark => "'?'",
            TokenKind::Equals => "'='",
            TokenKind::EqEq => "'=='",
            TokenKind::StringLiteral => "a string",
            TokenKind::NumberLiteral => "a number",
            TokenKind::Identifier => "an identifier",
            TokenKind::KwTable => "'Table'",
            TokenKind::KwTableGroup => "'TableGroup'",
            TokenKind::KwEnum => "'enum'",
            TokenKind::KwDatasource => "'datasource'",
            TokenKind::KwGenerator => "'generator'",
            TokenKind::KwTrue => "'true'",
            TokenKind::KwFalse => "'false'",
            TokenKind::Eof => "end of file",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// UTF-8 byte offsets from `lexer.span()`, end-exclusive. Consumed by
    /// `span.rs`'s `SpanContext` to build UTF-16 `SourceSpan`s for
    /// `parse_with_spans` — unrelated to `line`/`column` above, which stay
    /// on the pre-existing (inclusive-end, byte-column) convention used by
    /// `CompilerError` diagnostics.
    pub start: usize,
    pub end: usize,
}

/// Maps byte offsets to 1-based (line, column).
pub struct LineIndex {
    line_starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let mut line_starts = vec![0usize];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        Self { line_starts }
    }

    pub fn position(&self, offset: usize) -> (u32, u32) {
        let line = match self.line_starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        let column = offset - self.line_starts[line] + 1;
        (line as u32 + 1, column as u32)
    }
}

/// Decodes the recognized escape sequences (`\\`, `\"`, `\n`, `\r`, `\t`)
/// inside a string literal's content (quotes already stripped).
///
/// `inner_start` is the absolute byte offset, within the full source, of
/// `inner`'s first byte — needed to report an exact 1-based line/column for
/// an unknown escape sequence.
fn unescape(inner: &str, inner_start: usize, index: &LineIndex) -> Result<String, CompilerError> {
    let mut result = String::with_capacity(inner.len());
    let mut chars = inner.char_indices();
    while let Some((offset, ch)) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        // The lexer's regex (`\\.`) guarantees a character follows.
        let (_, escaped) = chars.next().expect("regex guarantees a char follows '\\'");
        match escaped {
            '\\' => result.push('\\'),
            '"' => result.push('"'),
            'n' => result.push('\n'),
            'r' => result.push('\r'),
            't' => result.push('\t'),
            other => {
                let (line, column) = index.position(inner_start + offset);
                return Err(CompilerError {
                    message: format!("unknown escape sequence \"\\{other}\""),
                    line,
                    column,
                    end_line: Some(line),
                    end_column: Some(column + 2),
                });
            }
        }
    }
    Ok(result)
}

fn keyword_for(text: &str) -> Option<TokenKind> {
    match text {
        "Table" => Some(TokenKind::KwTable),
        "TableGroup" => Some(TokenKind::KwTableGroup),
        "enum" => Some(TokenKind::KwEnum),
        "datasource" => Some(TokenKind::KwDatasource),
        "generator" => Some(TokenKind::KwGenerator),
        "true" => Some(TokenKind::KwTrue),
        "false" => Some(TokenKind::KwFalse),
        _ => None,
    }
}

pub fn tokenize(source: &str) -> (Vec<Token>, Vec<CompilerError>) {
    let index = LineIndex::new(source);
    let mut tokens = Vec::new();
    let mut errors = Vec::new();
    let mut lexer = RawToken::lexer(source);

    while let Some(result) = lexer.next() {
        let span = lexer.span();
        let (line, column) = index.position(span.start);
        let (end_line, end_column) = index.position(span.end.saturating_sub(1).max(span.start));
        match result {
            Ok(RawToken::StringLiteral) => {
                let raw = &source[span.clone()];
                // Strip the surrounding quotes; content starts one byte in.
                let inner = &raw[1..raw.len() - 1];
                match unescape(inner, span.start + 1, &index) {
                    Ok(decoded) => tokens.push(Token {
                        kind: TokenKind::StringLiteral,
                        text: decoded,
                        line,
                        column,
                        end_line,
                        end_column,
                        start: span.start,
                        end: span.end,
                    }),
                    Err(escape_error) => {
                        errors.push(escape_error);
                        // Recover with the raw (un-decoded) content so the
                        // parser still sees a StringLiteral token here.
                        tokens.push(Token {
                            kind: TokenKind::StringLiteral,
                            text: inner.to_string(),
                            line,
                            column,
                            end_line,
                            end_column,
                            start: span.start,
                            end: span.end,
                        });
                    }
                }
            }
            Ok(raw) => {
                let text = &source[span.clone()];
                let kind = match raw {
                    RawToken::DoubleAt => TokenKind::DoubleAt,
                    RawToken::At => TokenKind::At,
                    RawToken::LBrace => TokenKind::LBrace,
                    RawToken::RBrace => TokenKind::RBrace,
                    RawToken::LParen => TokenKind::LParen,
                    RawToken::RParen => TokenKind::RParen,
                    RawToken::LBracket => TokenKind::LBracket,
                    RawToken::RBracket => TokenKind::RBracket,
                    RawToken::Comma => TokenKind::Comma,
                    RawToken::Dot => TokenKind::Dot,
                    RawToken::Colon => TokenKind::Colon,
                    RawToken::QuestionMark => TokenKind::QuestionMark,
                    RawToken::Equals => TokenKind::Equals,
                    RawToken::EqEq => TokenKind::EqEq,
                    RawToken::StringLiteral => unreachable!("handled above"),
                    RawToken::NumberLiteral => TokenKind::NumberLiteral,
                    RawToken::Identifier => keyword_for(text).unwrap_or(TokenKind::Identifier),
                };
                tokens.push(Token {
                    kind,
                    text: text.to_string(),
                    line,
                    column,
                    end_line,
                    end_column,
                    start: span.start,
                    end: span.end,
                });
            }
            Err(()) => {
                let snippet = &source[span.clone()];
                errors.push(CompilerError {
                    message: format!("unexpected character(s) {snippet:?}"),
                    line,
                    column,
                    end_line: Some(end_line),
                    end_column: Some(end_column),
                });
            }
        }
    }

    let eof_offset = source.len();
    let (line, column) = index.position(eof_offset);
    tokens.push(Token {
        kind: TokenKind::Eof,
        text: String::new(),
        line,
        column,
        end_line: line,
        end_column: column,
        start: eof_offset,
        end: eof_offset,
    });

    (tokens, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_lexes_to_a_dot_token() {
        let (tokens, errors) = tokenize(".");
        assert!(errors.is_empty());
        assert_eq!(tokens[0].kind, TokenKind::Dot);
        assert_eq!(tokens[0].text, ".");
    }

    #[test]
    fn dot_token_describe_is_quoted_dot() {
        assert_eq!(TokenKind::Dot.describe(), "'.'");
    }

    #[test]
    fn double_equals_lexes_to_a_single_eqeq_token() {
        let (tokens, errors) = tokenize("==");
        assert!(errors.is_empty());
        assert_eq!(tokens[0].kind, TokenKind::EqEq);
        assert_eq!(tokens[0].text, "==");
        // Only one token before Eof — logos' longest-match must not split it
        // into two Equals tokens.
        assert_eq!(tokens[1].kind, TokenKind::Eof);
    }

    #[test]
    fn single_equals_still_lexes_to_equals() {
        let (tokens, errors) = tokenize("=");
        assert!(errors.is_empty());
        assert_eq!(tokens[0].kind, TokenKind::Equals);
        assert_eq!(tokens[0].text, "=");
    }

    #[test]
    fn eqeq_token_describe_is_quoted_double_equals() {
        assert_eq!(TokenKind::EqEq.describe(), "'=='");
    }
}
