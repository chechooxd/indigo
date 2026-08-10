//! Fixture smoke tests. Full TS↔Rust parity is asserted by the Node harness
//! (`packages/compiler/test/parity.mjs`); these tests only guarantee the crate
//! itself parses the corpus and reports errors where expected.

use std::fs;
use std::path::{Path, PathBuf};

use indigo_compiler::{parse_source, resolve, validate};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn read_fixtures(dir: &Path) -> Vec<(String, String)> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "indigo"))
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let source = fs::read_to_string(e.path()).unwrap();
            (name, source)
        })
        .collect();
    entries.sort();
    entries
}

#[test]
fn valid_fixtures_compile() {
    let fixtures = read_fixtures(&fixtures_dir());
    assert!(!fixtures.is_empty(), "no fixtures found");
    for (name, source) in fixtures {
        let schema = parse_source(&source)
            .unwrap_or_else(|errors| panic!("{name}: unexpected parse errors: {errors:?}"));
        // Resolve + validate must not panic and must round-trip to JSON.
        let resolved = resolve::resolve(&schema);
        let _ = validate::validate(&schema);
        serde_json::to_string(&schema).unwrap();
        serde_json::to_string(&resolved).unwrap();
    }
}

#[test]
fn error_fixtures_report_errors() {
    let fixtures = read_fixtures(&fixtures_dir().join("errors"));
    assert!(!fixtures.is_empty(), "no error fixtures found");
    for (name, source) in fixtures {
        let errors = parse_source(&source)
            .err()
            .unwrap_or_else(|| panic!("{name}: expected parse errors, got none"));
        assert!(!errors.is_empty(), "{name}: empty error list");
        for e in &errors {
            assert!(e.line >= 1, "{name}: error without a line: {e:?}");
        }
    }
}

#[test]
fn illegal_char_error_points_at_line() {
    let source = fs::read_to_string(fixtures_dir().join("errors/e2-illegal-char.indigo")).unwrap();
    let errors = parse_source(&source).unwrap_err();
    assert_eq!(errors[0].line, 3, "first error should be on the '~' line");
}

#[test]
fn strings_are_unescaped() {
    let schema = parse_source(r#"Table T { f String @note("say \"hi\"") }"#).unwrap();
    let json = serde_json::to_string(&schema).unwrap();
    // Decoded content: literal quotes, no backslashes left in the value.
    assert!(json.contains("\"value\":\"say \\\"hi\\\"\""), "got: {json}");
}

#[test]
fn all_recognized_escapes_decode() {
    // \\ \" \n \r \t — the full recognized escape set (design decision 3).
    let source = r#"Table T { f String @note("a\\b\nc\rd\te\"f") }"#;
    let schema = parse_source(source).unwrap();
    let note = &schema.models[0].fields[0].attributes[0].args[0].value;
    match note {
        indigo_compiler::ast::AttributeValue::String { value } => {
            assert_eq!(value, "a\\b\nc\rd\te\"f", "decoded escape set mismatch: {value:?}");
        }
        other => panic!("expected a String attribute value, got: {other:?}"),
    }
}

#[test]
fn unknown_escape_sequence_is_an_error() {
    let source = "Table T { f String @note(\"bad \\q escape\") }";
    let errors = parse_source(source).unwrap_err();
    let escape_error = errors
        .iter()
        .find(|e| e.message.contains("\\q"))
        .unwrap_or_else(|| panic!("expected an unknown-escape diagnostic, got: {errors:?}"));
    assert_eq!(escape_error.line, 1, "expected error on line 1: {escape_error:?}");
    // Column of the backslash: 1-based, points at '\' in '\q'.
    assert_eq!(escape_error.column, 31, "expected column of the backslash: {escape_error:?}");
}

#[test]
fn lexer_errors_do_not_suppress_parser_errors() {
    let source = "Table User {\n  id ~Int @id\n\nTable Post {\n  id Int @id\n";
    let errors = parse_source(source).unwrap_err();
    let has_illegal_char = errors.iter().any(|e| e.message.contains("unexpected character"));
    let has_parser_error = errors
        .iter()
        .any(|e| e.message.to_lowercase().contains("expected") && e.line >= 4);
    assert!(has_illegal_char, "expected an illegal-character diagnostic, got: {errors:?}");
    assert!(has_parser_error, "expected a parser diagnostic too, got: {errors:?}");
}

fn gadget_fk(schema: &indigo_compiler::ast::Schema) -> indigo_compiler::ir::ForeignKey {
    let resolved = resolve::resolve(schema);
    resolved
        .tables
        .into_iter()
        .find(|t| t.name == "Gadget")
        .expect("Gadget table")
        .foreign_keys
        .into_iter()
        .next()
        .expect("Gadget.widget foreign key")
}

#[test]
fn bare_on_delete_reaches_the_foreign_key() {
    let source = "Table Widget { id Int @id }\n\
                  Table Gadget {\n\
                  \x20 id Int @id\n\
                  \x20 widgetId Int\n\
                  \x20 widget Widget @relation(fields: [widgetId], references: [id], onDelete: Cascade)\n\
                  }";
    let schema = parse_source(source).unwrap();
    assert_eq!(gadget_fk(&schema).on_delete.as_deref(), Some("CASCADE"));
}

#[test]
fn quoted_on_delete_matches_bare_form() {
    let source = "Table Widget { id Int @id }\n\
                  Table Gadget {\n\
                  \x20 id Int @id\n\
                  \x20 widgetId Int\n\
                  \x20 widget Widget @relation(fields: [widgetId], references: [id], onDelete: \"Cascade\")\n\
                  }";
    let schema = parse_source(source).unwrap();
    assert_eq!(gadget_fk(&schema).on_delete.as_deref(), Some("CASCADE"));
}

#[test]
fn absent_referential_actions_stay_absent() {
    let source = "Table Widget { id Int @id }\n\
                  Table Gadget {\n\
                  \x20 id Int @id\n\
                  \x20 widgetId Int\n\
                  \x20 widget Widget @relation(fields: [widgetId], references: [id])\n\
                  }";
    let schema = parse_source(source).unwrap();
    let fk = gadget_fk(&schema);
    assert_eq!(fk.on_delete, None);
    assert_eq!(fk.on_update, None);
}

#[test]
fn bare_on_update_reaches_the_foreign_key() {
    let source = "Table Widget { id Int @id }\n\
                  Table Gadget {\n\
                  \x20 id Int @id\n\
                  \x20 widgetId Int\n\
                  \x20 widget Widget @relation(fields: [widgetId], references: [id], onUpdate: Restrict)\n\
                  }";
    let schema = parse_source(source).unwrap();
    assert_eq!(gadget_fk(&schema).on_update.as_deref(), Some("RESTRICT"));
}

#[test]
fn enum_value_map_reaches_resolved_members() {
    let source = "enum Status { ACTIVE @map(\"active\") INACTIVE }\n\
                  Table Widget { id Int @id status Status }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let status = resolved.enums.into_iter().find(|e| e.name == "Status").expect("Status enum");
    assert_eq!(status.members[0].name, "ACTIVE");
    assert_eq!(status.members[0].db_name, "active");
    assert_eq!(status.members[1].name, "INACTIVE");
    assert_eq!(status.members[1].db_name, "INACTIVE");
    // `values` stays a plain name list — unchanged consumer contract.
    assert_eq!(status.values, vec!["ACTIVE", "INACTIVE"]);
}
