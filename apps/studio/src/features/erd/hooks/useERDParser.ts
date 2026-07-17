import { useState, useEffect } from 'react';
import { parse, resolve } from '@indigodb/core';
import { resolvedToIndigoSchema } from '../../../lib/schema-adapter';
import { getNodeColor } from '../../../shared/lib/color-palette';
import type { CanvasNode, ERDLink, ERDTableGroup } from '../../../types/erd.types';

export function useERDParser(dslCode: string) {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [links, setLinks] = useState<ERDLink[]>([]);
  const [tableGroups, setTableGroups] = useState<ERDTableGroup[]>([]);

  useEffect(() => {
    try {
      // Parse the single `.indigo` dialect with the shared core parser/resolver,
      // then adapt to the ERD's view model.
      const parsed = resolvedToIndigoSchema(resolve(parse(dslCode)));
      setNodes(prev => {
        return parsed.models.map((model, idx) => {
          const existing = prev.find(n => n.id === model.name);
          return {
            id: model.name,
            name: model.name,
            x: existing ? existing.x : 40 + (idx % 3) * 320,
            y: existing ? existing.y : 80 + Math.floor(idx / 3) * 220,
            color: model.color ?? getNodeColor(idx, existing?.color),
            fields: model.fields,
          };
        });
      });

      setTableGroups(parsed.tableGroups ?? []);

      const newLinks: ERDLink[] = [];
      parsed.models.forEach(model => {
        model.fields.forEach(f => {
          if (f.relation) {
            const fkFieldNames = f.relation.fields;
            const isFkUnique = fkFieldNames.some(fkName => {
              const fkField = model.fields.find(mf => mf.name === fkName);
              return fkField?.isUnique;
            });
            newLinks.push({
              from: model.name,
              to: f.relation.model,
              relationType: isFkUnique ? '1-1' : 'n-1',
              sourceField: fkFieldNames?.[0] ?? f.name,
              targetField: f.relation.references?.[0],
            });
          }
        });
      });
      parsed.refs.forEach(r => {
        newLinks.push({
          from: r.fromModel,
          to: r.toModel,
          relationType: r.relationType,
          sourceField: r.fromField,
          targetField: r.toField,
        });
      });
      setLinks(newLinks);
    } catch (e) {
      console.warn('ERD Parse error', e);
    }
  }, [dslCode]);

  return { nodes, links, tableGroups, setNodes };
}
