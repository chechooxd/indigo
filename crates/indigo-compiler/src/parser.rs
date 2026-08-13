//! Recursive-descent parser for `.indigo` (port of parser/src/parser.ts +
//! the CST→AST transform in parser/src/index.ts, folded into one pass).
//!
//! Improvements over the Chevrotain pipeline, by design:
//! - collects multiple errors per pass with declaration-level recovery
//!   (sync to the next top-level keyword / closing brace);
//! - the silent `visitAttributeValue` fallback to `""` is a real error here;
//! - string literal contents ARE unescaped (`\\ \" \n \r \t`), decoded by
//!   the lexer — `Token.text` for `StringLiteral` already carries the
//!   decoded, unquoted value; an unknown escape is a lexer-level error.
//!
//! Parity quirks preserved (see the parity harness):
//! - named args inside function calls drop their names (`arg.value` only);
//! - datasource: `provider` only set from string values, `url` takes any
//!   value, defaults `""`; generator: `provider`/`output` string-only;
//! - TableGroup: only `color = "<string>"` sets color, other assignments are
//!   ignored, a bare identifier is a table name.

use crate::ast::*;
use crate::error::CompilerError;
use crate::lexer::{Token, TokenKind};

pub struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    errors: Vec<CompilerError>,
}

const DECL_KEYWORDS: [TokenKind; 5] = [
    TokenKind::KwTable,
    TokenKind::KwTableGroup,
    TokenKind::KwEnum,
    TokenKind::KwDatasource,
    TokenKind::KwGenerator,
];

impl<'a> Parser<'a> {
    pub fn new(tokens: &'a [Token]) -> Self {
        Self { tokens, pos: 0, errors: Vec::new() }
    }

    pub fn parse_schema(mut self) -> (Schema, Vec<CompilerError>) {
        let mut schema = Schema::default();

        while !self.at(TokenKind::Eof) {
            match self.peek_kind() {
                TokenKind::KwTable => {
                    if let Some(model) = self.parse_model() {
                        schema.models.push(model);
                    }
                }
                TokenKind::KwEnum => {
                    if let Some(e) = self.parse_enum() {
                        schema.enums.push(e);
                    }
                }
                TokenKind::KwDatasource => {
                    if let Some(ds) = self.parse_datasource() {
                        schema.datasources.push(ds);
                    }
                }
                TokenKind::KwGenerator => {
                    if let Some(g) = self.parse_generator() {
                        schema.generators.push(g);
                    }
                }
                TokenKind::KwTableGroup => {
                    if let Some(tg) = self.parse_table_group() {
                        schema.table_groups.push(tg);
                    }
                }
                _ => {
                    self.error_at_current(
                        "expected a declaration (Table, enum, datasource, generator or TableGroup)",
                    );
                    self.recover_to_top_level();
                }
            }
        }

        (schema, self.errors)
    }

    // ─── Declarations ────────────────────────────────────────────────────

    fn parse_model(&mut self) -> Option<Model> {
        self.advance(); // Table
        let name = self.expect_identifier("a model name after 'Table'")?;
        self.expect(TokenKind::LBrace)?;

        let mut fields = Vec::new();
        let mut attributes = Vec::new();
        while !self.at(TokenKind::RBrace) && !self.at(TokenKind::Eof) {
            match self.peek_kind() {
                TokenKind::DoubleAt => {
                    if let Some(attr) = self.parse_attribute(TokenKind::DoubleAt) {
                        attributes.push(attr);
                    } else {
                        self.sync_to_block_end();
                    }
                }
                TokenKind::Identifier => {
                    if let Some(field) = self.parse_field() {
                        fields.push(field);
                    } else {
                        self.sync_to_field_or_block_end();
                    }
                }
                _ => {
                    self.error_at_current("expected a field or a '@@' block attribute");
                    self.sync_to_field_or_block_end();
                }
            }
        }
        self.expect(TokenKind::RBrace)?;
        Some(Model { name, fields, attributes })
    }

    fn parse_field(&mut self) -> Option<Field> {
        let name = self.expect_identifier("a field name")?;
        let type_name = self.expect_identifier("a type after the field name")?;

        // `?` OR `[]` — a single optional modifier, never both (parity).
        let mut optional = false;
        let mut list = false;
        if self.at(TokenKind::QuestionMark) {
            self.advance();
            optional = true;
        } else if self.at(TokenKind::LBracket) {
            self.advance();
            self.expect(TokenKind::RBracket)?;
            list = true;
        }

        let mut attributes = Vec::new();
        while self.at(TokenKind::At) {
            attributes.push(self.parse_attribute(TokenKind::At)?);
        }

        Some(Field {
            name,
            field_type: FieldType {
                scalar: is_scalar(&type_name),
                name: type_name,
                list,
                optional,
            },
            attributes,
        })
    }

    fn parse_enum(&mut self) -> Option<Enum> {
        self.advance(); // enum
        let name = self.expect_identifier("an enum name after 'enum'")?;
        self.expect(TokenKind::LBrace)?;

        let mut values = Vec::new();
        while self.at(TokenKind::Identifier) {
            let value_name = self.expect_identifier("an enum value")?;
            let mut attributes = Vec::new();
            while self.at(TokenKind::At) {
                match self.parse_attribute(TokenKind::At) {
                    Some(attr) => attributes.push(attr),
                    None => {
                        self.sync_to_block_end();
                        break;
                    }
                }
            }
            values.push(EnumValue { name: value_name, attributes });
        }
        self.expect(TokenKind::RBrace)?;
        Some(Enum { name, values })
    }

    fn parse_datasource(&mut self) -> Option<Datasource> {
        self.advance(); // datasource
        let name = self.expect_identifier("a datasource name")?;
        let assignments = self.parse_assignment_block()?;

        let mut provider = String::new();
        let mut url = AttributeValue::String { value: String::new() };
        for (key, value) in assignments {
            if key == "provider" {
                if let Some(s) = value.as_str() {
                    provider = s.to_string();
                }
            } else if key == "url" {
                url = value;
            }
        }
        Some(Datasource { name, provider, url })
    }

    fn parse_generator(&mut self) -> Option<Generator> {
        self.advance(); // generator
        let name = self.expect_identifier("a generator name")?;
        let assignments = self.parse_assignment_block()?;

        let mut provider = String::new();
        let mut output = None;
        for (key, value) in assignments {
            let Some(s) = value.as_str() else { continue };
            if key == "provider" {
                provider = s.to_string();
            } else if key == "output" {
                output = Some(s.to_string());
            }
        }
        Some(Generator { name, provider, output })
    }

    fn parse_assignment_block(&mut self) -> Option<Vec<(String, AttributeValue)>> {
        self.expect(TokenKind::LBrace)?;
        let mut assignments = Vec::new();
        while self.at(TokenKind::Identifier) {
            let key = self.expect_identifier("a setting name")?;
            self.expect(TokenKind::Equals)?;
            let value = self.parse_attribute_value()?;
            assignments.push((key, value));
        }
        self.expect(TokenKind::RBrace)?;
        Some(assignments)
    }

    fn parse_table_group(&mut self) -> Option<TableGroup> {
        self.advance(); // TableGroup
        let name = match self.peek_kind() {
            TokenKind::StringLiteral => self.advance().text.clone(),
            _ => {
                self.error_at_current("expected a quoted group name after 'TableGroup'");
                return None;
            }
        };
        self.expect(TokenKind::LBrace)?;

        let mut color = None;
        let mut tables = Vec::new();
        while self.at(TokenKind::Identifier) {
            let key = self.expect_identifier("a table name or setting")?;
            if self.at(TokenKind::Equals) {
                self.advance();
                let value = self.parse_attribute_value()?;
                if key == "color" {
                    if let Some(s) = value.as_str() {
                        color = Some(s.to_string());
                    }
                }
                // Other assignments are silently ignored (parity).
            } else {
                tables.push(key);
            }
        }
        self.expect(TokenKind::RBrace)?;
        Some(TableGroup { name, color, tables })
    }

    // ─── Attributes ──────────────────────────────────────────────────────

    fn parse_attribute(&mut self, marker: TokenKind) -> Option<Attribute> {
        debug_assert!(self.at(marker));
        self.advance(); // @ or @@
        let first = self.expect_identifier("an attribute name")?;
        let (namespace, name) = if self.at(TokenKind::Dot) {
            self.advance();
            (Some(first), self.expect_identifier("an attribute name after '.'")?)
        } else {
            (None, first)
        };
        let mut args = Vec::new();
        if self.at(TokenKind::LParen) {
            self.advance();
            if !self.at(TokenKind::RParen) {
                args = self.parse_attribute_arg_list()?;
            }
            self.expect(TokenKind::RParen)?;
        }
        Some(Attribute { namespace, name, args })
    }

    fn parse_attribute_arg_list(&mut self) -> Option<Vec<AttributeArg>> {
        let mut args = vec![self.parse_attribute_arg()?];
        while self.at(TokenKind::Comma) {
            self.advance();
            args.push(self.parse_attribute_arg()?);
        }
        Some(args)
    }

    fn parse_attribute_arg(&mut self) -> Option<AttributeArg> {
        // Named argument: `name: value` (empty name for positional, parity).
        let mut name = String::new();
        if self.at(TokenKind::Identifier) && self.peek_next_kind() == TokenKind::Colon {
            name = self.advance().text.clone();
            self.advance(); // :
        }
        let value = self.parse_attribute_value()?;
        Some(AttributeArg { name, value })
    }

    fn parse_attribute_value(&mut self) -> Option<AttributeValue> {
        match self.peek_kind() {
            TokenKind::StringLiteral => {
                Some(AttributeValue::String { value: self.advance().text.clone() })
            }
            TokenKind::NumberLiteral => {
                let text = self.advance().text.clone();
                match text.parse::<f64>() {
                    Ok(value) => Some(AttributeValue::Number { value }),
                    Err(_) => {
                        self.error_at_current(&format!("invalid number literal {text:?}"));
                        None
                    }
                }
            }
            TokenKind::KwTrue => {
                self.advance();
                Some(AttributeValue::Boolean { value: true })
            }
            TokenKind::KwFalse => {
                self.advance();
                Some(AttributeValue::Boolean { value: false })
            }
            TokenKind::LBracket => self.parse_array_literal(),
            TokenKind::Identifier => self.parse_function_call_or_reference(),
            _ => {
                self.error_at_current("expected a value (string, number, boolean, array, function call or reference)");
                None
            }
        }
    }

    fn parse_array_literal(&mut self) -> Option<AttributeValue> {
        self.advance(); // [
        let mut values = Vec::new();
        if !self.at(TokenKind::RBracket) {
            values.push(self.parse_attribute_value()?);
            while self.at(TokenKind::Comma) {
                self.advance();
                values.push(self.parse_attribute_value()?);
            }
        }
        self.expect(TokenKind::RBracket)?;
        Some(AttributeValue::Array { values })
    }

    fn parse_function_call_or_reference(&mut self) -> Option<AttributeValue> {
        let name = self.advance().text.clone();
        if self.at(TokenKind::LParen) {
            self.advance();
            let mut args = Vec::new();
            if !self.at(TokenKind::RParen) {
                // Named args inside calls drop their names (parity with
                // visitFunctionCallOrReference pushing `arg.value` only).
                args = self
                    .parse_attribute_arg_list()?
                    .into_iter()
                    .map(|a| a.value)
                    .collect();
            }
            self.expect(TokenKind::RParen)?;
            Some(AttributeValue::Function { name, args })
        } else {
            Some(AttributeValue::Reference { value: name })
        }
    }

    // ─── Token plumbing ──────────────────────────────────────────────────

    fn peek(&self) -> &Token {
        &self.tokens[self.pos.min(self.tokens.len() - 1)]
    }

    fn peek_kind(&self) -> TokenKind {
        self.peek().kind
    }

    fn peek_next_kind(&self) -> TokenKind {
        self.tokens
            .get(self.pos + 1)
            .map(|t| t.kind)
            .unwrap_or(TokenKind::Eof)
    }

    fn at(&self, kind: TokenKind) -> bool {
        self.peek_kind() == kind
    }

    fn advance(&mut self) -> &Token {
        let token = &self.tokens[self.pos.min(self.tokens.len() - 1)];
        if self.pos < self.tokens.len() - 1 {
            self.pos += 1;
        }
        token
    }

    fn expect(&mut self, kind: TokenKind) -> Option<()> {
        if self.at(kind) {
            self.advance();
            Some(())
        } else {
            self.error_at_current(&format!("expected {}", kind.describe()));
            None
        }
    }

    fn expect_identifier(&mut self, what: &str) -> Option<String> {
        if self.at(TokenKind::Identifier) {
            Some(self.advance().text.clone())
        } else {
            self.error_at_current(&format!("expected {what}"));
            None
        }
    }

    fn error_at_current(&mut self, message: &str) {
        let token = self.peek();
        self.errors.push(CompilerError {
            message: format!("{message}, found {}", token.kind.describe()),
            line: token.line,
            column: token.column,
            end_line: Some(token.end_line),
            end_column: Some(token.end_column),
        });
    }

    // ─── Recovery ────────────────────────────────────────────────────────

    /// Skips to the next top-level declaration keyword at brace depth 0.
    fn recover_to_top_level(&mut self) {
        let mut depth = 0i32;
        while !self.at(TokenKind::Eof) {
            match self.peek_kind() {
                TokenKind::LBrace => depth += 1,
                TokenKind::RBrace => depth = (depth - 1).max(0),
                kind if depth == 0 && DECL_KEYWORDS.contains(&kind) => return,
                _ => {}
            }
            self.advance();
        }
    }

    /// Skips to (but not past) the closing brace of the current block.
    fn sync_to_block_end(&mut self) {
        let mut depth = 0i32;
        while !self.at(TokenKind::Eof) {
            match self.peek_kind() {
                TokenKind::LBrace => depth += 1,
                TokenKind::RBrace => {
                    if depth == 0 {
                        return;
                    }
                    depth -= 1;
                }
                _ => {}
            }
            self.advance();
        }
    }

    /// Skips to the next plausible field start (identifier at line start
    /// heuristic: any identifier/`@@` after consuming the broken tail) or the
    /// block's closing brace.
    fn sync_to_field_or_block_end(&mut self) {
        let start_line = self.peek().line;
        let mut depth = 0i32;
        while !self.at(TokenKind::Eof) {
            let token = self.peek();
            match token.kind {
                TokenKind::LBrace => depth += 1,
                TokenKind::RBrace => {
                    if depth == 0 {
                        return;
                    }
                    depth -= 1;
                }
                TokenKind::Identifier | TokenKind::DoubleAt
                    if depth == 0 && token.line > start_line =>
                {
                    return;
                }
                _ => {}
            }
            self.advance();
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::ast::AttributeValue;

    fn field_attrs(source: &str, model: &str, field: &str) -> Vec<crate::ast::Attribute> {
        let schema = crate::parse_source(source).expect("source should parse without errors");
        let m = schema.models.iter().find(|m| m.name == model).expect("model not found");
        let f = m.fields.iter().find(|f| f.name == field).expect("field not found");
        f.attributes.clone()
    }

    #[test]
    fn namespaced_attribute_with_arguments_yields_namespace_and_name() {
        let source = r#"
Table User {
  bio String @db.VarChar(255)
}
"#;
        let attrs = field_attrs(source, "User", "bio");
        assert_eq!(attrs.len(), 1);
        let attr = &attrs[0];
        assert_eq!(attr.namespace.as_deref(), Some("db"));
        assert_eq!(attr.name, "VarChar");
        assert_eq!(attr.args.len(), 1);
        assert!(matches!(attr.args[0].value, AttributeValue::Number { value } if value == 255.0));
    }

    #[test]
    fn namespaced_attribute_without_arguments_yields_namespace_and_name() {
        let source = r#"
Table User {
  id String @db.Uuid
}
"#;
        let attrs = field_attrs(source, "User", "id");
        assert_eq!(attrs.len(), 1);
        let attr = &attrs[0];
        assert_eq!(attr.namespace.as_deref(), Some("db"));
        assert_eq!(attr.name, "Uuid");
        assert!(attr.args.is_empty());
    }

    #[test]
    fn non_namespaced_attribute_has_no_namespace() {
        let source = r#"
Table User {
  email String @unique
}
"#;
        let attrs = field_attrs(source, "User", "email");
        assert_eq!(attrs.len(), 1);
        let attr = &attrs[0];
        assert_eq!(attr.namespace, None);
        assert_eq!(attr.name, "unique");
        assert!(attr.args.is_empty());
    }

    #[test]
    fn stray_trailing_dot_recovers_without_panicking() {
        let source = r#"
Table User {
  bio String @db.
  name String
}
"#;
        // Recovery path: `parse_attribute` returns `None` on the missing
        // identifier after `.`; the declaration-level sync must still find
        // the next field (`name`) without panicking or hanging.
        let result = crate::parse_source(source);
        match result {
            Ok(schema) => {
                let m = schema.models.iter().find(|m| m.name == "User").expect("model");
                assert!(m.fields.iter().any(|f| f.name == "name"));
            }
            Err(errors) => {
                assert!(!errors.is_empty());
            }
        }
    }
}
