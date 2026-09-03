//! Source spans: a side channel joined to the AST by index path, never a
//! field on the AST itself (see `parse_with_spans` in `lib.rs`).
//!
//! `SourceSpan.start`/`end` are UTF-16 code-unit offsets, end-exclusive,
//! converted from the lexer's UTF-8 byte offsets at emission time — a
//! single non-ASCII character earlier in the source would otherwise corrupt
//! every later byte offset when sliced from JavaScript (which slices
//! strings in UTF-16 code units). `line`/`column`/`endLine`/`endColumn` are
//! 1-based, matching `CompilerError`'s convention, and computed from byte
//! offsets directly (same pre-existing non-ASCII column quirk as
//! `LineIndex::position` in `lexer.rs` — out of scope here, see design D2).

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub start: u32,
    pub end: u32,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttributeSpan {
    pub name: String,
    pub span: SourceSpan,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpan {
    pub name: String,
    pub decl: SourceSpan,
    pub name_token: SourceSpan,
    pub type_token: SourceSpan,
    pub attributes: Vec<AttributeSpan>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpan {
    pub name: String,
    pub decl: SourceSpan,
    pub name_token: SourceSpan,
    pub body_open: SourceSpan,
    pub body_close: SourceSpan,
    pub fields: Vec<FieldSpan>,
    pub attributes: Vec<SourceSpan>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpanIndex {
    pub models: Vec<ModelSpan>,
}

/// Byte offset (UTF-8) → (UTF-16 code-unit offset, 1-based line, 1-based
/// column) lookup, built once per source and reused for every span in it.
///
/// `byte_to_utf16` is a direct array indexed by byte offset: only byte
/// offsets that fall on a `char` boundary are ever queried (token/lexeme
/// boundaries always are), so a plain `Vec<u32>` gives O(1) lookup without
/// needing a sparse map.
pub struct SpanContext {
    byte_to_utf16: Vec<u32>,
    line_starts: Vec<usize>,
}

impl SpanContext {
    pub fn new(source: &str) -> Self {
        let mut byte_to_utf16 = vec![0u32; source.len() + 1];
        let mut utf16 = 0u32;
        for (byte_offset, ch) in source.char_indices() {
            byte_to_utf16[byte_offset] = utf16;
            utf16 += ch.len_utf16() as u32;
        }
        byte_to_utf16[source.len()] = utf16;

        let mut line_starts = vec![0usize];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }

        Self { byte_to_utf16, line_starts }
    }

    fn position(&self, byte_offset: usize) -> (u32, u32) {
        let line = match self.line_starts.binary_search(&byte_offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        let column = byte_offset - self.line_starts[line] + 1;
        (line as u32 + 1, column as u32)
    }

    /// Builds an end-exclusive `SourceSpan` from raw UTF-8 byte offsets
    /// (`byte_start`, `byte_end`) as produced by `logos`/`Token`.
    pub fn span(&self, byte_start: usize, byte_end: usize) -> SourceSpan {
        let (line, column) = self.position(byte_start);
        let (end_line, end_column) = self.position(byte_end);
        SourceSpan {
            start: self.byte_to_utf16[byte_start],
            end: self.byte_to_utf16[byte_end],
            line,
            column,
            end_line,
            end_column,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_field_span_covers_exactly_its_text() {
        let source = "Table User {\n  id Int @id\n}\n";
        let ctx = SpanContext::new(source);
        let start = source.find("id Int @id").unwrap();
        let end = start + "id Int @id".len();
        let span = ctx.span(start, end);
        assert_eq!(&source[span.start as usize..span.end as usize], "id Int @id");
        assert_eq!(span.line, 2);
        assert_eq!(span.column, 3);
    }

    #[test]
    fn swapped_start_end_would_slice_the_wrong_text() {
        // Negative control for the mutation described in task 1.1: swapping
        // start/end must NOT still slice the correct text — a swapped range
        // is backwards (start > end), so a direct `source[start..end]`
        // slice using the swapped values would panic instead of yielding
        // `"id Int @id"`.
        let source = "Table User {\n  id Int @id\n}\n";
        let ctx = SpanContext::new(source);
        let start = source.find("id Int @id").unwrap();
        let end = start + "id Int @id".len();
        let span = ctx.span(start, end);
        assert!(span.start < span.end, "span must be non-empty for this fixture");
        let swapped_start = span.end;
        let swapped_end = span.start;
        assert!(
            swapped_start > swapped_end,
            "swapping start/end must produce a backwards, unusable range"
        );
    }

    #[test]
    fn non_ascii_prefix_does_not_corrupt_a_later_field_span() {
        // `café` is 4 chars / 5 bytes (é is 2 bytes in UTF-8) / 4 UTF-16
        // code units. A byte-offset span for the field below would be off
        // by one relative to the correct UTF-16 offset.
        let source = "Table Post {\n  @note(\"café\")\n  title String\n}\n";
        let ctx = SpanContext::new(source);
        let byte_start = source.find("title String").unwrap();
        let byte_end = byte_start + "title String".len();
        let span = ctx.span(byte_start, byte_end);
        // UTF-16 slicing must land on exactly the target text.
        let utf16: Vec<u16> = source.encode_utf16().collect();
        let sliced: String =
            String::from_utf16(&utf16[span.start as usize..span.end as usize]).unwrap();
        assert_eq!(sliced, "title String");
        // A raw byte-offset span (the bug this guards against) would be
        // shifted by the one extra UTF-8 byte `é` contributes.
        assert_ne!(span.start as usize, byte_start);
    }
}
