// krlValue.ts
// KRL data model shared by the expression evaluator and the runtime.
// Pure logic (no vscode imports).

import { positionSummary } from './krlRobotFormat';

export type KrlValue =
    | { t: 'int'; v: number }
    | { t: 'real'; v: number }
    | { t: 'bool'; v: boolean }
    | { t: 'char'; v: string }
    | { t: 'str'; v: string }
    /** `type`: the ENUM type of the variable holding it, when declared with one */
    | { t: 'enum'; v: string; type?: string }
    | { t: 'struct'; name: string; v: Map<string, KrlValue> }
    | { t: 'array'; v: KrlValue[] }
    /** no value; `type`: a declared variable that has not been assigned (INT, REAL, ...) */
    | { t: 'undef'; type?: string };

/** Evaluation context provided by the runtime to the expression evaluator. */
/** A read the controller would stop the program at. */
export interface InvalidRead {
    /** the name is not declared; the variable has no value; the index is outside the array */
    kind: 'undeclared' | 'uninitialized' | 'index';
    /** the name as written, e.g. "n", "P1.X", "COUNTS[7]" */
    path: string;
}

/** Thrown by the simulator to stop a statement like the controller does (passes through the evaluator). */
export class KrlStopError extends Error {
    /** the function the statement stopped in, when it was called from an expression */
    where?: string;
    constructor(message: string, readonly read?: InvalidRead) {
        super(message);
    }
}

export interface EvalContext {
    resolveName(name: string): KrlValue | null;
    invokeFunction(name: string, args: KrlValue[]): KrlValue | null;
    /** called for reads the controller would stop at; may throw to stop the evaluation (the simulator does) */
    invalidRead?(read: InvalidRead): void;
}

export const KRL_INT = (v: number): KrlValue => ({ t: 'int', v: Math.trunc(v) });
export const KRL_REAL = (v: number): KrlValue => ({ t: 'real', v });
export const KRL_BOOL = (v: boolean): KrlValue => ({ t: 'bool', v });
export const KRL_STR = (v: string): KrlValue => ({ t: 'str', v });
export const KRL_UNDEF = (): KrlValue => ({ t: 'undef' });

export function krlNumber(v: KrlValue | null | undefined, fallback = 0): number {
    if (!v) { return fallback; }
    switch (v.t) {
        case 'int': case 'real': return v.v;
        case 'bool': return v.v ? 1 : 0;
        case 'char': return v.v.charCodeAt(0) || 0;
        case 'enum': return fallback;
        case 'str': { const n = Number(v.v); return Number.isNaN(n) ? fallback : n; }
        default: return fallback;
    }
}

export function krlBool(v: KrlValue | null | undefined): boolean {
    if (!v) { return false; }
    switch (v.t) {
        case 'bool': return v.v;
        case 'int': case 'real': return v.v !== 0;
        case 'str': return v.v.length > 0;
        case 'char': return v.v.length > 0;
        case 'enum': return v.v.length > 0;
        case 'array': return v.v.length > 0;
        case 'struct': return v.v.size > 0;
        default: return false;
    }
}

/** Component of a structure type: `INT TOOL_NO` or `CHAR NAME[24]`. */
export interface StructMember {
    name: string;
    type: string;
    dims: number[];
}

/** Looks up a user defined STRUC type by name (case-insensitive). */
export type StructLookup = (typeName: string) => StructMember[] | undefined;

const m = (type: string, ...names: string[]): StructMember[] => names.map(name => ({ name, type, dims: [] }));

/** Predefined structure types (manual section 2.2.5) and the system ones simulated here. */
const BUILTIN_STRUCTS: Record<string, StructMember[]> = {
    'FRAME':  m('REAL', 'X', 'Y', 'Z', 'A', 'B', 'C'),
    'POS':    [...m('REAL', 'X', 'Y', 'Z', 'A', 'B', 'C'), ...m('INT', 'S', 'T')],
    'E6POS':  [...m('REAL', 'X', 'Y', 'Z', 'A', 'B', 'C'), ...m('INT', 'S', 'T'), ...m('REAL', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6')],
    'AXIS':   m('REAL', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'),
    'E6AXIS': m('REAL', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'),
    'A6POS':  m('REAL', 'X', 'Y', 'Z', 'A', 'B', 'C'),
    'A6AXIS': m('REAL', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'),
    // system variable structure types
    'VEL':  m('REAL', 'CP', 'ORI1', 'ORI2'),
    'ACC':  m('REAL', 'CP', 'ORI1', 'ORI2'),
    'APO':  m('REAL', 'CDIS', 'CVEL', 'CPTP', 'CORI'),
    // $JERK, $JERK_MA (BAS.SRC: SJERK)
    'JERK_STRUC': [...m('REAL', 'CP', 'ORI'), { name: 'AX', type: 'E6AXIS', dims: [] }],
    'LOAD': [...m('REAL', 'M'), ...m('FRAME', 'CM'), ...m('REAL', 'J')],
    'ERR':  m('INT', 'NUMBER', 'PHASE', 'MODULE', 'LINE', 'TYPE', 'STATE'),
    // messages and dialogs: SET_KRLMSG / SET_KRLDLG
    'KRLMSG_T': [{ name: 'MODUL', type: 'CHAR', dims: [24] }, { name: 'NR', type: 'INT', dims: [] }, { name: 'MSG_TXT', type: 'CHAR', dims: [80] }],
    'KRLMSGPAR_T': [
        { name: 'PAR_TYPE', type: 'KRLMSGPARTYPE_T', dims: [] }, { name: 'PAR_TXT', type: 'CHAR', dims: [26] },
        { name: 'PAR_INT', type: 'INT', dims: [] }, { name: 'PAR_REAL', type: 'REAL', dims: [] }, { name: 'PAR_BOOL', type: 'BOOL', dims: [] },
    ],
    'KRLMSGOPT_T': m('BOOL', 'VL_STOP', 'CLEAR_P_RESET', 'CLEAR_P_SAW', 'LOG_TO_DB'),
    'KRLMSGDLGSK_T': [{ name: 'SK_TYPE', type: 'KRLMSGPARTYPE_T', dims: [] }, { name: 'SK_TXT', type: 'CHAR', dims: [10] }],
};

/** POS, E6POS, AXIS, E6AXIS and FRAME keep components missing from an aggregate (manual 2.2.5). */
const POSITION_TYPES = new Set(['FRAME', 'POS', 'E6POS', 'AXIS', 'E6AXIS', 'A6POS', 'A6AXIS']);

export function isPositionType(typeName: string): boolean {
    return POSITION_TYPES.has(typeName.toUpperCase());
}

export function builtinStructMembers(typeName: string): StructMember[] | undefined {
    return BUILTIN_STRUCTS[typeName.toUpperCase()];
}

/** Default (initial) value of a variable of the given type. */
/**
 * A declared variable before its first assignment: scalars without value that
 * remember their type, structures whose components have none. CHAR arrays
 * (strings) start blank.
 */
export function unassignedValue(type: string, lookup?: StructLookup, depth = 0): KrlValue {
    const t = type.toUpperCase();
    const members = /^(?:INT|REAL|BOOL|CHAR)$/.test(t) ? undefined : BUILTIN_STRUCTS[t] ?? (lookup ? lookup(t) : undefined);
    if (!members || depth > 8) { return { t: 'undef', type: t }; }
    const map = new Map<string, KrlValue>();
    for (const mem of members) {
        map.set(mem.name.toLowerCase(), mem.dims.length > 0
            ? makeArray(mem.dims, () => (mem.type.toUpperCase() === 'CHAR' ? defaultValue('CHAR') : unassignedValue(mem.type, lookup, depth + 1)))
            : unassignedValue(mem.type, lookup, depth + 1));
    }
    return { t: 'struct', name: t, v: map };
}

/** No value: a scalar without value, or a structure none of whose components has one. */
export function hasNoValue(v: KrlValue): boolean {
    if (v.t === 'undef') { return true; }
    return v.t === 'struct' && v.v.size > 0 && [...v.v.values()].every(hasNoValue);
}

export function defaultValue(type: string, lookup?: StructLookup, depth = 0): KrlValue {
    const t = type.toUpperCase();
    switch (t) {
        case 'INT': return KRL_INT(0);
        case 'REAL': return KRL_REAL(0);
        case 'BOOL': return KRL_BOOL(false);
        case 'CHAR': return { t: 'char', v: ' ' };
        case 'STRING': return KRL_STR('');
        default: break;
    }
    const members = BUILTIN_STRUCTS[t] ?? (lookup ? lookup(t) : undefined);
    if (!members || depth > 8) { return KRL_UNDEF(); }
    const map = new Map<string, KrlValue>();
    for (const mem of members) {
        map.set(mem.name.toLowerCase(), mem.dims.length > 0
            ? makeArray(mem.dims, () => defaultValue(mem.type, lookup, depth + 1))
            : defaultValue(mem.type, lookup, depth + 1));
    }
    return { t: 'struct', name: t, v: map };
}

/** Build a (possibly multi-dimensional) array. KRL arrays are 1-based; index 0 maps to v[0]. */
export function makeArray(dims: number[], element: () => KrlValue): KrlValue {
    const [n, ...rest] = dims;
    const size = Math.max(0, Math.min(Math.trunc(n), 100000));
    return {
        t: 'array',
        v: Array.from({ length: size }, () => rest.length > 0 ? makeArray(rest, element) : element()),
    };
}

export function cloneValue(v: KrlValue): KrlValue {
    switch (v.t) {
        case 'struct': {
            const map = new Map<string, KrlValue>();
            for (const [k, x] of v.v) { map.set(k, cloneValue(x)); }
            return { t: 'struct', name: v.name, v: map };
        }
        case 'array': return { t: 'array', v: v.v.map(cloneValue) };
        default: return { ...v };
    }
}

/**
 * Value stored when `value` is assigned to a variable currently holding `old`:
 * numeric types are converted to the variable's type, strings fill CHAR arrays
 * and aggregates are merged into structures following the manual's rules.
 */
export function assignmentValue(old: KrlValue | undefined, value: KrlValue): KrlValue {
    if (!old) { return cloneValue(value); }
    // an ENUM variable keeps its type (the Variables view offers its literals)
    if (value.t === 'enum' && (old.t === 'enum' || old.t === 'undef') && old.type && !/^(?:INT|REAL|BOOL|CHAR)$/.test(old.type)) {
        return { t: 'enum', v: value.v, type: old.type };
    }
    // a declared variable without value: converted like a variable of its type
    if (old.t === 'undef' && old.type) {
        if (value.t === 'undef') { return cloneValue(old); }
        if (/^(?:INT|REAL|BOOL|CHAR)$/.test(old.type)) { return assignmentValue(defaultValue(old.type), value); }
    }
    if (old.t === 'int' && value.t === 'real') { return KRL_INT(Math.round(value.v)); }
    if (old.t === 'real' && value.t === 'int') { return KRL_REAL(value.v); }
    if (old.t === 'char' && value.t === 'str') { return { t: 'char', v: value.v.charAt(0) || ' ' }; }
    if (old.t === 'array' && value.t === 'str' && isCharArray(old)) {
        const out = cloneValue(old) as { t: 'array'; v: KrlValue[] };
        for (let i = 0; i < out.v.length; i++) { out.v[i] = { t: 'char', v: i < value.v.length ? value.v[i] : ' ' }; }
        return out;
    }
    if (old.t === 'struct' && value.t === 'struct') {
        const out = cloneValue(old) as { t: 'struct'; name: string; v: Map<string, KrlValue> };
        if (!isPositionType(old.name)) {
            for (const k of out.v.keys()) { if (!value.v.has(k)) { out.v.set(k, KRL_UNDEF()); } }
        }
        for (const [k, x] of value.v) { out.v.set(k, assignmentValue(old.v.get(k), x)); }
        return out;
    }
    return cloneValue(value);
}

/**
 * Assign `value` to the variable currently holding `old` and return what to
 * store. An existing value is overwritten in place, so OUT parameters bound
 * to the variable (call by reference) see the change, also from other threads.
 */
export function storeValue(old: KrlValue | undefined, value: KrlValue): KrlValue {
    const next = assignmentValue(old, value);
    if (!old) { return next; }
    const target = old as unknown as Record<string, unknown>;
    for (const k of Object.keys(target)) { delete target[k]; }
    Object.assign(target, next);
    return old;
}

export function isCharArray(v: KrlValue): boolean {
    return v.t === 'array' && v.v.length > 0 && v.v.every(x => x.t === 'char');
}

export function charArrayText(v: KrlValue): string {
    if (v.t !== 'array') { return ''; }
    return v.v.map(x => (x.t === 'char' ? x.v : '')).join('').replace(/[\s\0]+$/, '');
}

export function valuesEqual(a: KrlValue, b: KrlValue): boolean {
    if (a.t === 'undef' || b.t === 'undef') { return a.t === b.t; }
    switch (a.t) {
        case 'int': case 'real': return krlNumber(a) === krlNumber(b, Number.NaN);
        case 'bool': return krlBool(a) === krlBool(b);
        case 'char': case 'str':
            return (b.t === 'char' || b.t === 'str') ? a.v === b.v : krlNumber(a) === krlNumber(b, Number.NaN);
        // enum literals are identifiers and therefore case-insensitive
        case 'enum': return b.t === 'enum' && a.v.toLowerCase() === b.v.toLowerCase();
        case 'array':
            if (b.t !== 'array' || a.v.length !== b.v.length) { return false; }
            for (let i = 0; i < a.v.length; i++) { if (!valuesEqual(a.v[i], b.v[i])) { return false; } }
            return true;
        case 'struct':
            if (b.t !== 'struct') { return false; }
            if (a.v.size !== b.v.size) { return false; }
            for (const [k, av] of a.v) {
                const bv = b.v.get(k);
                if (!bv || !valuesEqual(av, bv)) { return false; }
            }
            return true;
        default: return false;
    }
}

/** Type label shown in the Variables panel. */
export function typeLabel(v: KrlValue): string {
    switch (v.t) {
        case 'struct': return v.name;
        case 'array': {
            const elem = v.v[0];
            return `${elem ? typeLabel(elem) : 'ARRAY'}[${v.v.length}]`;
        }
        case 'str': return 'STRING';
        default: return v.t.toUpperCase();
    }
}

const MAX_DISPLAY_ELEMENTS = 10;

export function displayValue(v: KrlValue | null | undefined, depth = 0): string {
    if (!v) { return '<unset>'; }
    switch (v.t) {
        case 'int': return String(v.v);
        case 'real': {
            const s = String(v.v);
            return /[.eE]|Infinity|NaN/.test(s) ? s : s + '.0';
        }
        case 'bool': return v.v ? 'TRUE' : 'FALSE';
        case 'char': return `'${v.v}'`;
        case 'str': return `"${v.v}"`;
        case 'enum': return v.v;
        case 'struct': {
            if (depth > 2) { return '{...}'; }
            // positions and frames with units: X: 450.0 mm, ..., A: 0.0°, S: 'B010', T: 'B100011'
            const position = positionSummary(v.v);
            if (position) { return depth === 0 ? position : `{${position}}`; }
            return '{' + [...v.v.entries()].map(([k, val]) => `${k.toUpperCase()} ${displayValue(val, depth + 1)}`).join(', ') + '}';
        }
        case 'array': {
            if (isCharArray(v)) { return `"${charArrayText(v)}"`; }
            if (depth > 2) { return '[...]'; }
            const shown = v.v.slice(0, MAX_DISPLAY_ELEMENTS).map(x => displayValue(x, depth + 1));
            if (v.v.length > MAX_DISPLAY_ELEMENTS) { shown.push(`... (${v.v.length})`); }
            return '[' + shown.join(', ') + ']';
        }
        default: return '<undef>';
    }
}
