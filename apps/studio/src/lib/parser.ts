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

export function parseIndigo(code: string): IndigoSchema {
  const schema: IndigoSchema = {
    models: [],
    enums: [],
    refs: [],
    tableGroups: []
  };

  // Remove comments
  const cleanCode = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // 1. Parse Enums
  const enumRegex = /enum\s+([a-zA-Z_]\w*)\s*{([^}]+)}/g;
  let enumMatch;
  while ((enumMatch = enumRegex.exec(cleanCode)) !== null) {
    const enumName = enumMatch[1];
    const values = enumMatch[2]
      .split('\n')
      .map(v => v.trim())
      .filter(v => v.length > 0);
    schema.enums.push({ name: enumName, values });
  }

  // 2. Parse Tables (now supporting optional settings like [headercolor: #hex])
  const tableRegex = /(?:Table|table)\s+([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*(?:\[(.*?)\])?\s*{([^}]+)}/g;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(cleanCode)) !== null) {
    const tableName = tableMatch[1];
    const tableSettings = tableMatch[2];
    const fieldsBody = tableMatch[3];
    
    let tableColor;
    if (tableSettings) {
      const colorMatch = tableSettings.match(/(?:headercolor|color):\s*(#[0-9a-fA-F]{3,6})/i);
      if (colorMatch) {
        tableColor = colorMatch[1];
      }
    }

    const fields: Field[] = [];
    const lines = fieldsBody.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      // Basic field matching: name type [@attributes]
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        let typeStr = parts[1];
        
        let isNullable = false;
        if (typeStr.endsWith('?')) {
          isNullable = true;
          typeStr = typeStr.slice(0, -1);
        }

        const isPk = line.includes('@id') || line.includes('@pk');
        const isUnique = line.includes('@unique');
        
        // Parse @default(val)
        let defaultVal;
        const defaultMatch = line.match(/@default\(([^)]+)\)/);
        if (defaultMatch) {
          defaultVal = defaultMatch[1];
        }

        fields.push({
          name,
          type: typeStr,
          isPk,
          isNullable,
          isUnique,
          default: defaultVal
        });
      }
    }
    
    schema.models.push({ name: tableName, color: tableColor, fields });
  }

  // 3. Parse Explicit Refs: Ref: Profile.userId - User.id
  const refRegex = /(?:Ref|ref):\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\.([a-zA-Z_]\w*)\s*([<>\-])\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\.([a-zA-Z_]\w*)/g;
  let refMatch;
  while ((refMatch = refRegex.exec(cleanCode)) !== null) {
    const fromModel = refMatch[1];
    const fromField = refMatch[2];
    const op = refMatch[3];
    const toModel = refMatch[4];
    const toField = refMatch[5];
    
    let relType: '1-1' | '1-n' | 'n-1' = '1-1';
    if (op === '<') relType = '1-n';
    if (op === '>') relType = 'n-1';

    schema.refs.push({
      fromModel,
      fromField,
      toModel,
      toField,
      relationType: relType
    });
  }

  // 4. Parse TableGroups
  const groupRegex = /TableGroup\s+([a-zA-Z_]\w*)\s*{([^}]+)}/g;
  let groupMatch;
  while ((groupMatch = groupRegex.exec(cleanCode)) !== null) {
    const groupName = groupMatch[1];
    const tablesList = groupMatch[2]
      .split('\n')
      .map(v => v.trim())
      .filter(v => v.length > 0 && !v.startsWith('//'));
      
    schema.tableGroups.push({
      name: groupName,
      tables: tablesList
    });
  }

  return schema;
}
