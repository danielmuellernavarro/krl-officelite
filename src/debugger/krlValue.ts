// krlValue.ts
// KRL data model + a small expression evaluator for the simulator runtime.
// Pure logic (no vscode imports).

import { splitTopLevel } from './krlProgram';

export type KrlValue =
    | { t: 'int'; v: number }
    | { t: 'real'; v: number }
    | { t: 'bool'; v: boolean }
    | { t: 'char'; v: string }
    | { t: 'str'; v: string }
    | { t: 'enum'; v: string }
    | { t: 'struct'; name: string; v: Map<string, KrlValue> }
    | { t: 'array'; v: KrlValue[] }
    | { t: 'undef' };

/** Evaluation context provided by the runtime to the expression evaluator. */
export interface EvalContext {
    resolveName(name: string): KrlValue | null;
    invokeFunction(name: string, args: KrlValue[]): KrlValue | null;
}

export const KRL_INT = (v: number): KrlValue => ({ t: 'int', v: Math.trunc(v) });
export const KRL_REAL = (v: number): KrlValue => ({ t: 'real', v });
export const KRL_BOOL = (v: boolean): KrlValue => ({ t: 'bool', v });
export const KRL_STR = (v: string): KrlValue => ({ t: 'str', v });

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

const STRUCT_MEMBERS: Record<string, string[]> = {
    'E6POS':  ['X', 'Y', 'Z', 'A', 'B', 'C', 'S', 'T', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'],
    'POS':    ['X', 'Y', 'Z', 'A', 'B', 'C', 'S', 'T'],
    'FRAME':  ['X', 'Y', 'Z', 'A', 'B', 'C'],
    'E6AXIS': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'],
    'AXIS':   ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
    'A6POS':  ['X', 'Y', 'Z', 'A', 'B', 'C'],
    'A6AXIS': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
    // System variable struct types
    'VEL':  ['CP', 'ORI1', 'ORI2', 'AP'],
    'ACC':  ['CP', 'ORI1', 'ORI2'],
    'APO':  ['CDIS', 'CVEL', 'CPTP', 'CORI'],
    'LOAD': ['M', 'CM', 'J'],
};

export function defaultValue(type: string): KrlValue {
    const t = type.toUpperCase();
    switch (t) {
        case 'INT': return KRL_INT(0);
        case 'REAL': return KRL_REAL(0);
        case 'BOOL': return KRL_BOOL(false);
        case 'CHAR': return { t: 'char', v: ' ' };
        case 'STRING': return KRL_STR('');
        case 'ENUM': return { t: 'enum', v: '' };
        default: {
            if (STRUCT_MEMBERS[t]) {
                const m = new Map<string, KrlValue>();
                for (const k of STRUCT_MEMBERS[t]) { m.set(k.toLowerCase(), KRL_REAL(0)); }
                return { t: 'struct', name: t.toUpperCase(), v: m };
            }
            return { t: 'undef' };
        }
    }
}


/** Parse a KRL @{...} structure literal or @{...} array initializer. */
export function parseBracedLiteral(text: string): KrlValue {
    const inner = text.trim();
    const body = inner.startsWith('{') && inner.endsWith('}') ? inner.slice(1, -1) : inner;
    const parts = splitTopLevel(body, ',');
    // if every part looks like "NAME value ...", build a struct
    const struct = new Map<string, KrlValue>();
    let allNamed = parts.length > 0;
    for (const p of parts) {
        const m = p.trim().match(/^([A-Za-z_][\w$]*)[\s=]*(\S.*)?$/);
        if (!m) { allNamed = false; break; }
        const name = m[1].toLowerCase();
        const rest = (m[2] ?? '').trim();
        struct.set(name, rest ? evaluatePure(rest) : KRL_REAL(0));
    }
    if (allNamed) { return { t: 'struct', name: 'STRUCT', v: struct }; }
    const arr = parts.map(p => evaluatePure(p.trim()));
    return { t: 'array', v: arr };
}

/** Evaluate an initializer with no variable context (used for .dat globals). */
export function evaluatePure(text: string): KrlValue {
    const t = text.trim();
    if (/^[-+]?\d+$/.test(t)) { return KRL_INT(parseInt(t, 10)); }
    if (/^[-+]?\d+\.\d+([eE][-+]?\d+)?$/.test(t)) { return KRL_REAL(parseFloat(t)); }
    const low = t.toLowerCase();
    if (low === 'true') { return KRL_BOOL(true); }
    if (low === 'false') { return KRL_BOOL(false); }
    if (/^[-+]?\d+\s*\/\s*\d+$/.test(t)) {
        const [n, d] = t.split('/').map(s => parseFloat(s));
        return d === 0 ? KRL_INT(0) : KRL_REAL(n / d);
    }
    if (t.startsWith('{') && t.endsWith('}')) { return parseBracedLiteral(t); }
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) { return KRL_STR(t.slice(1, -1)); }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) { return { t: 'char', v: t.slice(1, -1) }; }
    if (/^#/.test(t)) { return { t: 'enum', v: t }; }
    return { t: 'undef' };
}

export function valuesEqual(a: KrlValue, b: KrlValue): boolean {
    if (a.t === 'undef' || b.t === 'undef') { return a.t === b.t; }
    switch (a.t) {
        case 'int': case 'real': return krlNumber(a) === krlNumber(b);
        case 'bool': return krlBool(a) === krlBool(b);
        case 'char': case 'str': return a.v === b.v;
        case 'enum': return a.v === b.v;
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

export function displayValue(v: KrlValue | null | undefined, depth = 0): string {
    if (!v) { return '<unset>'; }
    switch (v.t) {
        case 'int': return String(v.v);
        case 'real': {
            const s = String(v.v);
            return s.includes('.') ? s : s + '.0';
        }
        case 'bool': return v.v ? 'TRUE' : 'FALSE';
        case 'char': return `'${v.v}'`;
        case 'str': return `"${v.v}"`;
        case 'enum': return v.v;
        case 'struct':
            if (depth > 2) { return '{...}'; }
            return '{' + [...v.v.entries()].map(([k, val]) => `${k.toUpperCase()} ${displayValue(val, depth + 1)}`).join(', ') + '}';
        case 'array':
            if (depth > 2) { return '[...]'; }
            return '[' + v.v.map(x => displayValue(x, depth + 1)).join(', ') + ']';
        default: return '<undef>';
    }
}
