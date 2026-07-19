//! Structured compiler errors crossing the WASM boundary.
//!
//! Superset of the TS `ParseErrorDetail` (`{message, line?, column?}`):
//! line/column are always present here, plus optional end positions for a
//! future LSP. The TS wrapper reconstructs `IndigoParseError` from these.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompilerError {
    pub message: String,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}
