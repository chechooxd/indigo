# Delta for Model Allow Rules

## REMOVED Requirements

### Requirement: `@@realtime` and `@@allow` are mutually exclusive on one model

The compiler MUST reject a model that declares both `@@realtime` and `@@allow`, with a located
diagnostic, because the realtime fan-out path has no row-level filter.

#### Scenario: Combination rejected

- GIVEN a model with both `@@realtime` and `@@allow(read, auth.userId == this.ownerId)`
- WHEN the schema is validated
- THEN a located diagnostic is produced naming the conflicting attributes

(Reason: The realtime fan-out path now has a row-level filter. The `realtime-live-endpoint`
`GET ?handle&offset` route is the mandatory RLS-enforced read path for `@@allow` models, and
SSE `dispatch()` is scoped to a data-free `{table, op, lsn}` wake-up signal for those models —
see `realtime-live-endpoint`'s "SSE dispatch is scoped..." and "Guard removal and SSE scoping
ship together" requirements. With no path left that fans protected row data to an
unauthenticated subscriber, the compile-time rejection is no longer needed.)
(Migration: `crates/indigo-compiler/src/validate.rs`'s rejection and its
`allow_realtime_conflict_is_rejected` test are removed; the WASM artifact is rebuilt. A
formerly-rejected `@@realtime`+`@@allow` fixture becomes valid. No requirement replaces this
one in `model-allow-rules` — the constraint that made the combination safe now lives in
`realtime-live-endpoint`, since it is a property of the read/dispatch paths, not of the
`@@allow` grammar itself.)
