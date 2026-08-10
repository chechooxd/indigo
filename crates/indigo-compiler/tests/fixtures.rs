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

// ─── Phase 3: attribute / relation / referential-action / datasource validation ──
// Schema sources are single-line: the lexer treats newlines as whitespace,
// so this is semantically identical to a multi-line `.indigo` file.

fn validate_src(source: &str) -> Vec<indigo_compiler::ir::ValidationError> {
    validate::validate(&parse_source(source).unwrap())
}

#[test]
fn unrecognized_and_misarged_attributes_are_rejected() {
    let errors = validate_src(
        "Table Widget { id Int @id(\"x\") name String @uniqe @map() count Int @default(\"nope\") } \
         Table Gadget { id Int @id widgetId Int widget Widget @relation(fields: [widgetId], references: [id], onDlete: Cascade) } \
         Table Widget2 { id Int @id @@deafult }",
    );
    let has = |field: &str, needle: &str| {
        errors.iter().any(|e| e.field.as_deref() == Some(field) && e.message.contains(needle))
    };
    assert!(has("id", "@id"), "expected an @id arity diagnostic, got: {errors:?}");
    assert!(has("name", "@uniqe"), "expected an unknown-attribute diagnostic, got: {errors:?}");
    assert!(has("name", "@map"), "expected an @map arity diagnostic, got: {errors:?}");
    assert!(has("count", "Int"), "expected an @default type-mismatch diagnostic, got: {errors:?}");
    assert!(
        errors.iter().any(|e| e.message.contains("onDlete") && e.message.contains("fields")),
        "expected an unknown @relation argument diagnostic naming the whitelist, got: {errors:?}"
    );
    assert!(
        errors.iter().any(|e| e.message.contains("@@deafult") && e.model.as_deref() == Some("Widget2")),
        "expected an unknown model attribute diagnostic, got: {errors:?}"
    );
}

#[test]
fn valid_default_forms_stay_clean() {
    let errors = validate_src(
        "enum Status { ACTIVE } Table Widget { id Int @id @default(autoincrement()) status Status @default(ACTIVE) }",
    );
    assert!(errors.is_empty(), "expected no diagnostics, got: {errors:?}");
}

#[test]
fn implicit_many_to_many_is_rejected_but_explicit_shapes_are_not() {
    let errors = validate_src("Table Post { id Int @id tags Tag[] } Table Tag { id Int @id posts Post[] }");
    let m2m: Vec<_> = errors.iter().filter(|e| e.message.contains("many-to-many")).collect();
    assert_eq!(m2m.len(), 1, "expected exactly one implicit-many-to-many diagnostic, got: {errors:?}");
    assert!(m2m[0].message.contains("Post") && m2m[0].message.contains("Tag"));
    assert!(m2m[0].message.to_lowercase().contains("explicit join model"));

    let one_to_many = validate_src(
        "Table User { id Int @id posts Post[] } \
         Table Post { id Int @id authorId Int author User @relation(fields: [authorId], references: [id]) }",
    );
    assert!(one_to_many.iter().all(|e| !e.message.contains("many-to-many")));

    let join_model = validate_src(
        "Table Post { id Int @id tags PostTag[] } Table Tag { id Int @id posts PostTag[] } \
         Table PostTag { postId Int tagId Int post Post @relation(fields: [postId], references: [id]) tag Tag @relation(fields: [tagId], references: [id]) }",
    );
    assert!(join_model.iter().all(|e| !e.message.contains("many-to-many")));
}

#[test]
fn invalid_referential_action_values_are_rejected() {
    let relation_with = |action: &str| {
        validate_src(&format!(
            "Table Widget {{ id Int @id }} Table Gadget {{ id Int @id widgetId Int widget Widget @relation(fields: [widgetId], references: [id], onDelete: {action}) }}"
        ))
    };
    let errors = relation_with("Nonsense");
    assert!(
        errors.iter().any(|e| e.message.contains("Nonsense") && e.message.contains("Cascade")),
        "expected an invalid-value diagnostic naming the allowed set, got: {errors:?}"
    );
    let errors = relation_with("cascade");
    assert!(
        errors.iter().any(|e| e.message.contains("cascade")),
        "expected lowercase 'cascade' to be rejected, got: {errors:?}"
    );
}

#[test]
fn datasource_provider_duplicates_and_generator_are_validated() {
    let bad_provider = validate_src(
        "datasource db { provider = \"mysql\" url = env(\"DATABASE_URL\") } \
         generator client { provider = \"indigodb-client-ts\" } Table T { id Int @id }",
    );
    assert!(
        bad_provider.iter().any(|e| e.message.contains("mysql") && e.message.contains("postgresql")),
        "expected an unsupported-provider diagnostic, got: {bad_provider:?}"
    );
    assert!(
        bad_provider.iter().all(|e| !e.message.contains("indigodb-client-ts")),
        "generator.provider must be untouched: {bad_provider:?}"
    );

    let missing_provider = validate_src("datasource db { url = env(\"DATABASE_URL\") } Table T { id Int @id }");
    assert!(
        missing_provider.iter().any(|e| e.message.contains("postgresql")),
        "expected a missing-provider diagnostic, got: {missing_provider:?}"
    );

    let duplicate = validate_src(
        "datasource db1 { provider = \"postgresql\" url = env(\"DATABASE_URL\") } \
         datasource db2 { provider = \"postgresql\" url = env(\"DATABASE_URL\") } Table T { id Int @id }",
    );
    assert!(
        duplicate.iter().any(|e| e.message.contains("db1") && e.message.contains("db2")),
        "expected a duplicate-datasource diagnostic naming both blocks, got: {duplicate:?}"
    );
}

/// Approval test: pins the exact `ValidationError[]` for the 5 valid
/// fixtures. `03`/`05` already had unrelated pre-existing errors — those
/// must survive unchanged; Phase 3's new checks must add ZERO diagnostics.
#[test]
fn corpus_validation_errors_are_unchanged_by_new_rules() {
    let expected: &[(&str, &[&str])] = &[
        ("01-cli-template.indigo", &[]),
        ("02-studio-initial.indigo", &[]),
        ("03-quirks-values.indigo", &["Model \"NoPk\" has no @id primary key.", "Unknown type \"Missing\" on field \"broken\"."]),
        ("04-tablegroup-edge.indigo", &[]),
        ("05-relations.indigo", &[
            "Duplicate model \"User\".",
            "@relation(fields:) references unknown local field \"missingLocal\".",
            "@relation(references:) points at unknown field \"missingTarget\" on \"User\".",
        ]),
    ];
    for (name, messages) in expected {
        let source = fs::read_to_string(fixtures_dir().join(name)).unwrap();
        let schema = parse_source(&source).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let errors = validate::validate(&schema);
        let actual: Vec<&str> = errors.iter().map(|e| e.message.as_str()).collect();
        assert_eq!(&actual, messages, "{name}: unexpected validation errors");
    }
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

#[test]
fn enum_value_map_is_subject_to_attribute_validation() {
    // `@map` on an enum value goes through the same arity and argument-type
    // rules as field and model attributes. Without this test the enum-value
    // target of that rule is unexercised, so a regression there would be
    // silent — which is the defect class this whole change exists to remove.
    let table = "\nTable Widget { id Int @id status Status }";

    let missing_arg = validate_src(&format!("enum Status {{ ACTIVE @map() }}{table}"));
    assert!(
        missing_arg.iter().any(|e| e.message.contains("@map")),
        "expected an arity diagnostic for `@map()` on an enum value, got: {missing_arg:?}"
    );

    let wrong_type = validate_src(&format!("enum Status {{ ACTIVE @map(1) }}{table}"));
    assert!(
        wrong_type.iter().any(|e| e.message.contains("@map")),
        "expected an argument-type diagnostic for `@map(1)` on an enum value, got: {wrong_type:?}"
    );

    // The valid spelling must stay clean, or the rule is over-strict.
    let valid = validate_src(&format!("enum Status {{ ACTIVE @map(\"active\") }}{table}"));
    assert!(
        !valid.iter().any(|e| e.message.contains("@map")),
        "valid `@map(\"active\")` must not be diagnosed, got: {valid:?}"
    );
}
