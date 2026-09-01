//! Fixture smoke tests. Full TS↔Rust parity is asserted by the Node harness
//! (`packages/compiler/test/parity.mjs`); these tests only guarantee the crate
//! itself parses the corpus and reports errors where expected.

use std::fs;
use std::path::{Path, PathBuf};

use indigo_compiler::{ir, parse_source, resolve, validate};

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
            // NEW (relations-epic): Post.author + Post.ghost are both unnamed FK
            // relations to User, with User.posts an observable unnamed inverse —
            // this is genuinely ambiguous under the new pairing rule (deliberate
            // churn, not a regression; see design.md Open Questions).
            "Ambiguous relation between \"Post\" and \"User\": multiple relation fields target the same model. Disambiguate with @relation(\"Name\", ...) on both sides.",
            "Duplicate model \"User\".",
            "@relation(fields:) references unknown local field \"missingLocal\".",
            "@relation(references:) points at unknown field \"missingTarget\" on \"User\".",
        ]),
        ("06-scalar-types.indigo", &[]),
        ("07-referential-actions.indigo", &[]),
        ("08-self-relation.indigo", &[]),
        ("09-rejected-composite-id.indigo", &[
            "Unknown model attribute \"@@id\" on model \"Membership\".",
            "Model \"Membership\" has no @id primary key.",
        ]),
        ("10-rejected-updated-at.indigo", &[
            "Unknown field attribute \"@updatedAt\" on field \"Widget.updatedAt\".",
        ]),
        ("11-rejected-ignore.indigo", &[
            "Unknown model attribute \"@@ignore\" on model \"Widget\".",
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

// ─── Phase 1: positional `@relation("Name", ...)` name is allowed ───────────

#[test]
fn relation_positional_name_is_allowed() {
    // Widget declares no counterpart `@relation("GadgetWidget")` field, so this
    // legitimately still produces the (separate, relations-epic) unresolved-name
    // diagnostic — the point of this test is that the positional-arg rejection
    // is gone.
    let errors = validate_src(
        "Table Widget { id Int @id } \
         Table Gadget { id Int @id widgetId Int widget Widget @relation(\"GadgetWidget\", fields: [widgetId], references: [id]) }",
    );
    assert!(
        errors.iter().all(|e| !e.message.contains("does not accept positional arguments")),
        "expected the positional @relation name to be accepted, got: {errors:?}"
    );
}

#[test]
fn relation_second_positional_arg_is_still_rejected() {
    let two_positional = validate_src(
        "Table Widget { id Int @id } \
         Table Gadget { id Int @id widgetId Int widget Widget @relation(\"GadgetWidget\", \"Extra\", fields: [widgetId], references: [id]) }",
    );
    assert!(
        two_positional.iter().any(|e| e.message.contains("does not accept positional arguments")),
        "expected the second positional arg to be rejected with the existing message, got: {two_positional:?}"
    );

    let non_string_positional = validate_src(
        "Table Widget { id Int @id } \
         Table Gadget { id Int @id widgetId Int widget Widget @relation(123, fields: [widgetId], references: [id]) }",
    );
    assert!(
        non_string_positional.iter().any(|e| e.message.contains("does not accept positional arguments")),
        "expected a non-string positional arg to be rejected with the existing message, got: {non_string_positional:?}"
    );
}

// ─── Phase 2: relation name retention in the IR ──────────────────────────────

fn find_relation<'a>(
    resolved: &'a indigo_compiler::ir::ResolvedSchema,
    table: &str,
    field: &str,
) -> &'a indigo_compiler::ir::ResolvedRelation {
    resolved
        .tables
        .iter()
        .find(|t| t.name == table)
        .unwrap_or_else(|| panic!("table {table} not found"))
        .relations
        .iter()
        .find(|r| r.name == field)
        .unwrap_or_else(|| panic!("relation {table}.{field} not found"))
}

#[test]
fn relation_name_is_retained_in_the_ir() {
    let source = "Table User { id Int @id } \
                   Table Post { id Int @id authorId Int author User @relation(\"PostAuthor\", fields: [authorId], references: [id]) }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let author = find_relation(&resolved, "Post", "author");
    assert_eq!(author.relation_name.as_deref(), Some("PostAuthor"));
}

#[test]
fn unnamed_relation_omits_relation_name_key() {
    let source = "Table User { id Int @id } \
                   Table Post { id Int @id authorId Int author User @relation(fields: [authorId], references: [id]) }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let json = serde_json::to_string(&resolved).unwrap();
    assert!(!json.contains("relationName"), "expected no relationName key for an unnamed relation, got: {json}");
}

// ─── Phase 3: cross-model relation pairing ───────────────────────────────────

#[test]
fn single_unnamed_relation_pairs_implicitly() {
    let source = "Table User { id Int @id posts Post[] } \
                   Table Post { id Int @id authorId Int author User @relation(fields: [authorId], references: [id]) }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let author = find_relation(&resolved, "Post", "author");
    let posts = find_relation(&resolved, "User", "posts");
    assert_eq!(posts.fk_columns, author.fk_columns, "inverse fkColumns should mirror the FK holder");
    assert_eq!(posts.ref_columns, author.ref_columns, "inverse refColumns should mirror the FK holder");
    assert_eq!(posts.inverse, Some(true), "inverse side must be flagged");
    assert_eq!(author.inverse, None, "FK-holding side must never be flagged inverse");
}

#[test]
fn named_relations_pair_by_name() {
    let source = "Table User { id Int @id authoredPosts Post[] @relation(\"PostAuthor\") reviewedPosts Post[] @relation(\"PostReviewer\") } \
                   Table Post { id Int @id authorId Int reviewerId Int \
                   author User @relation(\"PostAuthor\", fields: [authorId], references: [id]) \
                   reviewer User @relation(\"PostReviewer\", fields: [reviewerId], references: [id]) }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let author = find_relation(&resolved, "Post", "author");
    let reviewer = find_relation(&resolved, "Post", "reviewer");
    let authored = find_relation(&resolved, "User", "authoredPosts");
    let reviewed = find_relation(&resolved, "User", "reviewedPosts");
    assert_eq!(authored.fk_columns, author.fk_columns);
    assert_eq!(reviewed.fk_columns, reviewer.fk_columns);
    assert_ne!(author.fk_columns, reviewer.fk_columns, "sanity: the two FK legs must differ");
    assert_eq!(authored.inverse, Some(true));
    assert_eq!(reviewed.inverse, Some(true));
}

#[test]
fn self_relation_never_pairs_a_field_with_itself() {
    let source = "Table Category { id Int @id parentId Int? parent Category? @relation(fields: [parentId], references: [id]) }";
    let schema = parse_source(source).unwrap();
    let resolved = resolve::resolve(&schema);
    let parent = find_relation(&resolved, "Category", "parent");
    assert_eq!(parent.inverse, None, "a lone FK leg with no counterpart must never be flagged inverse");
    assert_eq!(parent.fk_columns, vec!["parentId".to_string()]);
}

// ─── Phase 4: ambiguous relation pairing is a validation error ──────────────

#[test]
fn two_unnamed_relations_to_the_same_target_are_ambiguous() {
    let errors = validate_src(
        "Table User { id Int @id posts Post[] } \
         Table Post { id Int @id authorId Int reviewerId Int \
         author User @relation(fields: [authorId], references: [id]) \
         reviewer User @relation(fields: [reviewerId], references: [id]) }",
    );
    assert!(
        errors
            .iter()
            .any(|e| e.message.contains("Ambiguous relation") && e.message.contains("Post") && e.message.contains("User")),
        "expected an ambiguity diagnostic naming Post and User, got: {errors:?}"
    );
}

#[test]
fn naming_only_one_side_does_not_resolve_ambiguity() {
    let errors = validate_src(
        "Table User { id Int @id posts Post[] } \
         Table Post { id Int @id authorId Int reviewerId Int \
         author User @relation(\"PostAuthor\", fields: [authorId], references: [id]) \
         reviewer User @relation(fields: [reviewerId], references: [id]) }",
    );
    assert!(
        errors
            .iter()
            .any(|e| e.message.contains("Ambiguous relation") && e.message.contains("Post") && e.message.contains("User")),
        "expected the unnamed relation to still be reported as ambiguous, got: {errors:?}"
    );
}

#[test]
fn named_relation_with_no_counterpart_is_reported() {
    let errors = validate_src(
        "Table User { id Int @id } \
         Table Post { id Int @id authorId Int \
         author User @relation(\"PostAuthor\", fields: [authorId], references: [id]) }",
    );
    assert!(
        errors.iter().any(|e| e.message.contains("PostAuthor") && e.message.contains("Post") && e.message.contains("User")),
        "expected a diagnostic naming the unresolved relation name and both models, got: {errors:?}"
    );
    assert!(
        errors.iter().all(|e| !e.message.contains("Ambiguous relation")),
        "must not report general ambiguity for a single named relation with no siblings, got: {errors:?}"
    );
}

#[test]
fn ambiguity_diagnostic_is_deduplicated_per_pair() {
    let errors = validate_src(
        "Table User { id Int @id posts Post[] } \
         Table Post { id Int @id a1 Int a2 Int a3 Int \
         author1 User @relation(fields: [a1], references: [id]) \
         author2 User @relation(fields: [a2], references: [id]) \
         author3 User @relation(fields: [a3], references: [id]) }",
    );
    let ambiguous: Vec<_> = errors.iter().filter(|e| e.message.contains("Ambiguous relation")).collect();
    assert_eq!(ambiguous.len(), 1, "expected exactly one ambiguity diagnostic even with 3 conflicting relations, got: {errors:?}");
    assert!(ambiguous[0].message.contains("Post") && ambiguous[0].message.contains("User"));
}

// ─── Phase 5: dedicated fixtures for relation naming/ambiguity ──────────────

#[test]
fn fixture_12_relation_naming_has_zero_validation_errors() {
    let source = fs::read_to_string(fixtures_dir().join("12-relation-naming.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    assert!(errors.is_empty(), "expected zero validation errors, got: {errors:?}");
}

#[test]
fn fixture_13_ambiguous_relations_reports_both_ambiguity_and_unresolved_name() {
    let source = fs::read_to_string(fixtures_dir().join("13-ambiguous-relations.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);

    // All-unnamed pair: Post.author + Post.reviewer vs. User.posts.
    assert!(
        errors.iter().any(|e| e.message.contains("Ambiguous relation") && e.message.contains("Post") && e.message.contains("User")),
        "expected an ambiguity diagnostic for Post/User, got: {errors:?}"
    );
    // Partially-named pair: Comment.author ("CommentAuthor", no counterpart) +
    // Comment.editor vs. User.comments.
    assert!(
        errors.iter().any(|e| e.message.contains("Ambiguous relation") && e.message.contains("Comment") && e.message.contains("User")),
        "expected an ambiguity diagnostic for Comment/User, got: {errors:?}"
    );
    assert!(
        errors.iter().any(|e| e.message.contains("CommentAuthor")),
        "expected the unresolved-name diagnostic for Comment.author, got: {errors:?}"
    );
}

#[test]
fn fixture_08_self_relation_is_unaffected() {
    let source = fs::read_to_string(fixtures_dir().join("08-self-relation.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    assert!(errors.is_empty(), "08-self-relation.indigo must stay unaffected by relation pairing, got: {errors:?}");
}

// ─── Named/typed indexes (PR A): dedicated fixtures ──────────────────────────

#[test]
fn fixture_16_named_typed_indexes_has_zero_validation_errors() {
    let source = fs::read_to_string(fixtures_dir().join("16-named-typed-indexes.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    assert!(errors.is_empty(), "expected zero validation errors, got: {errors:?}");
}

#[test]
fn fixture_16_ir_is_populated_in_pr_b() {
    // PR B: `resolve.rs` now populates `ResolvedIndex.name`/`.indexType` from
    // explicit `name:`/`type:` args; an omitted `name:` stays `None` and an
    // explicit `type: btree` canonicalizes to `None` (design decision #4).
    let source = fs::read_to_string(fixtures_dir().join("16-named-typed-indexes.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let resolved = resolve::resolve(&schema);
    let user_table = resolved.tables.iter().find(|t| t.name == "User").expect("User table");
    assert_eq!(user_table.indexes.len(), 5, "{:?}", user_table.indexes);

    let by_columns = |cols: &[&str]| {
        user_table
            .indexes
            .iter()
            .find(|i| i.columns == cols)
            .unwrap_or_else(|| panic!("no index over {cols:?} in {:?}", user_table.indexes))
    };

    let email = by_columns(&["email"]);
    assert_eq!(email.name.as_deref(), Some("user_email_idx"));
    assert_eq!(email.index_type, None);

    let tags = by_columns(&["tags"]);
    assert_eq!(tags.name, None);
    assert_eq!(tags.index_type, Some(ir::IndexMethod::Gin));

    // Two indexes cover `["bio"]` — the plain `@@index` and the `@@unique` —
    // so distinguish by `unique` too.
    let bio_index = user_table
        .indexes
        .iter()
        .find(|i| i.columns == ["bio"] && !i.unique)
        .expect("plain @@index([bio]) exists");
    assert_eq!(bio_index.name.as_deref(), Some("user_bio_gist_idx"));
    assert_eq!(bio_index.index_type, Some(ir::IndexMethod::Gist));

    let email_tags = by_columns(&["email", "tags"]);
    assert_eq!(email_tags.name.as_deref(), Some("user_email_tags_key"));
    assert_eq!(email_tags.index_type, None);
    assert!(email_tags.unique);

    let bio_unique = user_table
        .indexes
        .iter()
        .find(|i| i.columns == ["bio"] && i.unique)
        .expect("@@unique([bio], type: btree) exists");
    assert_eq!(bio_unique.name, None);
    assert_eq!(bio_unique.index_type, None, "explicit type: btree must canonicalize to None");
}

#[test]
fn fixture_17_rejected_index_args_reports_every_diagnostic_class() {
    let source = fs::read_to_string(fixtures_dir().join("17-rejected-index-args.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    let has = |model: &str, needle: &str| errors.iter().any(|e| e.model.as_deref() == Some(model) && e.message.contains(needle));

    assert!(has("UnknownType", "Allowed: btree, gin, gist, hash"), "{errors:?}");
    assert!(has("UnknownArg", "Known arguments: name, type"), "{errors:?}");
    assert!(has("TypeWrongKind", "index method identifier"), "{errors:?}");
    assert!(has("NameWrongKind", "string literal"), "{errors:?}");
    assert!(has("EmptyName", "1-63 characters"), "{errors:?}");
    assert!(has("DuplicateName", "Duplicate index name \"dup_idx\""), "{errors:?}");
    assert!(has("CollidesWithDerived", "collides with the name derived for another index"), "{errors:?}");
    assert!(has("CollidesWithUniqueField", "collides with the name derived for another index"), "{errors:?}");
    assert!(has("NameTooLong", "1-63 characters"), "{errors:?}");
    assert!(has("UniqueNonBtree", "require btree"), "{errors:?}");

    // Exactly one diagnostic per isolated table (no unexpected extras).
    for model in [
        "UnknownType",
        "UnknownArg",
        "TypeWrongKind",
        "NameWrongKind",
        "EmptyName",
        "NameTooLong",
        "UniqueNonBtree",
    ] {
        let count = errors.iter().filter(|e| e.model.as_deref() == Some(model)).count();
        assert_eq!(count, 1, "expected exactly one diagnostic for {model}, got: {errors:?}");
    }
}

// ─── `@@allow` (realtime-rls-allow-rule PR A): dedicated fixtures ────────────

#[test]
fn fixture_18_allow_rules_has_zero_validation_errors() {
    let source = fs::read_to_string(fixtures_dir().join("18-allow-rules.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    assert!(errors.is_empty(), "expected zero validation errors, got: {errors:?}");
}

#[test]
fn fixture_18_ir_is_populated_in_pr_b() {
    // PR B: `resolve.rs` now populates `ResolvedTable.allow` — alias
    // expansion (`write`/`all`), operand resolution to physical `dbName`,
    // declaration order preserved (design decisions #6/#7).
    let source = fs::read_to_string(fixtures_dir().join("18-allow-rules.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let resolved = resolve::resolve(&schema);
    let table = |name: &str| resolved.tables.iter().find(|t| t.name == name).unwrap();

    let post = table("Post");
    let allow = post.allow.as_ref().expect("Post has allow rules");
    assert_eq!(allow.len(), 1);
    assert_eq!(allow[0].action, ir::AllowAction::Read);
    assert_eq!(allow[0].left, ir::AllowOperand::Claim { name: "userId".into() });
    assert_eq!(allow[0].right, ir::AllowOperand::Field { name: "ownerId".into() });

    let comment = table("Comment");
    let allow = comment.allow.as_ref().expect("Comment has allow rules");
    let actions: Vec<ir::AllowAction> = allow.iter().map(|r| r.action).collect();
    assert_eq!(actions, vec![ir::AllowAction::Create, ir::AllowAction::Update]);

    let attachment = table("Attachment");
    let allow = attachment.allow.as_ref().expect("Attachment has allow rules");
    // `write` -> create, update, delete; `all` -> create, read, update, delete.
    let actions: Vec<ir::AllowAction> = allow.iter().map(|r| r.action).collect();
    assert_eq!(
        actions,
        vec![
            ir::AllowAction::Create,
            ir::AllowAction::Update,
            ir::AllowAction::Delete,
            ir::AllowAction::Create,
            ir::AllowAction::Read,
            ir::AllowAction::Update,
            ir::AllowAction::Delete,
        ]
    );

    let article = table("Article");
    let allow = article.allow.as_ref().expect("Article has allow rules");
    assert_eq!(allow.len(), 2);
    assert_eq!(allow[0].action, ir::AllowAction::Read);
    assert_eq!(allow[0].right, ir::AllowOperand::Field { name: "ownerId".into() });
    assert_eq!(allow[1].action, ir::AllowAction::Read);
    assert_eq!(allow[1].left, ir::AllowOperand::Field { name: "isPublic".into() });
    assert_eq!(allow[1].right, ir::AllowOperand::Boolean { value: true });

    // A `String` owner key resolves the same operand shape — cast derivation
    // from the field's scalar type is a PR C / migrator concern, not IR shape.
    let doc = table("Doc");
    let allow = doc.allow.as_ref().expect("Doc has allow rules");
    assert_eq!(allow[0].right, ir::AllowOperand::Field { name: "ownerId".into() });
}

#[test]
fn fixture_18_realtime_and_allow_co_occur_on_one_resolved_table() {
    // `realtime-live-endpoint` PR B: `realtime: true` and `allow: [...]` now
    // co-occur on a single `ResolvedTable` — the compiler guard that used to
    // reject this combination is lifted. Snapshot-covered on the accept
    // path, not just "no longer rejected" (see fixtures.rs's fixture 19
    // test for the rejection-side counterpart).
    let source = fs::read_to_string(fixtures_dir().join("18-allow-rules.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let resolved = resolve::resolve(&schema);
    let table = resolved.tables.iter().find(|t| t.name == "RealtimeAllowed").unwrap();

    assert_eq!(table.realtime, Some(true), "RealtimeAllowed must resolve with realtime: true");
    let allow = table.allow.as_ref().expect("RealtimeAllowed has allow rules");
    assert_eq!(allow.len(), 1);
    assert_eq!(allow[0].action, ir::AllowAction::Read);
}

#[test]
fn fixture_19_rejected_allow_reports_every_diagnostic_class() {
    let source = fs::read_to_string(fixtures_dir().join("19-rejected-allow.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    let has = |model: &str, needle: &str| errors.iter().any(|e| e.model.as_deref() == Some(model) && e.message.contains(needle));

    assert!(has("WrongArity", "requires an action and a single equality condition"), "{errors:?}");
    assert!(has("UnknownAction", "Invalid @@allow action \"select\""), "{errors:?}");
    assert!(has("UnknownClaim", "\"auth.role\""), "{errors:?}");
    assert!(has("BadPathRoot", "Invalid path \"post.ownerId\""), "{errors:?}");
    assert!(has("UnknownField", "unknown or non-scalar field \"owner\""), "{errors:?}");
    assert!(has("ClaimVsLiteral", "must be compared against a this.<field> reference"), "{errors:?}");
    assert!(has("ConstantPredicate", "references neither a field nor auth.userId"), "{errors:?}");
    assert!(has("PolicyNameTooLong", "exceeds 63 bytes"), "{errors:?}");
    assert!(has("NamedArgsRejected", "\"name\""), "{errors:?}");

    // `RealtimeAndAllow` no longer produces a diagnostic here
    // (realtime-live-endpoint PR B lifted the @@realtime+@@allow guard) —
    // see `fixture_19_realtime_and_allow_is_no_longer_rejected` below.
    assert!(
        !errors.iter().any(|e| e.model.as_deref() == Some("RealtimeAndAllow")),
        "RealtimeAndAllow must produce zero diagnostics now that the guard is lifted: {errors:?}"
    );

    // Exactly one diagnostic per isolated table (no unexpected extras).
    for model in [
        "WrongArity",
        "UnknownAction",
        "UnknownClaim",
        "BadPathRoot",
        "UnknownField",
        "ClaimVsLiteral",
        "ConstantPredicate",
        "PolicyNameTooLong",
        "NamedArgsRejected",
    ] {
        let count = errors.iter().filter(|e| e.model.as_deref() == Some(model)).count();
        assert_eq!(count, 1, "expected exactly one diagnostic for {model}, got: {errors:?}");
    }
}

// ─── `@@realtime(columns:…)` (realtime-column-projection PR 1): dedicated fixtures ───

#[test]
fn fixture_20_realtime_columns_has_zero_validation_errors() {
    let source = fs::read_to_string(fixtures_dir().join("20-realtime-columns.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    assert!(errors.is_empty(), "expected zero validation errors, got: {errors:?}");
}

#[test]
fn fixture_20_ir_resolves_realtime_columns() {
    let source = fs::read_to_string(fixtures_dir().join("20-realtime-columns.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let resolved = resolve::resolve(&schema);
    let table = |name: &str| resolved.tables.iter().find(|t| t.name == name).unwrap();

    // RCP-1: bare `@@realtime` carries no `realtimeColumns` allowlist at all.
    let bare = table("BareRealtime");
    assert_eq!(bare.realtime, Some(true));
    assert!(bare.realtime_columns.is_none());

    // RCP-2/RCP-4/DX-2: listed columns resolve to physical dbNames, in
    // declaration order; `email`'s `@map` is honored; `passwordHash` (not
    // listed) is excluded.
    let projected = table("ProjectedUser");
    assert_eq!(
        projected.realtime_columns.as_deref(),
        Some(&["id".to_string(), "email_address".to_string()][..])
    );

    // RCP-7: `columns: []` resolves to `Some(vec![])`, never `None`.
    let identity_only = table("IdentityOnly");
    assert_eq!(identity_only.realtime_columns, Some(vec![]));
}

#[test]
fn fixture_21_rejected_realtime_columns_reports_every_diagnostic_class() {
    let source = fs::read_to_string(fixtures_dir().join("21-rejected-realtime-columns.indigo")).unwrap();
    let schema = parse_source(&source).unwrap();
    let errors = validate::validate(&schema);
    let has = |model: &str, needle: &str| errors.iter().any(|e| e.model.as_deref() == Some(model) && e.message.contains(needle));

    assert!(has("UnknownColumn", "unknown or non-scalar field \"ghostField\""), "{errors:?}");
    assert!(has("DuplicateColumn", "Duplicate column \"id\""), "{errors:?}");
    assert!(has("UnknownRealtimeArg", "accepts only a \"columns:\" argument"), "{errors:?}");
    assert!(has("ColumnsOnIndex", "columns"), "{errors:?}");
}

#[test]
fn corpus_fixtures_01_through_19_are_unaffected_by_realtime_columns() {
    // Regression: RCP-1 — adding `@@realtime(columns:…)`'s grammar/
    // validation must not change diagnostic behavior for any pre-existing
    // fixture (design's "01-19 must show no diff" via the golden snapshots;
    // this crate-level test only guards against a new panic/regression).
    let dir = fixtures_dir();
    for n in 1..=19u8 {
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().extension().is_some_and(|x| x == "indigo")
                    && e.file_name().to_string_lossy().starts_with(&format!("{n:02}-"))
            })
            .collect();
        for entry in entries {
            let source = fs::read_to_string(entry.path()).unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            match parse_source(&source) {
                Ok(schema) => {
                    let _ = validate::validate(&schema);
                }
                Err(errors) => {
                    assert!(!errors.is_empty(), "{name}: unexpected empty error list");
                }
            }
        }
    }
}

#[test]
fn corpus_fixtures_01_through_17_are_unaffected_by_allow() {
    // Regression: adding `@@allow`'s grammar/validation must not change the
    // diagnostic count for any pre-existing fixture (design's "01-17 must
    // show no diff").
    let dir = fixtures_dir();
    for n in 1..=17u8 {
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().extension().is_some_and(|x| x == "indigo")
                    && e.file_name().to_string_lossy().starts_with(&format!("{n:02}-"))
            })
            .collect();
        for entry in entries {
            let source = fs::read_to_string(entry.path()).unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            match parse_source(&source) {
                Ok(schema) => {
                    // No panic, and validate() runs cleanly (may still
                    // report its own pre-existing diagnostics — this test
                    // only guards against a NEW panic/regression from the
                    // @@allow addition, not against the exact count, which
                    // the parity harness's golden snapshots already pin).
                    let _ = validate::validate(&schema);
                }
                Err(errors) => {
                    assert!(!errors.is_empty(), "{name}: unexpected empty error list");
                }
            }
        }
    }
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
