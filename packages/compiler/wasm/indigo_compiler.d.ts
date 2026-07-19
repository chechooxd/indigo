/* tslint:disable */
/* eslint-disable */

/**
 * One-shot parse+validate+resolve.
 * `{"ok": {schema, resolved, validationErrors}}` | `{"errors": CompilerError[]}`
 */
export function compile(source: string): string;

/**
 * `{"ok": Schema}` | `{"errors": CompilerError[]}`
 */
export function parse(source: string): string;

/**
 * Accepts a `Schema` as JSON. `{"ok": ResolvedSchema}` | `{"error": string}`
 */
export function resolve(schema_json: string): string;

/**
 * Accepts a `Schema` as JSON. `{"ok": ValidationError[]}` | `{"error": string}`
 */
export function validate(schema_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compile: (a: number, b: number) => [number, number];
    readonly parse: (a: number, b: number) => [number, number];
    readonly resolve: (a: number, b: number) => [number, number];
    readonly validate: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
