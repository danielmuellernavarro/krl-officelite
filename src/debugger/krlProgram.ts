// krlProgram.ts
// Parses KRL source code (.src / .dat) into executable statements and
// pre-computes the control-flow links used by the simulator runtime.
// This module is pure logic (no vscode imports) so it can be unit-tested
// with plain node.

export type KrlStmtKind =
    | 'prog' | 'fct' | 'defdat' | 'end' | 'endfct' | 'enddat'
    | 'if' | 'else' | 'endif'
    | 'for' | 'endfor'
    | 'while' | 'endwhile'
    | 'loop' | 'endloop'
    | 'repeat' | 'until'
    | 'switch' | 'case' | 'default' | 'endswitch'
    | 'decl' | 'assign' | 'call' | 'return' | 'motion' | 'wait' | 'other';

export interface KrlStmt {
    kind: KrlStmtKind;
    /** 0-based source line number */
    line: number;
    /** trimmed original line */
    text: string;
}

export interface KrlParam {
    name: string;
    type: string;
    dir: 'IN' | 'OUT' | 'INOUT' | '';
}

export interface KrlFunctionInfo {
    /** lowercased name, used for lookup */
    name: string;
    displayName: string;
    kind: 'prog' | 'fct' | 'defdat';
    /** statement index of the DEF/DEFFCT/DEFDAT line */
    startIdx: number;
    /** statement index of the matching END/ENDFCT/ENDDAT line */
    endIdx: number;
    returnType: string;
    params: KrlParam[];
}

export interface KrlSwitchCase {
    caseIdx: number;
    value: string;
}

export interface KrlProgram {
    path: string;
    stmts: KrlStmt[];
    /** per source line -> statement index or -1 */
    lineToIndex: number[];
    /** functions / programs by lowercased name */
    funcs: Map<string, KrlFunctionInfo>;
    firstProgramIndex: number;

    // control-flow maps (statement index -> statement index)
    ifFalseToElse: Map<number, number>;   // IF -> ELSE
    ifAfter: Map<number, number>;         // IF -> after ENDIF ; ELSE -> after ENDIF
    forEnd: Map<number, number>;
    forStart: Map<number, number>;
    whileEnd: Map<number, number>;
    whileStart: Map<number, number>;
    loopEnd: Map<number, number>;
    loopStart: Map<number, number>;
    repeatUntil: Map<number, number>;
    untilRepeat: Map<number, number>;
    switchEnd: Map<number, number>;
    switchCases: Map<number, KrlSwitchCase[]>;
    switchDefault: Map<number, number>;
    fctEnd: Map<number, number>;
}

// ---------------------------------------------------------------------------
// line classification

const RE_ENDDAT = /^\s*ENDDAT\b/i;
const RE_ENDFCT = /^\s*ENDFCT\b/i;
const RE_END = /^\s*END\b/i;
const RE_DAT = /^\s*DEFDAT\b/i;
const RE_FCT = /^\s*DEFFCT\b/i;
const RE_DEF = /^\s*DEF\b/i;
const RE_IF = /^\s*IF\b/i;
const RE_ELSE = /^\s*ELSE\b/i;
const RE_ENDIF = /^\s*ENDIF\b/i;
const RE_FOR = /^\s*FOR\b/i;
const RE_ENDFOR = /^\s*ENDFOR\b/i;
const RE_WHILE = /^\s*WHILE\b/i;
const RE_ENDWHILE = /^\s*ENDWHILE\b/i;
const RE_LOOP = /^\s*LOOP\b/i;
const RE_ENDLOOP = /^\s*ENDLOOP\b/i;
const RE_REPEAT = /^\s*REPEAT\b/i;
const RE_UNTIL = /^\s*UNTIL\b/i;
const RE_SWITCH = /^\s*SWITCH\b/i;
const RE_CASE = /^\s*CASE\b/i;
const RE_DEFAULT = /^\s*DEFAULT\b/i;
const RE_ENDSWITCH = /^\s*ENDSWITCH\b/i;
const RE_RETURN = /^\s*RETURN\b/i;
const RE_WAIT = /^\s*WAIT\b/i;
const RE_MOTION = /^\s*(?:PTP|LIN|CIRC|SPTP|SLIN|SCIRC|PTP_REL|LIN_REL|CIRC_REL)\b/i;
const RE_DECL = /^\s*(?:GLOBAL\s+)?(?:DECL\s+)?(?:INT|REAL|BOOL|CHAR|STRING|FRAME|POS|E6POS|E6AXIS|AXIS|A6POS|A6AXIS|TIMER|SIGNAL|ENUM|STRUC)\b/i;
const RE_CALL = /^\s*[A-Z_$][\w$]*\s*\(/;
const RE_SINGLE_EQ = /(^|[^=!<>])=(?!=)/;

/** KRL data types that produce a structure with named components */
const STRUCT_TYPES = new Set(['FRAME', 'POS', 'E6POS', 'AXIS', 'E6AXIS', 'A6POS', 'A6AXIS']);

export function isStructType(type: string): boolean {
    return STRUCT_TYPES.has(type.toUpperCase());
}

/** Strip an inline comment (';' outside of string literals). */
export function stripComment(line: string): string {
    let inString = false;
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inString) {
            if (c === quote) { inString = false; quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { inString = true; quote = c; continue; }
        if (c === ';' && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i).trimEnd();
        }
    }
    return line;
}

export function classifyLine(raw: string): KrlStmtKind {
    const text = stripComment(raw.trim());
    if (/^\s*$/.test(text)) { return 'other'; }
    if (RE_ENDDAT.test(text)) { return 'enddat'; }
    if (RE_ENDFCT.test(text)) { return 'endfct'; }
    if (RE_END.test(text)) { return 'end'; }
    if (RE_DAT.test(text)) { return 'defdat'; }
    if (RE_FCT.test(text)) { return 'fct'; }
    if (RE_DEF.test(text)) { return 'prog'; }
    if (RE_ENDIF.test(text)) { return 'endif'; }
    if (RE_ENDFOR.test(text)) { return 'endfor'; }
    if (RE_ENDWHILE.test(text)) { return 'endwhile'; }
    if (RE_ENDLOOP.test(text)) { return 'endloop'; }
    if (RE_ENDSWITCH.test(text)) { return 'endswitch'; }
    if (RE_UNTIL.test(text)) { return 'until'; }
    if (RE_IF.test(text)) { return 'if'; }
    if (RE_ELSE.test(text)) { return 'else'; }
    if (RE_FOR.test(text)) { return 'for'; }
    if (RE_WHILE.test(text)) { return 'while'; }
    if (RE_LOOP.test(text)) { return 'loop'; }
    if (RE_REPEAT.test(text)) { return 'repeat'; }
    if (RE_SWITCH.test(text)) { return 'switch'; }
    if (RE_CASE.test(text)) { return 'case'; }
    if (RE_DEFAULT.test(text)) { return 'default'; }
    if (RE_RETURN.test(text)) { return 'return'; }
    if (RE_WAIT.test(text)) { return 'wait'; }
    if (RE_MOTION.test(text)) { return 'motion'; }
    if (RE_DECL.test(text)) { return 'decl'; }
    if (RE_CALL.test(text)) { return 'call'; }
    if (RE_SINGLE_EQ.test(text)) { return 'assign'; }
    return 'other';
}

const RE_SIG_FCT = /^\s*(?:GLOBAL\s+)?DEFFCT\b\s+([A-Z_$][\w$]*)\s+([A-Z_$][\w$]*)\s*\(([^)]*)\)/i;
const RE_SIG_DEF = /^\s*(?:GLOBAL\s+)?DEF\b\s+([A-Z_$][\w$]*)\s*\(([^)]*)\)/i;
const RE_SIG_DAT = /^\s*(?:GLOBAL\s+)?DEFDAT\b\s+([A-Z_$][\w$]*)/i;

export function parseSignature(kind: KrlStmtKind, text: string):
    { name: string; returnType: string; params: KrlParam[] } | null {
    let m: RegExpMatchArray | null = null;
    if (kind === 'fct') {
        m = text.match(RE_SIG_FCT);
    } else if (kind === 'prog') {
        m = text.match(RE_SIG_DEF);
    } else if (kind === 'defdat') {
        m = text.match(RE_SIG_DAT);
    }
    if (!m) { return null; }
    if (kind === 'fct') {
        return { name: m[2].toLowerCase(), returnType: m[1].toUpperCase(), params: parseParams(m[3]) };
    }
    if (kind === 'defdat') {
        return { name: m[1].toLowerCase(), returnType: '', params: [] };
    }
    return { name: m[1].toLowerCase(), returnType: '', params: parseParams(m[2]) };
}

function parseParams(paramText: string): KrlParam[] {
    const out: KrlParam[] = [];
    if (!paramText.trim()) { return out; }
    for (const chunk of splitTopLevel(paramText, ',')) {
        const part = chunk.trim();
        if (!part) { continue; }
        let dir: KrlParam['dir'] = '';
        let core = part;
        const dirM = part.match(/^(.+):(IN|OUT|INOUT)$/i);
        if (dirM) { core = dirM[1].trim(); dir = dirM[2].toUpperCase() as KrlParam['dir']; }
        const toks = core.split(/\s+/).filter(Boolean);
        if (toks.length === 0) { continue; }
        if (toks.length >= 2 && /^(INT|REAL|BOOL|CHAR|STRING|FRAME|POS|E6POS|E6AXIS|AXIS|A6POS|A6AXIS|ENUM|STRUC|ANY)$/i.test(toks[0])) {
            out.push({ name: toks[toks.length - 1].toLowerCase(), type: toks[0].toUpperCase(), dir });
        } else {
            out.push({ name: toks[toks.length - 1].toLowerCase(), type: 'ANY', dir });
        }
    }
    return out;
}

/** Split on a separator character that is outside strings/brackets/parens. */
export function splitTopLevel(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === quote) { inString = false; quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { inString = true; quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (c === sep && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}


// ---------------------------------------------------------------------------
// full program parsing

export function parseKrlProgram(programPath: string, source: string): KrlProgram {
    const rawLines = source.split(/\r?\n/);
    const stmts: KrlStmt[] = [];
    const lineToIndex: number[] = new Array(rawLines.length).fill(-1);
    rawLines.forEach((raw, line) => {
        const text = raw.trim();
        if (text === '' || text.startsWith(';') || text.startsWith('&')) {
            return;
        }
        const kind = classifyLine(text);
        lineToIndex[line] = stmts.length;
        stmts.push({ kind, line, text });
    });

    const prog: KrlProgram = {
        path: programPath, stmts, lineToIndex,
        funcs: new Map(),
        firstProgramIndex: -1,
        ifFalseToElse: new Map(),
        ifAfter: new Map(),
        forEnd: new Map(),
        forStart: new Map(),
        whileEnd: new Map(),
        whileStart: new Map(),
        loopEnd: new Map(),
        loopStart: new Map(),
        repeatUntil: new Map(),
        untilRepeat: new Map(),
        switchEnd: new Map(),
        switchCases: new Map(),
        switchDefault: new Map(),
        fctEnd: new Map(),
    };

    interface StackEntry { kind: KrlStmtKind; idx: number; }
    const stack: StackEntry[] = [];
    let currentSwitch: number | null = null;

    for (let i = 0; i < stmts.length; i++) {
        const st = stmts[i];

        // resolve function opener links for 'end'/'endfct'/'enddat'
        if (st.kind === 'end' || st.kind === 'endfct' || st.kind === 'enddat') {
            let depth = 0;
            for (let j = i - 1; j >= 0; j--) {
                const s = stmts[j];
                if (s.kind === 'end' || s.kind === 'endfct' || s.kind === 'enddat') { depth++; continue; }
                if (s.kind === 'prog' || s.kind === 'fct' || s.kind === 'defdat') {
                    if (depth === 0) { prog.fctEnd.set(j, i); break; }
                    depth--;
                }
            }
        }

        switch (st.kind) {
            case 'prog': case 'fct': case 'defdat': {
                // functions/programs are top-level nodes: reset the block stack
                stack.length = 0;
                const sig = parseSignature(st.kind, st.text);
                const info: KrlFunctionInfo = {
                    name: sig ? sig.name : `anon${i}`,
                    displayName: sig ? sig.name.toUpperCase() : `ANON${i}`,
                    kind: st.kind,
                    startIdx: i,
                    endIdx: prog.fctEnd.get(i) ?? -1,
                    returnType: sig ? sig.returnType : '',
                    params: sig ? sig.params : [],
                };
                if (!prog.funcs.has(info.name)) { prog.funcs.set(info.name, info); }
                if (st.kind === 'prog' && prog.firstProgramIndex < 0) { prog.firstProgramIndex = i; }
                stack.push({ kind: st.kind, idx: i });
                break;
            }
            case 'end': case 'endfct': case 'enddat': {
                stack.length = 0;
                currentSwitch = null;
                break;
            }
            case 'if': stack.push({ kind: 'if', idx: i }); break;
            case 'else': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'if') {
                        prog.ifFalseToElse.set(stack[s].idx, i);
                        break;
                    }
                }
                break;
            }
            case 'endif': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'if') {
                        const ifIdx = stack[s].idx;
                        prog.ifAfter.set(ifIdx, i);
                        const elseIdx = prog.ifFalseToElse.get(ifIdx);
                        if (elseIdx !== undefined) { prog.ifAfter.set(elseIdx, i); }
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }
            case 'for': stack.push({ kind: 'for', idx: i }); break;
            case 'endfor': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'for') {
                        prog.forEnd.set(stack[s].idx, i);
                        prog.forStart.set(i, stack[s].idx);
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }
            case 'while': stack.push({ kind: 'while', idx: i }); break;
            case 'endwhile': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'while') {
                        prog.whileEnd.set(stack[s].idx, i);
                        prog.whileStart.set(i, stack[s].idx);
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }

            case 'loop': stack.push({ kind: 'loop', idx: i }); break;
            case 'endloop': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'loop') {
                        prog.loopEnd.set(stack[s].idx, i);
                        prog.loopStart.set(i, stack[s].idx);
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }
            case 'repeat': stack.push({ kind: 'repeat', idx: i }); break;
            case 'until': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'repeat') {
                        prog.repeatUntil.set(stack[s].idx, i);
                        prog.untilRepeat.set(i, stack[s].idx);
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }
            case 'switch':
                stack.push({ kind: 'switch', idx: i });
                currentSwitch = i;
                prog.switchCases.set(i, []);
                break;
            case 'case': case 'default': {
                if (currentSwitch !== null) {
                    if (st.kind === 'default') {
                        prog.switchDefault.set(currentSwitch, i);
                    } else {
                        const value = st.text.replace(/^\s*CASE\s+/i, '').trim();
                        const cases = prog.switchCases.get(currentSwitch);
                        if (cases) { cases.push({ caseIdx: i, value }); }
                    }
                }
                break;
            }
            case 'endswitch': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'switch') {
                        prog.switchEnd.set(stack[s].idx, i);
                        currentSwitch = null;
                        stack.splice(s, 1);
                        break;
                    }
                }
                break;
            }
            default: break;
        }
    }
    return prog;
}

