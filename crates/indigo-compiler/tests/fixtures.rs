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
fn quirk_strings_are_not_unescaped() {
    let schema = parse_source(r#"Table T { f String @note("say \"hi\"") }"#).unwrap();
    let json = serde_json::to_string(&schema).unwrap();
    // The raw backslashes survive (TS does slice(1, -1) verbatim).
    assert!(json.contains(r#"say \\\"hi\\\""#), "got: {json}");
}
