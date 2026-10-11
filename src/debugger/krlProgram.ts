// krlProgram.ts
// Parses KRL source code (.src / .sub / .dat) into executable statements and
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
    | 'exit' | 'goto' | 'label' | 'halt'
    | 'decl' | 'struc' | 'enumdef' | 'signal'
    | 'assign' | 'call' | 'return' | 'motion' | 'wait' | 'other';

export interface KrlStmt {
    kind: KrlStmtKind;
    /** 0-based source line number */
    line: number;
    /** trimmed source line without its trailing comment */
    text: string;
}

export interface KrlParam {
    name: string;
    /** '' means no direction given; KRL then passes by reference like OUT */
    dir: 'IN' | 'OUT' | '';
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
    /** declared with the GLOBAL keyword */
    isGlobal: boolean;
}

export interface KrlSwitchCase {
    caseIdx: number;
    /** one entry per value of `CASE 3,4,5` */
    values: string[];
}

export interface KrlProgram {
    path: string;
    stmts: KrlStmt[];
    /** per source line -> statement index or -1 */
    lineToIndex: number[];
    /** functions / programs by lowercased name */
    funcs: Map<string, KrlFunctionInfo>;
    /** first DEF/DEFFCT of the file: the module routine visible to other files */
    moduleRoutine: KrlFunctionInfo | null;

    // control-flow maps (statement index -> statement index)
    ifFalseToElse: Map<number, number>;   // IF -> ELSE
    ifAfter: Map<number, number>;         // IF -> ENDIF ; ELSE -> ENDIF
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
    /** CASE / DEFAULT -> ENDSWITCH (reaching the next block label leaves the SWITCH) */
    caseEnd: Map<number, number>;
    /** EXIT -> statement closing the innermost loop (ENDFOR/ENDWHILE/ENDLOOP/UNTIL) */
    exitTarget: Map<number, number>;
    /** `${routineStartIdx}:${label}` -> label statement index */
    labels: Map<string, number>;
    fctEnd: Map<number, number>;
    /** statements whose advance run stop is cancelled by a CONTINUE in the line before */
    continued: Set<number>;
    /** statements after ON_ERROR_PROCEED: an error does not stop the program, it is reported in $ERR */
    errorProceed: Set<number>;
}

// ---------------------------------------------------------------------------
// line classification

const RE_ENDDAT = /^ENDDAT\b/i;
const RE_ENDFCT = /^ENDFCT\b/i;
const RE_END = /^END\b/i;
const RE_DAT = /^(?:GLOBAL\s+)?DEFDAT\b/i;
const RE_FCT = /^(?:GLOBAL\s+)?DEFFCT\b/i;
const RE_DEF = /^(?:GLOBAL\s+)?DEF\b/i;
const RE_IF = /^IF\b/i;
const RE_ELSE = /^ELSE\b/i;
const RE_ENDIF = /^ENDIF\b/i;
const RE_FOR = /^FOR\b/i;
const RE_ENDFOR = /^ENDFOR\b/i;
const RE_WHILE = /^WHILE\b/i;
const RE_ENDWHILE = /^ENDWHILE\b/i;
const RE_LOOP = /^LOOP\b/i;
const RE_ENDLOOP = /^ENDLOOP\b/i;
const RE_REPEAT = /^REPEAT\b/i;
const RE_UNTIL = /^UNTIL\b/i;
const RE_SWITCH = /^SWITCH\b/i;
const RE_CASE = /^CASE\b/i;
const RE_DEFAULT = /^DEFAULT\b/i;
const RE_ENDSWITCH = /^ENDSWITCH\b/i;
const RE_RETURN = /^RETURN\b/i;
const RE_WAIT = /^WAIT\b/i;
const RE_EXIT = /^EXIT\s*$/i;
const RE_HALT = /^HALT\s*$/i;
const RE_GOTO = /^GOTO\s+[A-Z_$][\w$]*\s*$/i;
const RE_LABEL = /^[A-Z_$][\w$]*\s*:$/i;
const RE_MOTION = /^(?:PTP|LIN|CIRC|SPTP|SLIN|SCIRC|PTP_REL|LIN_REL|CIRC_REL|SPTP_REL|SLIN_REL)\b/i;
/** statements that are accepted but have no effect in the simulation */
const RE_IGNORED = /^(?:GLOBAL\s+)?(?:INTERRUPT|TRIGGER|ON_ERROR_PROCEED|CONTINUE|BRAKE|RESUME|CONFIRM|ANIN|ANOUT|EXT|EXTFCT|IMPORT)\b/i;
const RE_STRUC = /^(?:GLOBAL\s+)?STRUC\b/i;
const RE_ENUMDEF = /^(?:GLOBAL\s+)?ENUM\b/i;
const RE_SIGNAL = /^(?:GLOBAL\s+)?SIGNAL\b/i;
/** DECL may be omitted only for the predefined data types (manual 2.2.1) */
const RE_DECL = /^(?:GLOBAL\s+)?(?:DECL\b|(?:CONST\s+)?(?:INT|REAL|BOOL|CHAR|FRAME|POS|E6POS|E6AXIS|AXIS|A6POS|A6AXIS)\s+[A-Z_$])/i;
const RE_CALL = /^[A-Z_$][\w$]*\s*\(/i;
const RE_SINGLE_EQ = /(^|[^=!<>])=(?!=)/;

/** Strip an inline comment (';' outside of string literals). */
export function stripComment(line: string): string {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ';') { return line.slice(0, i).trimEnd(); }
    }
    return line;
}

export function classifyLine(raw: string): KrlStmtKind {
    const text = stripComment(raw.trim());
    if (text === '') { return 'other'; }
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
    if (RE_EXIT.test(text)) { return 'exit'; }
    if (RE_HALT.test(text)) { return 'halt'; }
    if (RE_GOTO.test(text)) { return 'goto'; }
    if (RE_LABEL.test(text)) { return 'label'; }
    if (RE_MOTION.test(text)) { return 'motion'; }
    if (RE_IGNORED.test(text)) { return 'other'; }
    if (RE_STRUC.test(text)) { return 'struc'; }
    if (RE_ENUMDEF.test(text)) { return 'enumdef'; }
    if (RE_SIGNAL.test(text)) { return 'signal'; }
    if (RE_DECL.test(text)) { return 'decl'; }
    if (RE_CALL.test(text)) { return 'call'; }
    if (RE_SINGLE_EQ.test(text)) { return 'assign'; }
    return 'other';
}

const RE_SIG_FCT = /^(GLOBAL\s+)?DEFFCT\b\s+([A-Z_$][\w$]*)\s+([A-Z_$][\w$]*)\s*\(([^)]*)\)/i;
const RE_SIG_DEF = /^(GLOBAL\s+)?DEF\b\s+([A-Z_$][\w$]*)\s*\(([^)]*)\)/i;
const RE_SIG_DAT = /^(GLOBAL\s+)?DEFDAT\b\s+([A-Z_$][\w$]*)/i;

export function parseSignature(kind: KrlStmtKind, text: string):
    { name: string; returnType: string; params: KrlParam[]; isGlobal: boolean } | null {
    if (kind === 'fct') {
        const m = text.match(RE_SIG_FCT);
        return m ? { name: m[3].toLowerCase(), returnType: m[2].toUpperCase(), params: parseParams(m[4]), isGlobal: !!m[1] } : null;
    }
    if (kind === 'prog') {
        const m = text.match(RE_SIG_DEF);
        return m ? { name: m[2].toLowerCase(), returnType: '', params: parseParams(m[3]), isGlobal: !!m[1] } : null;
    }
    if (kind === 'defdat') {
        const m = text.match(RE_SIG_DAT);
        return m ? { name: m[2].toLowerCase(), returnType: '', params: [], isGlobal: !!m[1] } : null;
    }
    return null;
}

function parseParams(paramText: string): KrlParam[] {
    const out: KrlParam[] = [];
    if (!paramText.trim()) { return out; }
    for (const chunk of splitTopLevel(paramText, ',')) {
        const part = chunk.trim();
        if (!part) { continue; }
        let dir: KrlParam['dir'] = '';
        let core = part;
        const dirM = part.match(/^(.+?)\s*:\s*(IN|OUT)$/i);
        if (dirM) { core = dirM[1].trim(); dir = dirM[2].toUpperCase() as KrlParam['dir']; }
        const toks = core.split(/\s+/).filter(Boolean);
        if (toks.length === 0) { continue; }
        out.push({ name: toks[toks.length - 1].replace(/\[.*$/, '').toLowerCase(), dir });
    }
    return out;
}

/** Split on a separator character that is outside strings/brackets/parens. */
export function splitTopLevel(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
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

/** Index of the bracket closing the one at `open`, or -1. */
export function findClosing(text: string, open: number): number {
    let depth = 0;
    let quote = '';
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}


// ---------------------------------------------------------------------------
// full program parsing

export function parseKrlProgram(programPath: string, source: string): KrlProgram {
    const rawLines = source.split(/\r?\n/);
    const stmts: KrlStmt[] = [];
    const lineToIndex: number[] = new Array(rawLines.length).fill(-1);
    rawLines.forEach((raw, line) => {
        const text = stripComment(raw.trim());
        if (text === '' || text.startsWith('&')) {
            return;
        }
        const kind = classifyLine(text);
        lineToIndex[line] = stmts.length;
        stmts.push({ kind, line, text });
    });

    const prog: KrlProgram = {
        path: programPath, stmts, lineToIndex,
        funcs: new Map(),
        moduleRoutine: null,
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
        caseEnd: new Map(),
        exitTarget: new Map(),
        labels: new Map(),
        fctEnd: new Map(),
        continued: new Set(),
        errorProceed: new Set(),
    };

    // CONTINUE cancels the advance run stop of the following line, even a blank one; when that
    // line holds ON_ERROR_PROCEED, it applies to the line after (KSS 8.3 manual 11.7.1)
    rawLines.forEach((raw, line) => {
        if (!/^CONTINUE\s*$/i.test(stripComment(raw.trim()))) { return; }
        let next = line + 1;
        if (/^ON_ERROR_PROCEED\b/i.test(stripComment((rawLines[next] ?? '').trim()))) { next++; }
        const idx = lineToIndex[next] ?? -1;
        if (idx >= 0) { prog.continued.add(idx); }
    });
    // ON_ERROR_PROCEED applies to the next line (a CONTINUE may stand in between)
    rawLines.forEach((raw, line) => {
        if (!/^ON_ERROR_PROCEEDs*$/i.test(stripComment(raw.trim()))) { return; }
        let next = line + 1;
        if (/^CONTINUEs*$/i.test(stripComment((rawLines[next] ?? '').trim()))) { next++; }
        const idx = lineToIndex[next] ?? -1;
        if (idx >= 0) { prog.errorProceed.add(idx); }
    });

    interface StackEntry { kind: KrlStmtKind; idx: number; }
    const stack: StackEntry[] = [];
    /** EXIT statements waiting for the end of their loop, keyed by loop start */
    const pendingExits = new Map<number, number[]>();
    /** CASE/DEFAULT statements waiting for their ENDSWITCH, keyed by SWITCH */
    const pendingCases = new Map<number, number[]>();
    let routineStart = -1;

    const closeBlock = (kind: KrlStmtKind, i: number): number => {
        for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].kind === kind) {
                const startIdx = stack[s].idx;
                stack.splice(s, 1);
                for (const e of pendingExits.get(startIdx) ?? []) { prog.exitTarget.set(e, i); }
                pendingExits.delete(startIdx);
                return startIdx;
            }
        }
        return -1;
    };

    for (let i = 0; i < stmts.length; i++) {
        const st = stmts[i];
        switch (st.kind) {
            case 'prog': case 'fct': case 'defdat': {
                // routines are top-level nodes: reset the block stack
                stack.length = 0;
                routineStart = i;
                const sig = parseSignature(st.kind, st.text);
                const info: KrlFunctionInfo = {
                    name: sig ? sig.name : `anon${i}`,
                    displayName: sig ? sig.name.toUpperCase() : `ANON${i}`,
                    kind: st.kind,
                    startIdx: i,
                    endIdx: -1,
                    returnType: sig ? sig.returnType : '',
                    params: sig ? sig.params : [],
                    isGlobal: sig ? sig.isGlobal : false,
                };
                if (!prog.funcs.has(info.name)) { prog.funcs.set(info.name, info); }
                if (st.kind !== 'defdat' && !prog.moduleRoutine) { prog.moduleRoutine = info; }
                stack.push({ kind: st.kind, idx: i });
                break;
            }
            case 'end': case 'endfct': case 'enddat': {
                if (routineStart >= 0) {
                    prog.fctEnd.set(routineStart, i);
                    for (const f of prog.funcs.values()) {
                        if (f.startIdx === routineStart) { f.endIdx = i; }
                    }
                }
                routineStart = -1;
                stack.length = 0;
                break;
            }
            case 'label': {
                const name = st.text.replace(/\s*:$/, '').toLowerCase();
                prog.labels.set(`${routineStart}:${name}`, i);
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
                const ifIdx = closeBlock('if', i);
                if (ifIdx >= 0) {
                    prog.ifAfter.set(ifIdx, i);
                    const elseIdx = prog.ifFalseToElse.get(ifIdx);
                    if (elseIdx !== undefined) { prog.ifAfter.set(elseIdx, i); }
                }
                break;
            }
            case 'for': stack.push({ kind: 'for', idx: i }); break;
            case 'endfor': {
                const s = closeBlock('for', i);
                if (s >= 0) { prog.forEnd.set(s, i); prog.forStart.set(i, s); }
                break;
            }
            case 'while': stack.push({ kind: 'while', idx: i }); break;
            case 'endwhile': {
                const s = closeBlock('while', i);
                if (s >= 0) { prog.whileEnd.set(s, i); prog.whileStart.set(i, s); }
                break;
            }
            case 'loop': stack.push({ kind: 'loop', idx: i }); break;
            case 'endloop': {
                const s = closeBlock('loop', i);
                if (s >= 0) { prog.loopEnd.set(s, i); prog.loopStart.set(i, s); }
                break;
            }
            case 'repeat': stack.push({ kind: 'repeat', idx: i }); break;
            case 'until': {
                const s = closeBlock('repeat', i);
                if (s >= 0) { prog.repeatUntil.set(s, i); prog.untilRepeat.set(i, s); }
                break;
            }
            case 'exit': {
                for (let s = stack.length - 1; s >= 0; s--) {
                    const k = stack[s].kind;
                    if (k === 'for' || k === 'while' || k === 'loop' || k === 'repeat') {
                        const list = pendingExits.get(stack[s].idx) ?? [];
                        list.push(i);
                        pendingExits.set(stack[s].idx, list);
                        break;
                    }
                }
                break;
            }
            case 'switch':
                stack.push({ kind: 'switch', idx: i });
                prog.switchCases.set(i, []);
                pendingCases.set(i, []);
                break;
            case 'case': case 'default': {
                let sw = -1;
                for (let s = stack.length - 1; s >= 0; s--) {
                    if (stack[s].kind === 'switch') { sw = stack[s].idx; break; }
                }
                if (sw < 0) { break; }
                pendingCases.get(sw)?.push(i);
                if (st.kind === 'default') {
                    prog.switchDefault.set(sw, i);
                } else {
                    const values = splitTopLevel(st.text.replace(/^CASE\b/i, ''), ',')
                        .map(v => v.trim()).filter(Boolean);
                    prog.switchCases.get(sw)?.push({ caseIdx: i, values });
                }
                break;
            }
            case 'endswitch': {
                const s = closeBlock('switch', i);
                if (s >= 0) {
                    prog.switchEnd.set(s, i);
                    for (const c of pendingCases.get(s) ?? []) { prog.caseEnd.set(c, i); }
                    pendingCases.delete(s);
                }
                break;
            }
            default: break;
        }
    }
    return prog;
}
