//! indigo-compiler — the `.indigo` schema compiler.
//!
//! Rust port of `@indigodb/parser` (Chevrotain) + `@indigodb/core`
//! (resolve/validate), compiled to WASM and consumed by the TS wrappers in
//! `packages/compiler`. The boundary speaks JSON strings; every export
//! returns an envelope: `{"ok": ...}` on success, `{"errors": [...]}` (parse)
//! or `{"error": "..."}` (resolve/validate) on failure.

pub mod ast;
pub mod error;
pub mod ir;
pub mod lexer;
pub mod parser;
pub mod resolve;
pub mod rules;
pub mod validate;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use error::CompilerError;

/// Parses source into a `Schema`, or every lexer+parser error found.
/// The parser always runs over the token stream, even when the lexer
/// reported errors, so both diagnostic classes surface from the same pass.
/// Errors are concatenated lexer-first, then parser: this is a deliberate
/// ordering (not a merge-sort by position) that keeps the illegal-character
/// diagnostic first when both classes fire on the same source.
pub fn parse_source(source: &str) -> Result<ast::Schema, Vec<CompilerError>> {
    let (tokens, mut lex_errors) = lexer::tokenize(source);
    let (schema, parse_errors) = parser::Parser::new(&tokens).parse_schema();
    if lex_errors.is_empty() && parse_errors.is_empty() {
        return Ok(schema);
    }
    lex_errors.extend(parse_errors);
    Err(lex_errors)
}

#[derive(Serialize)]
struct OkEnvelope<T: Serialize> {
    ok: T,
}

#[derive(Serialize)]
struct ErrorsEnvelope<'a> {
    errors: &'a [CompilerError],
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileOutput {
    schema: ast::Schema,
    resolved: ir::ResolvedSchema,
    validation_errors: Vec<ir::ValidationError>,
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("compiler output is always serializable")
}

fn deserialize_schema(schema_json: &str) -> Result<ast::Schema, String> {
    serde_json::from_str(schema_json).map_err(|e| format!("invalid Schema JSON: {e}"))
}

/// `{"ok": Schema}` | `{"errors": CompilerError[]}`
#[wasm_bindgen]
pub fn parse(source: &str) -> String {
    match parse_source(source) {
        Ok(schema) => to_json(&OkEnvelope { ok: schema }),
        Err(errors) => to_json(&ErrorsEnvelope { errors: &errors }),
    }
}

/// Accepts a `Schema` as JSON. `{"ok": ResolvedSchema}` | `{"error": string}`
#[wasm_bindgen]
pub fn resolve(schema_json: &str) -> String {
    match deserialize_schema(schema_json) {
        Ok(schema) => to_json(&OkEnvelope { ok: resolve::resolve(&schema) }),
        Err(error) => to_json(&ErrorEnvelope { error }),
    }
}

/// Accepts a `Schema` as JSON. `{"ok": ValidationError[]}` | `{"error": string}`
#[wasm_bindgen]
pub fn validate(schema_json: &str) -> String {
    match deserialize_schema(schema_json) {
        Ok(schema) => to_json(&OkEnvelope { ok: validate::validate(&schema) }),
        Err(error) => to_json(&ErrorEnvelope { error }),
    }
}

/// One-shot parse+validate+resolve.
/// `{"ok": {schema, resolved, validationErrors}}` | `{"errors": CompilerError[]}`
#[wasm_bindgen]
pub fn compile(source: &str) -> String {
    match parse_source(source) {
        Ok(schema) => {
            let validation_errors = validate::validate(&schema);
            let resolved = resolve::resolve(&schema);
            to_json(&OkEnvelope { ok: CompileOutput { schema, resolved, validation_errors } })
        }
        Err(errors) => to_json(&ErrorsEnvelope { errors: &errors }),
    }
}
