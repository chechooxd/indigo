/**
 * @indigodb/parser
 *
 * Entry point for the IndigoDB schema parser.
 * Provides the `parse()` function that takes raw .indigo source text
 * and returns a fully-typed AST Schema object.
 */

import type {
  Schema,
  Model,
  Field,
  FieldType,
  Attribute,
  AttributeArg,
  AttributeValue,
  Enum,
  EnumValue,
  Datasource,
  Generator,
} from "@indigodb/ast";
import { SCALAR_TYPES } from "@indigodb/ast";
import { IndigoLexer } from "./lexer.js";
import { parserInstance } from "./parser.js";

// ─── Error Types ─────────────────────────────────────────────────────────────

export class IndigoParseError extends Error {
  constructor(
    message: string,
    public readonly errors: ParseErrorDetail[],
  ) {
    super(message);
    this.name = "IndigoParseError";
  }
}

export interface ParseErrorDetail {
  message: string;
  line?: number;
  column?: number;
}

// ─── Parse Function ──────────────────────────────────────────────────────────

/**
 * Parses an .indigo schema string into a typed AST.
 *
 * @param input - Raw .indigo schema source text.
 * @returns The parsed Schema AST.
 * @throws {IndigoParseError} If the input contains syntax errors.
 *
 * @example
 * ```ts
 * import { parse } from "@indigodb/parser";
 *
 * const schema = parse(`
 *   model User {
 *     id    Int    @id @default(autoincrement())
 *     email String @unique
 *     name  String?
 *   }
 * `);
 *
 * console.log(schema.models[0].name); // "User"
 * ```
 */
export function parse(input: string): Schema {
  // Step 1: Tokenize
  const lexResult = IndigoLexer.tokenize(input);

  if (lexResult.errors.length > 0) {
    throw new IndigoParseError(
      `Lexer errors found in .indigo schema`,
      lexResult.errors.map((e) => ({
        message: e.message,
        line: e.line,
        column: e.column,
      })),
    );
  }

  // Step 2: Parse tokens into CST
  parserInstance.input = lexResult.tokens;
  const cst = parserInstance.schema();

  if (parserInstance.errors.length > 0) {
    throw new IndigoParseError(
      `Parse errors found in .indigo schema`,
      parserInstance.errors.map((e) => ({
        message: e.message,
        line: e.token?.startLine,
        column: e.token?.startColumn,
      })),
    );
  }

  // Step 3: Transform CST → AST
  return cstToAst(cst);
}

// ─── CST → AST Transformer ──────────────────────────────────────────────────

/**
 * Transforms the Chevrotain CST into our typed AST.
 * This is a recursive descent over the CST nodes.
 *
 * TODO: Implement full CST visitor using chevrotain's CstVisitor base class
 * for more robust and maintainable transformations.
 */
function cstToAst(cst: any): Schema {
  const schema: Schema = {
    datasources: [],
    generators: [],
    models: [],
    enums: [],
  };

  if (!cst.children) return schema;

  // Process model declarations
  if (cst.children.modelDeclaration) {
    for (const modelCst of cst.children.modelDeclaration) {
      schema.models.push(visitModel(modelCst));
    }
  }

  // Process enum declarations
  if (cst.children.enumDeclaration) {
    for (const enumCst of cst.children.enumDeclaration) {
      schema.enums.push(visitEnum(enumCst));
    }
  }

  // Process datasource declarations
  if (cst.children.datasourceDeclaration) {
    for (const dsCst of cst.children.datasourceDeclaration) {
      schema.datasources.push(visitDatasource(dsCst));
    }
  }

  // Process generator declarations
  if (cst.children.generatorDeclaration) {
    for (const genCst of cst.children.generatorDeclaration) {
      schema.generators.push(visitGenerator(genCst));
    }
  }

  return schema;
}

function visitModel(cst: any): Model {
  const name = cst.children.Identifier[0].image;
  const fields: Field[] = [];
  const attributes: Attribute[] = [];

  if (cst.children.fieldDeclaration) {
    for (const fieldCst of cst.children.fieldDeclaration) {
      fields.push(visitField(fieldCst));
    }
  }

  if (cst.children.blockAttribute) {
    for (const attrCst of cst.children.blockAttribute) {
      attributes.push(visitBlockAttribute(attrCst));
    }
  }

  return { name, fields, attributes };
}

function visitField(cst: any): Field {
  const name = cst.children.Identifier[0].image;
  const type = visitTypeExpression(cst.children.typeExpression[0]);
  const attributes: Attribute[] = [];

  if (cst.children.fieldAttribute) {
    for (const attrCst of cst.children.fieldAttribute) {
      attributes.push(visitFieldAttribute(attrCst));
    }
  }

  return { name, type, attributes };
}

function visitTypeExpression(cst: any): FieldType {
  const typeName = cst.children.Identifier[0].image;
  const isOptional = !!cst.children.QuestionMark;
  const isList = !!cst.children.LBracket;

  return {
    name: typeName,
    scalar: SCALAR_TYPES.has(typeName),
    list: isList,
    optional: isOptional,
  };
}

function visitFieldAttribute(cst: any): Attribute {
  const name = cst.children.Identifier[0].image;
  const args: AttributeArg[] = [];

  if (cst.children.attributeArgList) {
    args.push(...visitAttributeArgList(cst.children.attributeArgList[0]));
  }

  return { name, args };
}

function visitBlockAttribute(cst: any): Attribute {
  const name = cst.children.Identifier[0].image;
  const args: AttributeArg[] = [];

  if (cst.children.attributeArgList) {
    args.push(...visitAttributeArgList(cst.children.attributeArgList[0]));
  }

  return { name, args };
}

function visitAttributeArgList(cst: any): AttributeArg[] {
  const args: AttributeArg[] = [];

  if (cst.children.attributeArg) {
    for (const argCst of cst.children.attributeArg) {
      args.push(visitAttributeArg(argCst));
    }
  }

  return args;
}

function visitAttributeArg(cst: any): AttributeArg {
  let name = "";

  // Named argument: Identifier ':' value
  if (cst.children.Identifier && cst.children.Colon) {
    name = cst.children.Identifier[0].image;
  }

  const value = visitAttributeValue(cst.children.attributeValue[0]);

  return { name, value };
}

function visitAttributeValue(cst: any): AttributeValue {
  const children = cst.children;

  if (children.StringLiteral) {
    // Remove surrounding quotes
    const raw = children.StringLiteral[0].image;
    return { kind: "string", value: raw.slice(1, -1) };
  }

  if (children.NumberLiteral) {
    return { kind: "number", value: Number(children.NumberLiteral[0].image) };
  }

  if (children.TrueKeyword) {
    return { kind: "boolean", value: true };
  }

  if (children.FalseKeyword) {
    return { kind: "boolean", value: false };
  }

  if (children.arrayLiteral) {
    return visitArrayLiteral(children.arrayLiteral[0]);
  }

  if (children.functionCallOrReference) {
    return visitFunctionCallOrReference(children.functionCallOrReference[0]);
  }

  // Fallback — should not reach here
  return { kind: "string", value: "" };
}

function visitFunctionCallOrReference(cst: any): AttributeValue {
  const name = cst.children.Identifier[0].image;

  // If there are parentheses, it's a function call
  if (cst.children.LParen) {
    const args: AttributeValue[] = [];
    if (cst.children.attributeArgList) {
      const argList = visitAttributeArgList(cst.children.attributeArgList[0]);
      for (const arg of argList) {
        args.push(arg.value);
      }
    }
    return { kind: "function", name, args };
  }

  // Otherwise it's a reference
  return { kind: "reference", value: name };
}

function visitArrayLiteral(cst: any): AttributeValue {
  const values: AttributeValue[] = [];

  if (cst.children.attributeValue) {
    for (const valCst of cst.children.attributeValue) {
      values.push(visitAttributeValue(valCst));
    }
  }

  return { kind: "array", values };
}

function visitEnum(cst: any): Enum {
  const name = cst.children.Identifier[0].image;
  const values: EnumValue[] = [];

  if (cst.children.enumValueDeclaration) {
    for (const valCst of cst.children.enumValueDeclaration) {
      const valName = valCst.children.Identifier[0].image;
      const attrs: Attribute[] = [];

      if (valCst.children.fieldAttribute) {
        for (const attrCst of valCst.children.fieldAttribute) {
          attrs.push(visitFieldAttribute(attrCst));
        }
      }

      values.push({ name: valName, attributes: attrs });
    }
  }

  return { name, values };
}

function visitDatasource(cst: any): Datasource {
  const name = cst.children.Identifier[0].image;
  let provider = "";
  let url: AttributeValue = { kind: "string", value: "" };

  if (cst.children.assignment) {
    for (const assignCst of cst.children.assignment) {
      const key = assignCst.children.Identifier[0].image;
      const value = visitAttributeValue(assignCst.children.attributeValue[0]);

      if (key === "provider" && value.kind === "string") {
        provider = value.value;
      } else if (key === "url") {
        url = value;
      }
    }
  }

  return { name, provider, url };
}

function visitGenerator(cst: any): Generator {
  const name = cst.children.Identifier[0].image;
  let provider = "";
  let output: string | undefined;

  if (cst.children.assignment) {
    for (const assignCst of cst.children.assignment) {
      const key = assignCst.children.Identifier[0].image;
      const value = visitAttributeValue(assignCst.children.attributeValue[0]);

      if (key === "provider" && value.kind === "string") {
        provider = value.value;
      } else if (key === "output" && value.kind === "string") {
        output = value.value;
      }
    }
  }

  return { name, provider, output };
}

// Re-export AST types for convenience
export type { Schema } from "@indigodb/ast";
