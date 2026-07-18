/**
 * @indigodb/parser — CST Parser
 *
 * Chevrotain CstParser defining the grammar rules for the .indigo schema language.
 * Produces a Concrete Syntax Tree (CST) that is then transformed into an AST.
 */

import { CstParser } from "chevrotain";
import {
  allTokens,
  ModelKeyword,
  EnumKeyword,
  DatasourceKeyword,
  GeneratorKeyword,
  TrueKeyword,
  FalseKeyword,
  Identifier,
  StringLiteral,
  NumberLiteral,
  DoubleAt,
  At,
  LCurly,
  RCurly,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  QuestionMark,
  Equals,
  Colon,
} from "./lexer.js";

export class IndigoParser extends CstParser {
  constructor() {
    super(allTokens, {
      recoveryEnabled: true,
      maxLookahead: 3,
    });
    this.performSelfAnalysis();
  }

  // ─── Root Rule ───────────────────────────────────────────────────────

  /** schema: (modelDecl | enumDecl | datasourceDecl | generatorDecl)* */
  public schema = this.RULE("schema", () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.modelDeclaration) },
        { ALT: () => this.SUBRULE(this.enumDeclaration) },
        { ALT: () => this.SUBRULE(this.datasourceDeclaration) },
        { ALT: () => this.SUBRULE(this.generatorDeclaration) },
      ]);
    });
  });

  // ─── Model ──────────────────────────────────────────────────────────

  /** modelDeclaration: 'Table' Identifier '{' (fieldDecl | blockAttribute)* '}' */
  public modelDeclaration = this.RULE("modelDeclaration", () => {
    this.CONSUME(ModelKeyword);
    this.CONSUME(Identifier);
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.blockAttribute) },
        { ALT: () => this.SUBRULE(this.fieldDeclaration) },
      ]);
    });
    this.CONSUME(RCurly);
  });

  // ─── Enum ───────────────────────────────────────────────────────────

  /** enumDeclaration: 'enum' Identifier '{' enumValue* '}' */
  public enumDeclaration = this.RULE("enumDeclaration", () => {
    this.CONSUME(EnumKeyword);
    this.CONSUME(Identifier);
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.SUBRULE(this.enumValueDeclaration);
    });
    this.CONSUME(RCurly);
  });

  /** enumValueDeclaration: Identifier fieldAttribute* */
  public enumValueDeclaration = this.RULE("enumValueDeclaration", () => {
    this.CONSUME(Identifier);
    this.MANY(() => {
      this.SUBRULE(this.fieldAttribute);
    });
  });

  // ─── Datasource ─────────────────────────────────────────────────────

  /** datasourceDeclaration: 'datasource' Identifier '{' assignment* '}' */
  public datasourceDeclaration = this.RULE("datasourceDeclaration", () => {
    this.CONSUME(DatasourceKeyword);
    this.CONSUME(Identifier);
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.SUBRULE(this.assignment);
    });
    this.CONSUME(RCurly);
  });

  // ─── Generator ──────────────────────────────────────────────────────

  /** generatorDeclaration: 'generator' Identifier '{' assignment* '}' */
  public generatorDeclaration = this.RULE("generatorDeclaration", () => {
    this.CONSUME(GeneratorKeyword);
    this.CONSUME(Identifier);
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.SUBRULE(this.assignment);
    });
    this.CONSUME(RCurly);
  });

  // ─── Field ──────────────────────────────────────────────────────────

  /** fieldDeclaration: Identifier typeExpression fieldAttribute* */
  public fieldDeclaration = this.RULE("fieldDeclaration", () => {
    this.CONSUME(Identifier);
    this.SUBRULE(this.typeExpression);
    this.MANY(() => {
      this.SUBRULE(this.fieldAttribute);
    });
  });

  /** typeExpression: Identifier ('?' | '[]')? */
  public typeExpression = this.RULE("typeExpression", () => {
    this.CONSUME(Identifier);
    this.OPTION(() => {
      this.OR([
        { ALT: () => this.CONSUME(QuestionMark) },
        {
          ALT: () => {
            this.CONSUME(LBracket);
            this.CONSUME(RBracket);
          },
        },
      ]);
    });
  });

  // ─── Attributes ─────────────────────────────────────────────────────

  /** fieldAttribute: '@' Identifier ('(' attributeArgList ')')? */
  public fieldAttribute = this.RULE("fieldAttribute", () => {
    this.CONSUME(At);
    this.CONSUME(Identifier);
    this.OPTION(() => {
      this.CONSUME(LParen);
      this.SUBRULE(this.attributeArgList);
      this.CONSUME(RParen);
    });
  });

  /** blockAttribute: '@@' Identifier ('(' attributeArgList ')')? */
  public blockAttribute = this.RULE("blockAttribute", () => {
    this.CONSUME(DoubleAt);
    this.CONSUME(Identifier);
    this.OPTION(() => {
      this.CONSUME(LParen);
      this.SUBRULE(this.attributeArgList);
      this.CONSUME(RParen);
    });
  });

  /** attributeArgList: attributeArg (',' attributeArg)* */
  public attributeArgList = this.RULE("attributeArgList", () => {
    this.SUBRULE(this.attributeArg);
    this.MANY(() => {
      this.CONSUME(Comma);
      this.SUBRULE2(this.attributeArg);
    });
  });

  /** attributeArg: (Identifier ':')? attributeValue */
  public attributeArg = this.RULE("attributeArg", () => {
    this.OPTION(() => {
      this.CONSUME(Identifier);
      this.CONSUME(Colon);
    });
    this.SUBRULE(this.attributeValue);
  });

  /** attributeValue: StringLiteral | NumberLiteral | 'true' | 'false' | functionCall | arrayLiteral | Identifier */
  public attributeValue = this.RULE("attributeValue", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral) },
      { ALT: () => this.CONSUME(NumberLiteral) },
      { ALT: () => this.CONSUME(TrueKeyword) },
      { ALT: () => this.CONSUME(FalseKeyword) },
      { ALT: () => this.SUBRULE(this.arrayLiteral) },
      { ALT: () => this.SUBRULE(this.functionCallOrReference) },
    ]);
  });

  /** functionCallOrReference: Identifier ('(' attributeArgList? ')')? */
  public functionCallOrReference = this.RULE(
    "functionCallOrReference",
    () => {
      this.CONSUME(Identifier);
      this.OPTION(() => {
        this.CONSUME(LParen);
        this.OPTION2(() => {
          this.SUBRULE(this.attributeArgList);
        });
        this.CONSUME(RParen);
      });
    },
  );

  /** arrayLiteral: '[' (attributeValue (',' attributeValue)*)? ']' */
  public arrayLiteral = this.RULE("arrayLiteral", () => {
    this.CONSUME(LBracket);
    this.OPTION(() => {
      this.SUBRULE(this.attributeValue);
      this.MANY(() => {
        this.CONSUME(Comma);
        this.SUBRULE2(this.attributeValue);
      });
    });
    this.CONSUME(RBracket);
  });

  // ─── Assignment (for datasource/generator blocks) ───────────────────

  /** assignment: Identifier '=' attributeValue */
  public assignment = this.RULE("assignment", () => {
    this.CONSUME(Identifier);
    this.CONSUME(Equals);
    this.SUBRULE(this.attributeValue);
  });
}

/** Singleton parser instance (Chevrotain parsers are stateless after construction). */
export const parserInstance = new IndigoParser();
