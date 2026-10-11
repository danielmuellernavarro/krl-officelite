// krlRobotFormat.ts
// Readable values of the robot types: positions (FRAME, POS, E6POS) with X, Y,
// Z in mm, A, B, C in degrees and the Status / Turn bits decoded, axis
// positions (AXIS, E6AXIS) in degrees, and frames as homogeneous matrices.
// Used by the Variables view, hovers, the robot view and the editor.
// Pure logic (no vscode imports).

import type { KrlValue } from './krlValue';

type Members = Map<string, KrlValue>;

const CARTESIAN = ['x', 'y', 'z', 'a', 'b', 'c'];
const AXES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const EXTERNAL = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];

function num(v: KrlValue | undefined): number | null {
    return v && (v.t === 'int' || v.t === 'real') ? v.v : null;
}

/** A structure holding a Cartesian position or frame (X, Y, Z, A, B, C). */
export function isCartesian(members: Members): boolean {
    return members.has('x') && members.has('y') && members.has('z');
}

/** A structure holding an axis position (A1 ... A6). */
export function isAxisPosition(members: Members): boolean {
    return members.has('a1') && !members.has('x');
}

/** Real numbers with at most `decimals` decimals, always with a decimal point. */
export function formatReal(v: number, decimals = 3): string {
    if (!Number.isFinite(v)) { return String(v); }
    const fixed = Number(v.toFixed(decimals));
    const s = String(Object.is(fixed, -0) ? 0 : fixed);
    return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Unit of a component of a position or axis structure ('' for none). */
export function componentUnit(members: Members, key: string): string {
    const k = key.toLowerCase();
    if (isCartesian(members)) {
        if (k === 'x' || k === 'y' || k === 'z') { return 'mm'; }
        if (k === 'a' || k === 'b' || k === 'c') { return '°'; }
    }
    if (isAxisPosition(members) && AXES.includes(k)) { return '°'; }
    return '';
}

const binary = (n: number, digits: number) => `'B${(n >>> 0).toString(2).padStart(digits, '0')}'`;

/** Status bits (KSS 8.3 manual 9.10.1). */
export function statusText(s: number): string {
    const parts = [
        s & 1 ? 'overhead area' : 'basic area',
        s & 2 ? 'A3 ≥ φ' : 'A3 < φ',
        s & 4 ? 'A5 < 0°' : 'A5 ≥ 0°',
    ];
    if (s & 16) { parts.push('taught on an absolutely accurate robot'); }
    return `${binary(s, 3)}: ${parts.join(', ')}`;
}

/** Turn bits: bit n set means axis n+1 is negative (KSS 8.3 manual 9.10.2). */
export function turnText(t: number): string {
    const negative = AXES.filter((_, i) => (t >> i) & 1).map(a => `${a.toUpperCase()} < 0°`);
    return `${binary(t, 6)}: ${negative.length > 0 ? negative.join(', ') : 'all axes ≥ 0°'}`;
}

/**
 * One-line summary of a position or axis structure, e.g.
 * `X: 450.0 mm, Y: 0.0 mm, Z: 800.0 mm, A: 0.0°, B: 90.0°, C: 0.0°, S: 'B010', T: 'B100011'`
 * or `A1: 0.0°, A2: -90.0°, ...`. External axes are listed when not 0. Null for other structures.
 */
export function positionSummary(members: Members): string | null {
    const parts: string[] = [];
    const add = (k: string, unit: string) => {
        const n = num(members.get(k));
        if (n !== null) { parts.push(`${k.toUpperCase()}: ${formatReal(n)}${unit === '°' ? '°' : unit ? ' ' + unit : ''}`); }
    };
    if (isCartesian(members)) {
        for (const k of CARTESIAN) { add(k, 'abc'.includes(k) ? '°' : 'mm'); }
    } else if (isAxisPosition(members)) {
        for (const k of AXES) { add(k, '°'); }
    } else {
        return null;
    }
    for (const k of EXTERNAL) {
        const n = num(members.get(k));
        if (n !== null && n !== 0) { add(k, ''); }
    }
    const s = num(members.get('s'));
    const t = num(members.get('t'));
    if (s !== null) { parts.push(`S: ${binary(s, 3)}`); }
    if (t !== null) { parts.push(`T: ${binary(t, 6)}`); }
    return parts.join(', ');
}

/** A component of a position with its unit; S and T decoded. Null when not a position component. */
export function componentText(members: Members, key: string, value: KrlValue): string | null {
    const k = key.toLowerCase();
    const n = num(value);
    if (n === null || (!isCartesian(members) && !isAxisPosition(members))) { return null; }
    if (k === 's' && isCartesian(members)) { return `${n}  (${statusText(n)})`; }
    if (k === 't' && isCartesian(members)) { return `${n}  (${turnText(n)})`; }
    const unit = componentUnit(members, k);
    if (!unit) { return null; }
    const text = value.t === 'int' ? String(n) : formatReal(n, 6);
    return unit === '°' ? `${text}°` : `${text} ${unit}`;
}

/**
 * A value edited in the Variables view, in the form it was shown: the summary
 * `X: 450.0 mm, Y: 0.0 mm, ..., S: 'B010'` becomes the aggregate `{X 450.0, Y 0.0, ..., S 'B010'}`;
 * units and the S / T explanations are dropped. Other text is returned as it is.
 */
export function normalizeEditedValue(text: string): string {
    const body = text.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
    const parts = body.split(',').map(s => s.trim()).filter(Boolean);
    const component = /^([A-Za-z]\w*)\s*:\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|'[BbHh][0-9A-Fa-f]+')\s*(?:mm|°|deg)?\s*(?:\(.*\))?$/;
    if (parts.length > 0 && parts.every(s => component.test(s))) {
        return `{${parts.map(s => { const m = component.exec(s)!; return `${m[1].toUpperCase()} ${m[2]}`; }).join(', ')}}`;
    }
    // a single component: "450.0 mm", "-90.0°", "2  ('B010': basic area, ...)"
    const single = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:mm|°|deg)?\s*(?:\(.*\))?$/.exec(text.trim());
    return single ? single[1] : text;
}

/**
 * Homogeneous transformation of a frame: rotation Rz(A)·Ry(B)·Rx(C) (KUKA Euler
 * angles in degrees) and translation X, Y, Z.
 */
export function frameMatrix(x: number, y: number, z: number, a: number, b: number, c: number): number[][] {
    const r = Math.PI / 180;
    const [ca, sa] = [Math.cos(a * r), Math.sin(a * r)];
    const [cb, sb] = [Math.cos(b * r), Math.sin(b * r)];
    const [cc, sc] = [Math.cos(c * r), Math.sin(c * r)];
    return [
        [ca * cb, ca * sb * sc - sa * cc, ca * sb * cc + sa * sc, x],
        [sa * cb, sa * sb * sc + ca * cc, sa * sb * cc - ca * sc, y],
        [-sb, cb * sc, cb * cc, z],
        [0, 0, 0, 1],
    ];
}

/** Matrix of a Cartesian structure, or null. */
export function matrixOf(members: Members): number[][] | null {
    if (!isCartesian(members)) { return null; }
    const g = (k: string) => num(members.get(k)) ?? 0;
    return frameMatrix(g('x'), g('y'), g('z'), g('a'), g('b'), g('c'));
}

/** A 4x4 matrix as aligned rows in a markdown code block: rotation with 4 decimals, translation in mm. */
export function matrixMarkdown(m: number[][]): string {
    const cells = m.map(row => row.map((v, j) => {
        const n = Math.abs(v) < 5e-7 ? 0 : v;
        return j === 3 ? formatReal(n, 3) : n.toFixed(4);
    }));
    const widths = [0, 1, 2, 3].map(j => Math.max(...cells.map(r => r[j].length)));
    return ['```', ...cells.map(r => r.map((c, j) => c.padStart(widths[j])).join('  ')), '```'].join('\n');
}
