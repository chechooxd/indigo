/**
 * ERD view-model types shared by `schema-adapter.ts` and `erd.types.ts`.
 *
 * The parsing itself now happens in `@indigodb/core` (`parse` + `resolve`);
 * this file only holds the shapes the ERD/data-browser adapters produce.
 */

export interface Field {
  name: string;
  type: string;
  isPk: boolean;
  isUnique: boolean;
  isNullable: boolean;
  default?: string;
  relation?: {
    model: string;
    fields: string[];
    references: string[];
  };
}

export interface Model {
  name: string;
  color?: string;
  fields: Field[];
}

export interface Enum {
  name: string;
  values: string[];
}

export interface Ref {
  fromModel: string;
  fromField: string;
  toModel: string;
  toField: string;
  relationType: '1-1' | '1-n' | 'n-1';
}

export interface TableGroup {
  name: string;
  tables: string[];
}

export interface IndigoSchema {
  models: Model[];
  enums: Enum[];
  refs: Ref[];
  tableGroups: TableGroup[];
}
