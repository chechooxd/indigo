import { useState, useEffect } from 'react';
import { parse, resolve, validate, IndigoParseError } from '@indigodb/core';
import { resolvedToIndigoSchema } from '../../../lib/schema-adapter';
import { getNodeColor } from '../../../shared/lib/color-palette';
import type { CanvasNode, ERDLink, ERDTableGroup } from '../../../types/erd.types';
import type { Diagnostic } from '../lib/diagnostics';

export function useERDParser(dslCode: string) {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [links, setLinks] = useState<ERDLink[]>([]);
  const [tableGroups, setTableGroups] = useState<ERDTableGroup[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  useEffect(() => {
    try {
      const schema = parse(dslCode);

      // Validate before resolving: `validate()` returns a structured
      // `ValidationError[]` ({message, model?, field?}, never a position),
      // which is exactly the shape this hook must classify as a
      // position-less diagnostics-panel entry with zero fabricated markers.
      // `resolve()` itself only throws a plain `Error` with a string
      // message, which cannot carry `model`/`field` — validating first is
      // what makes that structured classification possible at all.
      const validationErrors = validate(schema);
      if (validationErrors.length > 0) {
        setDiagnostics(
          validationErrors.map((error) => ({
            source: 'validate' as const,
            message: error.message,
            model: error.model,
            field: error.field,
          })),
        );
        return;
      }

      // Parse the single `.indigo` dialect with the shared core parser/resolver,
      // then adapt to the ERD's view model.
      const parsed = resolvedToIndigoSchema(resolve(schema));
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

      // Rebuild diagnostics from scratch on every successful parse+resolve
      // (decision 17) — this is the "fixing the error clears its marker"
      // path: a fresh empty array, never a leftover from a prior failure.
      setDiagnostics([]);
    } catch (e) {
      if (e instanceof IndigoParseError) {
        setDiagnostics(
          e.errors.map((error) => ({
            source: 'parse' as const,
            message: error.message,
            line: error.line,
            column: error.column,
            endLine: error.endLine,
            endColumn: error.endColumn,
          })),
        );
        return;
      }
      // Any other failure (e.g. `resolve()`'s plain `Error`) is reported
      // honestly as position-less rather than fabricating a location.
      setDiagnostics([
        { source: 'validate', message: e instanceof Error ? e.message : String(e) },
      ]);
    }
  }, [dslCode]);

  return { nodes, links, tableGroups, setNodes, diagnostics };
}
