// krlDiagnostics.ts
// Checks of a KRL file that need the project: names that are not declared
// (with the point names of motions in particular), declarations nobody uses,
// write-protected system variables, I/O indices out of range, velocities above
// the configured limits, FOR counters that are not INT, duplicate declarations,
// unknown labels and routines, names written in another case than declared.
// Adds them to the syntax issues of the parser. Pure logic (no vscode imports).

import { KrlDocument, KrlIssue, KrlDecl, Tok, Span, routineAt } from './krlSyntax';
import { KrlProject, KrlSymbol } from './krlProject';
import { isStandardConfigName } from './krlStandardConfig';
import {
    builtinRoutine, isWriteProtected, systemVariable, motionInfo, SIMULATOR_FUNCTIONS, KEYWORDS,
} from './krlCatalog';
import { evaluateExpression } from '../debugger/krlExpr';
import { KrlValue } from '../debugger/krlValue';

export interface DiagnosticSettings {
    /** highest Cartesian velocity ($VEL.CP, CP inline forms) in m/s before a warning */
    maxCartesianVelocity: number;
    /** number of digital inputs / outputs ($IN, $OUT) of the controller */
    ioCount: number;
    /** report names that are not declared (only in projects with $config.dat) */
    undeclared: boolean;
    /** mark declarations that are never used */
    unused: boolean;
    /** warn about names written in another case than declared (KRL ignores the case) */
    nameCase: boolean;
    /** warn about names declared only where the file does not see them (another module's data list, another routine) */
    declaredElsewhere: boolean;
}

export const DEFAULT_DIAGNOSTIC_SETTINGS: DiagnosticSettings = {
    maxCartesianVelocity: 2.0,
    ioCount: 4096,
    undeclared: true,
    unused: true,
    nameCase: false,
    declaredElsewhere: true,
};

const span = (line: number, t: Tok): Span => ({ line, start: t.start, end: t.end });

/** Value of a constant expression (literals and operators only), or null. */
export function constantValue(text: string): number | null {
    // a variable or function is not known here, and the operators would take it as 0
    // (`VEL*RedVelExAx[I]/100.0` of BAS.SRC is no constant 0)
    let constant = true;
    const unknown = () => { constant = false; return null; };
    const v: KrlValue = evaluateExpression(text, { resolveName: unknown, invokeFunction: unknown });
    return constant && (v.t === 'int' || v.t === 'real') ? v.v : null;
}

/** Point names a motion statement moves to: its target, for CIRC the auxiliary point too. */
export function motionTargets(doc: KrlDocument, line: number): Tok[] {
    const toks = doc.lines[line].tokens;
    const info = motionInfo(toks[0]?.text ?? '');
    if (!info) { return []; }
    const out: Tok[] = [];
    let depth = 0;
    let expectTarget = true;
    for (let i = 1; i < toks.length && out.length < info.points; i++) {
        const t = toks[i];
        if (t.kind === 'op') {
            if ('([{'.includes(t.text)) { depth++; }
            if (')]}'.includes(t.text)) { depth--; }
            if (t.text === ',' && depth === 0) { expectTarget = true; continue; }
            expectTarget = false;
            continue;
        }
        if (/^(WITH|C_PTP|C_DIS|C_VEL|C_ORI|C_SPL|CA)$/i.test(t.text)) { break; }
        if (expectTarget && depth === 0 && t.kind === 'id' && !KEYWORDS.has(t.text.toLowerCase())) { out.push(t); }
        expectTarget = false;
    }
    return out;
}

export function computeDiagnostics(project: KrlProject, filePath: string, settings: DiagnosticSettings = DEFAULT_DIAGNOSTIC_SETTINGS): KrlIssue[] {
    const doc = project.document(filePath);
    if (!doc) { return []; }
    const issues: KrlIssue[] = [...doc.issues];
    const add = (s: Span, severity: KrlIssue['severity'], code: string, message: string, data?: KrlIssue['data'], unnecessary?: boolean) =>
        issues.push({ ...s, severity, code, message, data, unnecessary });
    const complete = !!project.projectInfo(filePath).configDat;

    checkNames(project, doc, settings, complete, add);
    if (settings.unused) { checkUnused(project, doc, add); }
    checkSystemVariables(doc, settings, add);
    checkVelocities(doc, settings, add);
    checkDuplicates(doc, add);
    checkForCounters(project, doc, add);
    checkWholeArrays(project, doc, add);
    return issues;
}

/**
 * `NAME[]` without an index is the whole array. Only CHAR arrays (strings) can be
 * used like that, and any array can be passed whole to a subprogram (an OUT
 * parameter: CALC(name[]), KSS 8.3 manual 11.9). Elsewhere an index is needed:
 * `COUNTS[] = 0` or `$OUT[] = TRUE` are errors.
 */
function checkWholeArrays(project: KrlProject, doc: KrlDocument, add: Add): void {
    doc.lines.forEach((L, ln) => {
        if (!/^(assign|call|if|while|until|for|wait|switch|case|return|motion|interrupt|trigger|other)$/.test(L.kind)) { return; }
        const toks = L.tokens;
        const brackets: { text: string; index: number }[] = [];
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.kind === 'op' && '([{'.includes(t.text)) { brackets.push({ text: t.text, index: i }); }
            if (t.kind === 'op' && ')]}'.includes(t.text)) { brackets.pop(); }
            if ((t.kind !== 'id' && t.kind !== 'sys') || toks[i + 1]?.text !== '[') { continue; }
            // an index of only commas: NAME[] or NAME[,]
            let close = i + 2;
            while (toks[close]?.text === ',') { close++; }
            if (toks[close]?.text !== ']') { continue; }
            // the start of the access path: A.B[1].NAME[]
            let s = i;
            while (toks[s - 1]?.text === '.' && s >= 2) {
                let j = s - 2;
                if (toks[j].text === ']') {
                    let depth = 0;
                    for (; j >= 0; j--) {
                        if (toks[j].text === ']') { depth++; }
                        if (toks[j].text === '[' && --depth === 0) { break; }
                    }
                    j--;
                }
                if (j < 0 || (toks[j].kind !== 'id' && toks[j].kind !== 'sys')) { break; }
                s = j;
            }
            const before = toks[s - 1];
            const after = toks[close + 1];
            const inner = brackets[brackets.length - 1];
            // a member of an aggregate: {POINT2[] " "}
            if (inner?.text === '{' && (before?.text === '{' || before?.text === ',')) { continue; }
            // passed whole to a subprogram: CALC(NAME[])
            const isCall = inner?.text === '(' && toks[inner.index - 1]?.kind !== 'op';
            if (isCall && (before?.text === '(' || before?.text === ',') && (after?.text === ',' || after?.text === ')')) { continue; }
            const pathText = L.code.slice(toks[s].start, t.end);
            const type = project.typeOfPath(doc.path, ln, pathText);
            if (!type || type === 'CHAR') { continue; }
            add({ line: ln, start: toks[s].start, end: toks[close].end }, 'error', 'wholeArray',
                `${pathText}[] has no index: only CHAR arrays (strings) can be used without one (or passed whole to a subprogram); use ${pathText}[i]`);
        }
    });
}

type Add = (s: Span, severity: KrlIssue['severity'], code: string, message: string, data?: KrlIssue['data'], unnecessary?: boolean) => void;

/** A name as its declaration writes it. */
function declaredName(symbol: KrlSymbol): string {
    switch (symbol.kind) {
        case 'decl': return symbol.decl.name;
        case 'param': return symbol.param.name;
        case 'routine': return symbol.routine.name;
        case 'type': return symbol.type.name;
        case 'label': return symbol.label.name;
    }
}

/** A name written in another case than declared: KRL ignores the case, so it is a warning only. */
function checkCase(ref: Span & { name: string }, declared: string, settings: DiagnosticSettings, add: Add): void {
    if (settings.nameCase && ref.name !== declared) {
        add(ref, 'warning', 'nameCase', `${ref.name} is declared as ${declared} (KRL ignores the case)`, { name: declared });
    }
}

/** Undeclared variables and points, unknown routines and labels, too many arguments, the case of names. */
function checkNames(project: KrlProject, doc: KrlDocument, settings: DiagnosticSettings, complete: boolean, add: Add): void {
    const targets = new Map<string, Tok>();
    doc.lines.forEach((L, ln) => {
        if (L.kind === 'motion') { for (const t of motionTargets(doc, ln)) { targets.set(`${ln}:${t.start}`, t); } }
    });
    const datName = project.companionDatPath(doc.path).replace(/^.*[\\/]/, '');
    for (const ref of doc.refs) {
        switch (ref.role) {
            case 'read': case 'write': {
                const symbol = project.resolveVariable(doc.path, ref.line, ref.name)
                    ?? project.resolveRoutine(doc.path, ref.name) ?? project.resolveType(doc.path, ref.name);
                if (symbol) { checkCase(ref, declaredName(symbol), settings, add); break; }
                const motion = doc.lines[ref.line].tokens[0]?.text.toUpperCase() ?? '';
                if (!settings.undeclared) { break; }
                // declared, but where this file does not see it: another module's data list (not GLOBAL) or another routine
                const elsewhere = project.declarationAnywhere(doc.path, ref.name);
                if (elsewhere?.kind === 'decl') {
                    if (settings.declaredElsewhere) {
                        const d = elsewhere.decl;
                        const file = elsewhere.doc.path.replace(/^.*[\\/]/, '');
                        add(ref, 'warning', 'declaredElsewhere', d.routine
                            ? `${ref.name} is declared in routine ${d.routine.name} (${file}), not where it is used`
                            : `${ref.name} is declared in ${file}, which other modules do not see (${d.isGlobal ? 'the data list is not PUBLIC' : 'it is not GLOBAL'})`,
                        { name: ref.name, type: d.type, dims: d.dims, dat: datName });
                    }
                    break;
                }
                // the controller does not accept the program; a KUKA name of $config.dat is missing with that file
                if (!complete && isStandardConfigName(ref.name)) {
                    add(ref, 'error', 'undeclared', `${ref.name} is not declared: KUKA declares it in $config.dat, which is not in this workspace`);
                } else if (targets.has(`${ref.line}:${ref.start}`)) {
                    add(ref, 'error', 'undeclaredPoint', `Point ${ref.name} is not declared`,
                        { name: ref.name, type: /PTP/.test(motion) && /^X?HOME/i.test(ref.name) ? 'E6AXIS' : 'E6POS', dat: datName });
                } else {
                    add(ref, 'error', 'undeclared', `${ref.name} is not declared`, { name: ref.name });
                }
                break;
            }
            case 'call': {
                const routine = project.resolveRoutine(doc.path, ref.name);
                if (routine) {
                    checkCase(ref, declaredName(routine), settings, add);
                    if (routine.kind === 'routine') { checkArgumentCount(doc, ref, routine.routine.params.length, add); }
                    break;
                }
                if (builtinRoutine(ref.name) || SIMULATOR_FUNCTIONS.has(ref.key)) { break; }
                if (settings.undeclared) {
                    add(ref, 'error', 'unknownRoutine', !complete && isStandardConfigName(ref.name)
                        ? `Unknown routine ${ref.name}: KUKA declares it in $config.dat, which is not in this workspace`
                        : `Unknown routine ${ref.name}`, { name: ref.name });
                }
                break;
            }
            case 'goto': {
                const label = project.resolveLabel(doc.path, ref.line, ref.name);
                if (label) {
                    checkCase(ref, declaredName(label), settings, add);
                } else {
                    add(ref, 'error', 'unknownLabel', `Label ${ref.name} is not defined in this routine`);
                }
                break;
            }
            default: break;
        }
    }
}

/** A call with more arguments than the routine has parameters. */
function checkArgumentCount(doc: KrlDocument, ref: Span & { name: string }, paramCount: number, add: Add): void {
    const toks = doc.lines[ref.line].tokens;
    const open = toks.findIndex(t => t.start >= ref.end && t.text === '(');
    if (open < 0) { return; }
    let depth = 0;
    let args = 0;
    let empty = true;
    for (let i = open; i < toks.length; i++) {
        const t = toks[i].text;
        if (toks[i].kind === 'op' && '([{'.includes(t)) { depth++; if (depth === 1) { continue; } }
        if (toks[i].kind === 'op' && ')]}'.includes(t)) {
            depth--;
            if (depth === 0) {
                if (!empty || args > 0) { args++; }
                break;
            }
        }
        if (depth === 1 && t === ',' && toks[i].kind === 'op') { args++; continue; }
        if (depth >= 1) { empty = false; }
    }
    if (args > paramCount) {
        add(ref, 'error', 'argumentCount', `${ref.name} takes ${paramCount} argument${paramCount === 1 ? '' : 's'}, but ${args} are passed`);
    }
}

/** Declarations that nothing refers to: locals of routines, and data list entries of a module. */
function checkUnused(project: KrlProject, doc: KrlDocument, add: Add): void {
    const usedHere = new Set<string>();
    for (const ref of doc.refs) { usedHere.add(`${ref.routine ? ref.routine.line : -1}:${ref.key}`); }
    for (const d of doc.decls) {
        if (!d.routine || (d.kind !== 'var' && d.kind !== 'const' && d.kind !== 'signal')) { continue; }
        if (!usedHere.has(`${d.routine.line}:${d.key}`)) {
            add(d, 'hint', 'unused', `${d.name} is declared but never used`, { name: d.name }, true);
        }
    }
    // data list entries (not GLOBAL) are visible only in their module
    if (doc.fileKind !== 'dat' || !doc.defdat) { return; }
    const src = project.companionSource(doc.path);
    if (!src) { return; }
    const used = new Set<KrlDecl>();
    for (const ref of src.refs) {
        if (ref.role !== 'read' && ref.role !== 'write') { continue; }
        const sym = project.resolveVariable(src.path, ref.line, ref.name);
        if (sym?.kind === 'decl') { used.add(sym.decl); }
    }
    const inDat = new Set(doc.refs.map(r => r.key));
    for (const d of doc.decls) {
        if (d.routine || d.isGlobal || (d.kind !== 'var' && d.kind !== 'const' && d.kind !== 'signal')) { continue; }
        // LAST_BASIS, LAST_GRP, ...: the smartPAD's suggestions for the next inline form
        if (/_SUGG_T$/i.test(d.type)) { continue; }
        if (used.has(d) || inDat.has(d.key)) { continue; }
        add(d, 'hint', 'unused', `${d.name} is not used in ${src.path.replace(/^.*[\\/]/, '')}`, { name: d.name }, true);
    }
}

/** Write-protected system variables, I/O indices out of range, the case of the names. */
function checkSystemVariables(doc: KrlDocument, settings: DiagnosticSettings, add: Add): void {
    for (const ref of doc.sysRefs) {
        if (ref.write && isWriteProtected(ref.name)) {
            add(ref, 'error', 'writeProtected', `${ref.name.toUpperCase()} is write-protected`);
        }
        const sys = systemVariable(ref.name);
        if (sys) { checkCase(ref, sys.name, settings, add); }
        if (Number.isNaN(ref.index) || !sys?.index) { continue; }
        const isDigitalIo = /^\$(IN|OUT|OUT_C)$/i.test(ref.name);
        const max = isDigitalIo ? Math.min(settings.ioCount, sys.index[1]) : sys.index[1];
        if (ref.index < sys.index[0] || ref.index > max) {
            add({ line: ref.line, start: ref.start, end: closingBracketEnd(doc, ref) }, 'error', 'ioRange',
                `${ref.name.toUpperCase()}[${ref.index}] is out of range (${sys.index[0]} … ${max})`);
        }
    }
}

function closingBracketEnd(doc: KrlDocument, ref: Span): number {
    const toks = doc.lines[ref.line].tokens;
    const close = toks.find(t => t.start > ref.start && t.text === ']');
    return close ? close.end : ref.end;
}

/**
 * Velocities above the limits: $VEL.CP and the CP inline forms in m/s, PTP
 * velocities, $OV_PRO and $ADVANCE outside of their ranges.
 */
function checkVelocities(doc: KrlDocument, settings: DiagnosticSettings, add: Add): void {
    const vmax = settings.maxCartesianVelocity;
    const cpLimit = (value: number, s: Span, what: string) => {
        if (value > vmax) {
            add(s, 'warning', 'velocityLimit', `${what} ${value} m/s exceeds the limit of ${vmax} m/s (setting krl-officelite.safety.maxCartesianVelocity)`);
        }
    };
    const rangeCheck = (name: string, value: number, s: Span) => {
        const sys = systemVariable(name);
        if (!sys?.range) { return; }
        const [lo, hi] = sys.range;
        if (value < lo || value > hi) {
            add(s, 'warning', 'valueRange', `${sys.name} = ${value} is outside of ${lo} … ${hi}${sys.unit ? ' ' + sys.unit : ''}`);
        }
    };

    doc.lines.forEach((L, ln) => {
        const toks = L.tokens;
        if (toks.length === 0) { return; }
        // assignments, also those in the WITH clause of motions: <target> = <expression>
        for (let i = 0; i < toks.length; i++) {
            if (toks[i].kind !== 'sys') { continue; }
            const assign = assignmentAt(L.code, toks, i);
            if (!assign) { continue; }
            const name = toks[i].text.toUpperCase();
            const valueSpan: Span = { line: ln, start: assign.valueStart, end: assign.valueEnd };
            if (name === '$VEL' && assign.member === 'CP') {
                const v = constantValue(assign.value);
                if (v !== null) { cpLimit(v, valueSpan, '$VEL.CP ='); }
            } else if (name === '$VEL' && !assign.member) {
                const cp = /\bCP\s+([-+]?[\d.]+(?:E[-+]?\d+)?)/i.exec(assign.value);
                if (cp) { cpLimit(Number(cp[1]), valueSpan, '$VEL.CP ='); }
                const svel = /^SVEL_CP\s*\(\s*([-+]?[\d.]+)/i.exec(assign.value);
                if (svel) { cpLimit(Number(svel[1]), valueSpan, 'SVEL_CP'); }
            } else if (!assign.member) {
                const v = constantValue(assign.value);
                if (v !== null) { rangeCheck(name, v, valueSpan); }
            }
        }
        // BAS(#VEL_CP, 2.5), BAS(#CP_PARAMS, 2.5) set $VEL.CP; BAS(#VEL_PTP, 100), BAS(#PTP_PARAMS, 100) the axis velocity
        if (L.kind === 'call' && /^BAS$/i.test(toks[0].text)) {
            const command = toks.find(t => t.kind === 'enum');
            const comma = toks.findIndex(t => t.text === ',');
            if (command && comma > 0) {
                const close = toks.length - 1 - [...toks].reverse().findIndex(t => t.text === ')');
                const argEnd = close > comma && close < toks.length ? toks[close].start : L.code.length;
                const v = constantValue(L.code.slice(toks[comma].end, argEnd));
                const s: Span = { line: ln, start: toks[comma + 1]?.start ?? toks[comma].end, end: argEnd };
                if (v !== null && /^#(VEL_CP|CP_PARAMS)$/i.test(command.text)) { cpLimit(v, s, `BAS(${command.text.toUpperCase()})`); }
                if (v !== null && /^#(VEL_PTP|PTP_PARAMS)$/i.test(command.text) && v > 100) {
                    add(s, 'warning', 'valueRange', `BAS(${command.text.toUpperCase()}) ${v} % exceeds 100 %`);
                }
            }
        }
    });

    // inline form data: LDAT VEL is m/s, PDAT VEL is %
    for (const d of doc.decls) {
        if ((d.type !== 'LDAT' && d.type !== 'PDAT') || !d.init) { continue; }
        const m = /\bVEL\s+([-+]?[\d.]+(?:E[-+]?\d+)?)/i.exec(d.init);
        if (!m) { continue; }
        const value = Number(m[1]);
        const s: Span = { line: d.line, start: d.initStart + m.index, end: d.initStart + m.index + m[0].length };
        if (d.type === 'LDAT') { cpLimit(value, s, `${d.name}.VEL`); }
        if (d.type === 'PDAT' && value > 100) { add(s, 'warning', 'valueRange', `${d.name}.VEL ${value} % exceeds 100 %`); }
    }
}

/** `$NAME[...].MEMBER = value` starting at token i: the member and the value text. */
function assignmentAt(code: string, toks: Tok[], i: number): { member: string; value: string; valueStart: number; valueEnd: number } | null {
    let j = i + 1;
    if (toks[j]?.text === '[') {
        let depth = 0;
        for (; j < toks.length; j++) {
            if (toks[j].text === '[') { depth++; }
            if (toks[j].text === ']' && --depth === 0) { j++; break; }
        }
    }
    let member = '';
    if (toks[j]?.text === '.' && toks[j + 1]?.kind === 'id') {
        member = toks[j + 1].text.toUpperCase();
        j += 2;
    }
    if (toks[j]?.text !== '=' || (i > 0 && toks[i - 1].text === '.')) { return null; }
    // the value ends at a comma outside of brackets (WITH lists) or at the end of the line
    let depth = 0;
    let k = j + 1;
    for (; k < toks.length; k++) {
        const t = toks[k].text;
        if ('([{'.includes(t) && toks[k].kind === 'op') { depth++; }
        if (')]}'.includes(t) && toks[k].kind === 'op') { depth--; }
        if ((t === ',' && depth === 0) || /^(C_PTP|C_DIS|C_VEL|C_ORI|C_SPL|PRIO|DELAY)$/i.test(t)) { break; }
    }
    const valueStart = toks[j + 1]?.start ?? toks[j].end;
    const valueEnd = k < toks.length ? toks[k - 1].end : (toks[toks.length - 1]?.end ?? code.length);
    if (valueStart >= valueEnd) { return null; }
    return { member, value: code.slice(valueStart, valueEnd), valueStart, valueEnd };
}

/** The same name declared twice in one scope. */
function checkDuplicates(doc: KrlDocument, add: Add): void {
    const seen = new Map<string, KrlDecl>();
    for (const d of doc.decls) {
        if (d.kind === 'ext' || d.kind === 'import') { continue; }
        const key = `${d.routine ? d.routine.line : -1}:${d.key}`;
        const first = seen.get(key);
        if (first) {
            add(d, 'error', 'duplicateDecl', `${d.name} is already declared in line ${first.line + 1}`);
        } else {
            seen.set(key, d);
        }
    }
    const routines = new Map<string, number>();
    for (const r of doc.routines) {
        const first = routines.get(r.key);
        if (first !== undefined) {
            add(r, 'error', 'duplicateRoutine', `${r.name} is already defined in line ${first + 1}`);
        } else {
            routines.set(r.key, r.line);
        }
    }
}

/**
 * Type for declaring a name that is not declared, from how the line uses it:
 * `FDAT_ACT=FP1` (the type of the other side), `n = 5` (the literal), a FOR
 * counter (INT), a condition (BOOL), a motion target (E6POS), an argument (the
 * type of the parameter). INT when nothing tells.
 */
export function inferDeclarationType(project: KrlProject, filePath: string, line: number, name: string): string {
    const doc = project.document(filePath);
    const L = doc?.lines[line];
    if (!doc || !L) { return 'INT'; }
    const code = L.code;
    const key = name.toLowerCase();
    const toks = L.tokens;
    const at = toks.findIndex(t => t.kind === 'id' && t.text.toLowerCase() === key);
    if (L.kind === 'motion') { return 'E6POS'; }
    if (L.kind === 'for' && at === 1) { return 'INT'; }
    const eq = toks.findIndex(t => t.text === '=');
    if (eq > 0 && (L.kind === 'assign' || L.kind === 'decl')) {
        if (at >= 0 && at < eq) {
            // the name is assigned: the type of the value
            const value = code.slice(toks[eq].end).trim();
            if (/^(TRUE|FALSE)$/i.test(value) || /^(NOT\b|.*(==|<>|>=|<=|<|>|\bAND\b|\bOR\b))/i.test(value)) { return 'BOOL'; }
            if (/^[-+]?\d+$/.test(value)) { return 'INT'; }
            if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) { return 'REAL'; }
            if (/^"/.test(value)) { return 'CHAR'; }
            const other = /^(\$?[A-Za-z_][\w$.[\]]*)$/.exec(value);
            const type = other ? project.typeOfPath(filePath, line, other[1]) : '';
            if (type) { return type; }
        } else if (at > eq) {
            // the name is the value: the type of the assigned variable
            const target = code.slice(0, toks[eq].start).trim();
            const type = project.typeOfPath(filePath, line, target);
            if (type && code.slice(toks[eq].end).trim().toLowerCase() === key) { return type; }
        }
    }
    const escaped = name.replace(/\$/g, '\\$');
    if (/^(if|while|until|wait)$/.test(L.kind) && new RegExp(`^\\s*(IF|WHILE|UNTIL|WAIT\\s+FOR)\\s+(NOT\\s+)?\\(?\\s*${escaped}\\s*\\)?\\s*(THEN)?\\s*$`, 'i').test(code)) {
        return 'BOOL';
    }
    return 'INT';
}

/** Initial value of a new data list entry: the standard values of the inline forms. */
export function defaultInitialValue(type: string): string {
    const ext = 'E1 0.0,E2 0.0,E3 0.0,E4 0.0,E5 0.0,E6 0.0';
    switch (type.toUpperCase()) {
        case 'E6POS': return `{X 0.0,Y 0.0,Z 0.0,A 0.0,B 0.0,C 0.0,${ext}}`;
        case 'POS': case 'FRAME': return '{X 0.0,Y 0.0,Z 0.0,A 0.0,B 0.0,C 0.0}';
        case 'E6AXIS': return `{A1 0.0,A2 -90.0,A3 90.0,A4 0.0,A5 0.0,A6 0.0,${ext}}`;
        case 'AXIS': return '{A1 0.0,A2 -90.0,A3 90.0,A4 0.0,A5 0.0,A6 0.0}';
        case 'FDAT': return '{TOOL_NO 1,BASE_NO 0,IPO_FRAME #BASE,POINT2[] " ",TQ_STATE FALSE}';
        case 'PDAT': return '{VEL 100.000,ACC 100.000,APO_DIST 100.000,APO_MODE #CDIS,GEAR_JERK 50.0000,EXAX_IGN 0}';
        case 'LDAT': return '{VEL 2.00000,ACC 100.000,APO_DIST 100.000,APO_FAC 50.0000,AXIS_VEL 100.000,AXIS_ACC 100.000,ORI_TYP #VAR,CIRC_TYP #BASE,JERK_FAC 50.0000,GEAR_JERK 50.0000,EXAX_IGN 0}';
        case 'INT': return '0';
        case 'REAL': return '0.0';
        case 'BOOL': return 'FALSE';
        default: return '';
    }
}

/** The counter of a FOR loop must be an INT variable. */
function checkForCounters(project: KrlProject, doc: KrlDocument, add: Add): void {
    doc.lines.forEach((L, ln) => {
        if (L.kind !== 'for') { return; }
        const counter = L.tokens[1];
        if (!counter || counter.kind !== 'id' || L.tokens[2]?.text !== '=') { return; }
        if (!routineAt(doc, ln)) { return; }
        const { type } = project.typeOfName(doc.path, ln, counter.text);
        if (type && type !== 'INT') {
            add(span(ln, counter), 'error', 'forCounterType', `The counter of a FOR loop must be INT (${counter.text} is ${type})`);
        }
    });
}
