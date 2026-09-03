//! Task 1.3 / 1.9: the non-ASCII fixture is the negative control that
//! proves `SourceSpan` offsets are UTF-16 code units, not raw UTF-8 byte
//! offsets — a byte-offset span for `title` would be shifted by the one
//! extra byte `é` contributes in `@note("café")` on the line above it.

use std::fs;
use std::path::Path;

use indigo_compiler::parse_source_with_spans;

fn fixture_source() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/22-non-ascii.indigo");
    fs::read_to_string(path).unwrap()
}

#[test]
fn utf16_span_slices_exactly_the_title_field_declaration() {
    let source = fixture_source();
    let (_schema, spans) = parse_source_with_spans(&source).expect("fixture should parse");

    let post = spans.models.iter().find(|m| m.name == "Post").expect("Post model span");
    let title = post.fields.iter().find(|f| f.name == "title").expect("title field span");

    // Simulate JavaScript's `currentText.slice(start, end)`, which slices in
    // UTF-16 code units.
    let utf16: Vec<u16> = source.encode_utf16().collect();
    let sliced =
        String::from_utf16(&utf16[title.decl.start as usize..title.decl.end as usize]).unwrap();
    assert_eq!(sliced, "title String");
}

#[test]
fn utf16_offset_differs_from_the_raw_byte_offset() {
    // The byte-offset (what a byte-offset-based span, i.e. the bug this
    // fixture guards against, would report) and the UTF-16 offset diverge
    // by exactly one code unit here, because `é` is 2 UTF-8 bytes but 1
    // UTF-16 code unit.
    let source = fixture_source();
    let (_schema, spans) = parse_source_with_spans(&source).expect("fixture should parse");

    let post = spans.models.iter().find(|m| m.name == "Post").expect("Post model span");
    let title = post.fields.iter().find(|f| f.name == "title").expect("title field span");

    let byte_offset = source.find("title String").unwrap();
    assert_ne!(
        title.decl.start as usize, byte_offset,
        "UTF-16 offset must diverge from the raw byte offset on this fixture"
    );

    // A byte-offset span used against the UTF-16 buffer is simply wrong: it
    // either slices out-of-range garbage (as here — the byte offset can
    // exceed the shorter UTF-16 length once a multibyte char is involved)
    // or, on other fixtures, silently yields the wrong text. Either way it
    // must NOT equal the target text.
    let utf16: Vec<u16> = source.encode_utf16().collect();
    let wrong_end = byte_offset + "title String".len();
    let wrong_sliced = utf16
        .get(byte_offset..wrong_end)
        .and_then(|units| String::from_utf16(units).ok());
    assert_ne!(wrong_sliced.as_deref(), Some("title String"));
}
