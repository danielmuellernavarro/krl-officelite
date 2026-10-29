// krlFeatures.ts
// Editor features computed from the document model and the project: signature
// help (routines, standard functions, INTERRUPT / TRIGGER / FOR / WAIT and the
// motion statements), inlay hints (velocity, acceleration and approximation of
// motions, parameter names of literal arguments), hovers, go to definition,
// references, the outline and folding ranges.
// Pure logic (no vscode imports).

import * as path from 'path';
import { KrlDecl, KrlDocument, KrlFold, Span, Tok, routineAt, tokenAt, foldsAt } from './krlSyntax';
import { KrlProject, KrlSymbol } from './krlProject';
import {
    builtinRoutine, systemVariable, motionInfo, memberUnit, KEYWORDS, MOTIONS, catalogStructMembers, systemEnumValues,
} from './krlCatalog';
import { inCommentOrString, enclosingCall, pathBefore, declarationMarkdown, systemDoc, symbolType } from './krlCompletion';
import { constantValue, motionTargets } from './krlDiagnostics';
import { formatReal } from '../debugger/krlRobotFormat';

// ---------------------------------------------------------------------------
// signature help

export interface KrlSignature {
    label: string;
    documentation?: string;
    /** offsets of each parameter in the label */
    parameters: { label: [number, number]; documentation?: string }[];
}

export interface SignatureResult {
    signature: KrlSignature;
    activeParameter: number;
}

/** Build a signature label from parts; parameters are marked by their index. */
function signature(parts: (string | { param: string; doc?: string })[], documentation?: string): KrlSignature {
    let label = '';
    const parameters: KrlSignature['parameters'] = [];
    for (const part of parts) {
        if (typeof part === 'string') { label += part; continue; }
        parameters.push({ label: [label.length, label.length + part.param.length], documentation: part.doc });
        label += part.param;
    }
    return { label, documentation, parameters };
}

/** Comment lines directly above a line (the documentation of a routine), and the comment of the line itself. */
export function commentAbove(doc: KrlDocument, line: number): string {
    const out: string[] = [];
    for (let l = line - 1; l >= 0; l--) {
        const L = doc.lines[l];
        if (L.code.trim() !== '' || L.comment < 0) { break; }
        const text = L.text.slice(L.comment + 1).trim();
        if (/^(END)?FOLD\b/i.test(text)) { break; }
        out.unshift(text);
    }
    const own = doc.lines[line];
    if (own && own.comment >= 0) { out.push(own.text.slice(own.comment + 1).trim()); }
    return out.filter(s => s && !/^[-=*#_ ]+$/.test(s)).join('\n');
}

function paramDoc(dir: string, type: string): string {
    const how = dir === 'IN' ? 'IN: passed by value' : 'OUT: passed by reference (the caller\'s variable)';
    return `${type ? type + ', ' : ''}${how}`;
}

/** EXT, EXTP or EXTFCT INT ... as written in the declaration of an external routine. */
function extKeyword(doc: KrlDocument, decl: KrlDecl): string {
    const kw = doc.lines[decl.line]?.tokens.find(t => /^EXT/i.test(t.text))?.text.toUpperCase() ?? 'EXT';
    return decl.type ? `${kw} ${decl.type}` : kw;
}

export function computeSignatureHelp(project: KrlProject, filePath: string, line: number, character: number): SignatureResult | null {
    const doc = project.document(filePath);
    const L = doc?.lines[line];
    if (!doc || !L || inCommentOrString(L.text, character)) { return null; }
    const code = L.code;

    const call = enclosingCall(code, character);
    if (call) {
        const sym = project.resolveRoutine(filePath, call.name);
        if (sym?.kind === 'routine') {
            const r = sym.routine;
            const parts: (string | { param: string; doc?: string })[] = [r.kind === 'deffct' ? `DEFFCT ${r.returnType} ${r.name}(` : `DEF ${r.name}(`];
            r.params.forEach((p, i) => {
                if (i > 0) { parts.push(', '); }
                parts.push({ param: `${p.type ? p.type + ' ' : ''}${p.name}${p.dims}${p.dir ? ' :' + p.dir : ''}`, doc: paramDoc(p.dir || 'OUT', p.type) });
            });
            parts.push(')');
            const comments = commentAbove(sym.doc, r.line);
            const sig = signature(parts, `${comments ? comments + '\n\n' : ''}*${path.basename(sym.doc.path)}*`);
            return { signature: sig, activeParameter: Math.min(call.argIndex, Math.max(0, r.params.length - 1)) };
        }
        if (sym?.kind === 'decl' && sym.decl.params) {
            const params = sym.decl.params;
            const parts: (string | { param: string; doc?: string })[] = [`${extKeyword(sym.doc, sym.decl)} ${sym.decl.name}(`];
            params.forEach((p, i) => {
                if (i > 0) { parts.push(', '); }
                parts.push({ param: `${p.type}${p.dims}${p.dir ? ' :' + p.dir : ''}`, doc: paramDoc(p.dir || 'OUT', p.type) });
            });
            parts.push(')');
            const sig = signature(parts, `*${path.basename(sym.doc.path)}*`);
            return { signature: sig, activeParameter: Math.min(call.argIndex, Math.max(0, params.length - 1)) };
        }
        const b = builtinRoutine(call.name);
        if (b) {
            const parts: (string | { param: string; doc?: string })[] = [`${b.name}(`];
            b.params.forEach((p, i) => {
                if (i > 0) { parts.push(', '); }
                parts.push({ param: `${p.name}${p.dir === 'OUT' ? ' :OUT' : ''}`, doc: `${p.type}${p.doc ? ' — ' + p.doc : ''}` });
            });
            if (b.variadic) { parts.push(', ...'); }
            parts.push(b.returnType ? `): ${b.returnType}` : ')');
            const active = b.variadic && call.argIndex >= b.params.length ? b.params.length - 1 : Math.min(call.argIndex, Math.max(0, b.params.length - 1));
            return { signature: signature(parts, b.doc), activeParameter: active };
        }
        return null;
    }

    const before = code.slice(0, character);
    const count = (re: RegExp) => (before.match(re) ?? []).length;
    if (/^\s*(GLOBAL\s+)?INTERRUPT\s+DECL\b/i.test(code)) {
        const sig = signature([
            'INTERRUPT DECL ', { param: 'Prio', doc: 'Priority 1, 2, 4 … 39 or 81 … 128 (3 and 40 … 80 are reserved for the system); 1 is the highest.' },
            ' WHEN ', { param: 'Event', doc: 'Boolean expression, e.g. `$IN[1] == TRUE`; the interrupt fires on its rising edge.' },
            ' DO ', { param: 'Subprogram()', doc: 'Interrupt routine (a DEF subprogram, not a function).' },
        ], 'Declares an interrupt; switch it on with `INTERRUPT ON <Prio>`.');
        return { signature: sig, activeParameter: /\bDO\b/i.test(before) ? 2 : /\bWHEN\b/i.test(before) ? 1 : 0 };
    }
    if (/^\s*TRIGGER\s+WHEN\s+PATH\b/i.test(code)) {
        const sig = signature([
            'TRIGGER WHEN PATH = ', { param: 'Distance', doc: 'mm before (negative) or after the end point of the next motion.' },
            ' ', { param: '<ONSTART>', doc: 'relative to the start point instead of the end point.' },
            ' DELAY = ', { param: 'Time', doc: 'ms; negative values switch earlier.' },
            ' DO ', { param: 'Statement', doc: 'assignment (e.g. `$OUT[1]=TRUE`) or subprogram call.' },
            ' PRIO = ', { param: 'Priority', doc: 'for subprogram calls: 1, 2, 4 … 39, 81 … 128, or -1 (assigned by the system).' },
        ], 'Path-related switching action.');
        const active = /\bPRIO\b/i.test(before) ? 4 : /\bDO\b/i.test(before) ? 3 : /\bDELAY\b/i.test(before) ? 2 : /\bPATH\s*=\s*\S+\s+\w*$/i.test(before) ? 1 : 0;
        return { signature: sig, activeParameter: active };
    }
    if (/^\s*TRIGGER\b/i.test(code)) {
        const sig = signature([
            'TRIGGER WHEN DISTANCE = ', { param: '0|1', doc: '0: at the start point, 1: at the end point of the next motion.' },
            ' DELAY = ', { param: 'Time', doc: 'ms; negative values switch earlier.' },
            ' DO ', { param: 'Statement', doc: 'assignment (e.g. `$OUT[1]=TRUE`) or subprogram call.' },
            ' PRIO = ', { param: 'Priority', doc: 'for subprogram calls: 1, 2, 4 … 39, 81 … 128, or -1 (assigned by the system).' },
        ], 'Switching action at the start or end point of the next motion.');
        const active = /\bPRIO\b/i.test(before) ? 3 : /\bDO\b/i.test(before) ? 2 : /\bDELAY\b/i.test(before) ? 1 : 0;
        return { signature: sig, activeParameter: active };
    }
    if (/^\s*FOR\b/i.test(code)) {
        const sig = signature([
            'FOR ', { param: 'Counter', doc: 'INT variable' }, ' = ', { param: 'Start', doc: 'INT expression' },
            ' TO ', { param: 'End', doc: 'INT expression' }, ' STEP ', { param: 'Increment', doc: 'INT constant, default 1' },
        ], 'Counting loop ... ENDFOR');
        const active = /\bSTEP\b/i.test(before) ? 3 : /\bTO\b/i.test(before) ? 2 : /=/.test(before) ? 1 : 0;
        return { signature: sig, activeParameter: active };
    }
    if (/^\s*WAIT\s+SEC\b/i.test(code)) {
        return { signature: signature(['WAIT SEC ', { param: 'Time', doc: 'seconds (REAL); triggers an advance run stop' }]), activeParameter: 0 };
    }
    if (/^\s*WAIT\s+FOR\b/i.test(code)) {
        return { signature: signature(['WAIT FOR ', { param: 'Condition', doc: 'Boolean expression; triggers an advance run stop' }]), activeParameter: 0 };
    }
    const m = /^\s*([A-Za-z_]+)\b/.exec(code);
    const info = m ? motionInfo(m[1]) : undefined;
    if (m && info && character > m[0].length) {
        const keyword = m[1].toUpperCase();
        const spline = keyword.startsWith('S');
        const approx = spline ? '<C_SPL> <WITH ...>' : info.cp ? '<C_DIS | C_VEL | C_ORI>' : '<C_PTP | C_DIS>';
        const parts: (string | { param: string; doc?: string })[] = [`${keyword} `];
        if (info.points === 2) {
            parts.push({ param: 'Auxiliary point', doc: 'POS, E6POS or FRAME' }, ', ');
        }
        parts.push({ param: 'Target', doc: /PTP/.test(keyword) ? 'POS, E6POS, FRAME, AXIS or E6AXIS' : 'POS, E6POS or FRAME' });
        if (info.points === 2) { parts.push(', ', { param: '<CA Angle>', doc: 'circular angle in degrees' }); }
        parts.push(' ', { param: approx, doc: 'approximate positioning ($APO)' });
        const commas = count(/,/g);
        const afterTarget = /\S\s+\S*$/.test(before.slice(m[0].length).replace(/^\s+/, '')) && commas >= info.points - 1;
        const index = info.points === 2
            ? (commas === 0 ? 0 : commas === 1 ? (afterTarget ? 3 : 1) : 2)
            : (afterTarget ? 1 : 0);
        return { signature: signature(parts, MOTIONS[keyword]?.doc), activeParameter: index };
    }
    return null;
}

// ---------------------------------------------------------------------------
// inlay hints

export interface KrlInlayHint {
    line: number;
    character: number;
    label: string;
    kind: 'parameter' | 'type';
    tooltip?: string;
}

export interface InlayHintOptions {
    /** velocity, acceleration and approximation at motions */
    motionParameters: boolean;
    /** parameter names at literal arguments */
    parameterNames: boolean;
}

interface MotionParameter { value: string; source: string; }

/** Text of a numeric value with its unit; expressions as written. */
function valueText(text: string, unit: string): string {
    const v = constantValue(text);
    const shown = v !== null ? formatReal(v, 3).replace(/\.0$/, '') : (text.length > 18 ? text.slice(0, 17) + '…' : text);
    return unit ? `${shown} ${unit}` : shown;
}

/** A member of an aggregate initial value: `VEL` of `{VEL 2.0,ACC 100.0,...}`. */
function aggregateMember(init: string, member: string): string | null {
    const m = new RegExp(`[{,]\\s*${member}\\s+([^,}]+)`, 'i').exec(init);
    return m ? m[1].trim() : null;
}

export function computeInlayHints(project: KrlProject, filePath: string, fromLine: number, toLine: number, options: InlayHintOptions): KrlInlayHint[] {
    const doc = project.document(filePath);
    if (!doc) { return []; }
    const out: KrlInlayHint[] = [];
    for (let ln = Math.max(0, fromLine); ln <= Math.min(toLine, doc.lines.length - 1); ln++) {
        const L = doc.lines[ln];
        if (options.motionParameters && L.kind === 'motion') { out.push(...motionHints(project, doc, ln)); }
        if (options.parameterNames && L.tokens.length > 0) { out.push(...parameterNameHints(project, doc, ln)); }
    }
    return out;
}

function motionHints(project: KrlProject, doc: KrlDocument, ln: number): KrlInlayHint[] {
    const L = doc.lines[ln];
    const keyword = L.tokens[0].text.toUpperCase();
    const info = motionInfo(keyword);
    if (!info) { return []; }
    const params = motionParameters(project, doc, ln, info.cp);
    const at = L.code.trimEnd().length;
    const hint = (name: string, p: MotionParameter | undefined): KrlInlayHint | null =>
        p ? { line: ln, character: at, label: `${name}: ${p.value}`, kind: 'type', tooltip: p.source } : null;
    const approximated = L.tokens.some(t => /^(C_PTP|C_DIS|C_VEL|C_ORI|C_SPL)$/i.test(t.text));
    return [hint('VEL', params.vel), hint('ACC', params.acc), approximated ? hint('APO', params.apo) : null]
        .filter((h): h is KrlInlayHint => !!h);
}

/**
 * Velocity, acceleration and approximation a motion runs with, found statically:
 * the WITH clause, the data of its inline form (LDAT_ACT / PDAT_ACT and BAS), or
 * the last assignment / BAS call before it in the routine.
 */
export function motionParameters(project: KrlProject, doc: KrlDocument, ln: number, cp: boolean): { vel?: MotionParameter; acc?: MotionParameter; apo?: MotionParameter } {
    const result: { vel?: MotionParameter; acc?: MotionParameter; apo?: MotionParameter } = {};
    const L = doc.lines[ln];
    const datName = (sym: KrlSymbol) => path.basename(sym.doc.path);
    const lookupData = (name: string): { init: string; source: string } | null => {
        const sym = project.resolveVariable(doc.path, ln, name);
        return sym?.kind === 'decl' && sym.decl.init ? { init: sym.decl.init, source: `${sym.decl.name} in ${datName(sym)}` } : null;
    };
    const fromData = (dataName: string) => {
        const data = lookupData(dataName);
        if (!data) { return; }
        const acc = aggregateMember(data.init, 'ACC');
        if (acc && !result.acc) { result.acc = { value: valueText(acc, '%'), source: `ACC of ${data.source}` }; }
        const apo = aggregateMember(data.init, 'APO_DIST');
        if (apo && !result.apo) { result.apo = { value: valueText(apo, 'mm'), source: `APO_DIST of ${data.source}` }; }
        const vel = aggregateMember(data.init, 'VEL');
        if (vel && !result.vel) { result.vel = { value: valueText(vel, cp ? 'm/s' : '%'), source: `VEL of ${data.source}` }; }
    };

    // the WITH clause of spline motions: $VEL = SVEL_CP(0.5, , LCPDAT1), $VEL_AXIS[1] = SVEL_JOINT(50), ...
    const withAt = L.code.search(/\bWITH\b/i);
    if (withAt >= 0) {
        const clause = L.code.slice(withAt);
        const svel = /SVEL_(CP|JOINT)\s*\(\s*([^,)]+)/i.exec(clause);
        if (svel) { result.vel = { value: valueText(svel[2].trim(), cp ? 'm/s' : '%'), source: 'WITH clause of the motion' }; }
        const velCp = /\$VEL\.CP\s*=\s*([^,]+)/i.exec(clause);
        if (velCp) { result.vel = { value: valueText(velCp[1].trim(), 'm/s'), source: 'WITH clause of the motion' }; }
        const data = /S(?:ACC_CP|ACC_JOINT|APO|APO_PTP)\s*\(\s*([A-Za-z_][\w$]*)/i.exec(clause);
        if (data) { fromData(data[1]); }
    }

    // an inline form: its data set and the velocity passed to BAS
    const fold = foldsAt(doc, ln).find(f => f.inlineForm);
    const scanFrom = fold ? fold.line + 1 : (routineAt(doc, ln)?.line ?? 0) + 1;
    for (let l = ln - 1; l >= scanFrom; l--) {
        const code = doc.lines[l].code;
        // LDAT_ACT holds the data of CP motions, PDAT_ACT of PTP motions
        let m = /^\s*([LP])DAT_ACT\s*=\s*([A-Za-z_][\w$]*)/i.exec(code);
        if (m) {
            if ((m[1].toUpperCase() === 'L') === cp) { fromData(m[2]); }
            continue;
        }
        m = /^\s*BAS\s*\(\s*#(\w+)\s*,\s*([^)]+)\)/i.exec(code);
        if (m) {
            const command = m[1].toUpperCase();
            const arg = m[2].trim();
            if (!result.vel && ((cp && (command === 'VEL_CP' || command === 'CP_PARAMS')) || (!cp && (command === 'VEL_PTP' || command === 'PTP_PARAMS')))) {
                result.vel = { value: valueText(arg, cp ? 'm/s' : '%'), source: `BAS(#${command}, ${arg}) in line ${l + 1}` };
            }
            if (!result.acc && ((cp && command === 'ACC_CP') || (!cp && command === 'ACC_PTP'))) {
                result.acc = { value: valueText(arg, '%'), source: `BAS(#${command}, ${arg}) in line ${l + 1}` };
            }
            if (command === 'INITMOV') {
                // BAS(#INITMOV, 0): 100 % for PTP, DEF_VEL_CP and 100 % acceleration for CP motions
                const defVel = cp ? lookupData('DEF_VEL_CP') : null;
                result.vel = result.vel ?? { value: cp ? (defVel ? valueText(defVel.init, 'm/s') : 'DEF_VEL_CP') : '100 %', source: `BAS(#INITMOV) in line ${l + 1}` };
                result.acc = result.acc ?? { value: '100 %', source: `BAS(#INITMOV) in line ${l + 1}` };
                break;
            }
            continue;
        }
        if (!result.vel) {
            m = cp ? /^\s*\$VEL\.CP\s*=\s*(.+)$/i.exec(code) : /^\s*\$VEL_AXIS\s*\[\s*1\s*\]\s*=\s*(.+)$/i.exec(code);
            if (m) { result.vel = { value: valueText(m[1].trim(), cp ? 'm/s' : '%'), source: `line ${l + 1}` }; }
        }
        if (!result.acc) {
            m = cp ? /^\s*\$ACC\.CP\s*=\s*(.+)$/i.exec(code) : /^\s*\$ACC_AXIS\s*\[\s*1\s*\]\s*=\s*(.+)$/i.exec(code);
            if (m) { result.acc = { value: valueText(m[1].trim(), cp ? 'm/s²' : '%'), source: `line ${l + 1}` }; }
        }
        if (!result.apo) {
            m = /^\s*\$APO\.CDIS\s*=\s*(.+)$/i.exec(code);
            if (m) { result.apo = { value: valueText(m[1].trim(), 'mm'), source: `line ${l + 1}` }; }
        }
        if (result.vel && result.acc && result.apo) { break; }
    }
    return result;
}

/** `speed:` before literal arguments of routine calls. */
function parameterNameHints(project: KrlProject, doc: KrlDocument, ln: number): KrlInlayHint[] {
    const toks = doc.lines[ln].tokens;
    const out: KrlInlayHint[] = [];
    for (let i = 0; i + 1 < toks.length; i++) {
        const nameTok = toks[i];
        if (nameTok.kind !== 'id' || toks[i + 1].text !== '(' || KEYWORDS.has(nameTok.text.toLowerCase())) { continue; }
        const names = parameterNames(project, doc.path, nameTok.text);
        if (!names || names.length === 0) { continue; }
        // arguments: token ranges between the commas of this call
        let depth = 0;
        let arg = 0;
        let argStart = i + 2;
        for (let j = i + 1; j < toks.length; j++) {
            const t = toks[j];
            if (t.kind === 'op' && '([{'.includes(t.text)) { depth++; if (depth === 1) { argStart = j + 1; continue; } }
            const closes = t.kind === 'op' && ')]}'.includes(t.text);
            if (closes) { depth--; }
            if ((depth === 1 && t.text === ',' && t.kind === 'op') || (closes && depth === 0)) {
                const argToks = toks.slice(argStart, j);
                const name = names[arg];
                if (name && isLiteral(argToks) && argToks[argToks.length - 1].text.toLowerCase() !== name.toLowerCase()) {
                    out.push({ line: ln, character: argToks[0].start, label: `${name}:`, kind: 'parameter' });
                }
                arg++;
                argStart = j + 1;
                if (closes) { break; }
            }
        }
    }
    return out;
}

function parameterNames(project: KrlProject, filePath: string, name: string): string[] | null {
    const sym = project.resolveRoutine(filePath, name);
    if (sym?.kind === 'routine') { return sym.routine.params.map(p => p.name); }
    const b = builtinRoutine(name);
    return b && !/^S[A-Z_]+$/.test(b.name) ? b.params.map(p => p.name.replace(/\[\]$/, '')) : null;
}

/** Numbers, strings and TRUE / FALSE need a name; enumeration literals (#CP_PARAMS) speak for themselves. */
function isLiteral(toks: Tok[]): boolean {
    const t = toks.length === 2 && toks[0].text === '-' ? toks[1] : toks.length === 1 ? toks[0] : null;
    return !!t && (t.kind === 'num' || t.kind === 'str' || t.kind === 'char' || /^(TRUE|FALSE)$/i.test(t.text));
}

// ---------------------------------------------------------------------------
// symbol at a position: hover, definition, references

export type Target =
    | { kind: 'symbol'; symbol: KrlSymbol; tok: Tok }
    | { kind: 'system'; name: string; tok: Tok }
    | { kind: 'builtin'; name: string; tok: Tok }
    | { kind: 'member'; type: string; member: string; memberType: string; tok: Tok }
    | { kind: 'enum'; value: string; tok: Tok }
    | { kind: 'motion'; keyword: string; tok: Tok }
    /** a predefined or system type: INT, E6POS, VEL, MODE_OP, FDAT (without $config.dat) */
    | { kind: 'builtinType'; name: string; tok: Tok };

/** What the name at a position refers to. */
export function targetAt(project: KrlProject, filePath: string, line: number, character: number): Target | null {
    const doc = project.document(filePath);
    const L = doc?.lines[line];
    if (!doc || !L || character > L.code.length) { return null; }
    const hit = tokenAt(doc, line, character);
    if (!hit) { return null; }
    const { tok, index } = hit;
    const toks = L.tokens;
    if (tok.kind === 'sys') {
        // declared in the project ($config.dat, machine data), else provided by the controller
        const declared = project.resolveVariable(filePath, line, tok.text);
        if (declared) { return { kind: 'symbol', symbol: declared, tok }; }
        return systemVariable(tok.text) ? { kind: 'system', name: tok.text, tok } : null;
    }
    if (tok.kind === 'enum') { return { kind: 'enum', value: tok.text, tok }; }
    if (tok.kind !== 'id') { return null; }
    if (toks[index - 1]?.text === '.') {
        const p = pathBefore(L.code.slice(0, toks[index - 1].start));
        const type = p ? project.typeOfPath(filePath, line, p) : '';
        const member = type ? project.structMembers(filePath, type)?.find(m => m.name.toLowerCase() === tok.text.toLowerCase()) : undefined;
        return member ? { kind: 'member', type, member: member.name, memberType: `${member.type}${member.dims.length ? `[${member.dims.join(',')}]` : ''}`, tok } : null;
    }
    const lower = tok.text.toLowerCase();
    if (index === 0 && motionInfo(tok.text)) { return { kind: 'motion', keyword: tok.text.toUpperCase(), tok }; }
    if (KEYWORDS.has(lower)) { return null; }
    if (toks[index + 1]?.text === '(' || L.kind === 'prog' || L.kind === 'fct') {
        const sym = project.resolveRoutine(filePath, tok.text);
        if (sym) { return { kind: 'symbol', symbol: sym, tok }; }
        if (builtinRoutine(tok.text)) { return { kind: 'builtin', name: tok.text, tok }; }
    }
    if (L.kind === 'goto' || L.kind === 'label') {
        const label = project.resolveLabel(filePath, line, tok.text);
        if (label) { return { kind: 'symbol', symbol: label, tok }; }
    }
    const variable = project.resolveVariable(filePath, line, tok.text);
    if (variable) { return { kind: 'symbol', symbol: variable, tok }; }
    const type = project.resolveType(filePath, tok.text);
    if (type) { return { kind: 'symbol', symbol: type, tok }; }
    const routine = project.resolveRoutine(filePath, tok.text);
    if (routine) { return { kind: 'symbol', symbol: routine, tok }; }
    if (/^(INT|REAL|BOOL|CHAR)$/i.test(tok.text) || catalogStructMembers(tok.text) || systemEnumValues(tok.text)) {
        return { kind: 'builtinType', name: tok.text.toUpperCase(), tok };
    }
    return null;
}

/**
 * The entry of the reference document (`systemReference()`) for a name no program
 * declares: a system variable, standard function, predefined type or literal of a
 * system ENUM, or the type of a member of a predefined structure.
 */
export function referenceAt(project: KrlProject, filePath: string, line: number, character: number): string | null {
    const target = targetAt(project, filePath, line, character);
    switch (target?.kind) {
        case 'system': return `system:${target.name.toLowerCase()}`;
        case 'builtin': return `builtin:${target.name.toLowerCase()}`;
        case 'builtinType': return `type:${target.name.toLowerCase()}`;
        case 'member': return project.resolveType(filePath, target.type) ? null : `type:${target.type.toLowerCase()}`;
        case 'enum': return enumDefinition(project, filePath, target.value) ? null : `literal:${target.value.toLowerCase()}`;
        default: return null;
    }
}

/** The ENUM of the project that has a literal (#VALUE): where the literal is written. */
function enumDefinition(project: KrlProject, filePath: string, literal: string): Location | null {
    const value = literal.replace(/^#/, '').toLowerCase();
    for (const sym of project.visibleTypes(filePath)) {
        if (sym.kind !== 'type' || sym.type.kind !== 'enum' || !sym.type.values.some(v => v.toLowerCase() === value)) { continue; }
        return wordInLine(sym.doc, sym.type.line, value, sym.type.end) ?? symbolSpan(sym);
    }
    return null;
}

/** The position of a whole word in a line, searched from a column. */
function wordInLine(doc: KrlDocument, line: number, word: string, from: number): Location | null {
    const code = doc.lines[line]?.code ?? '';
    const m = new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`, 'i').exec(code.slice(from));
    return m ? { path: doc.path, line, start: from + m.index, end: from + m.index + m[0].length } : null;
}

export function computeHover(project: KrlProject, filePath: string, line: number, character: number): { markdown: string; range: Span } | null {
    const doc = project.document(filePath);
    if (!doc) { return null; }
    const L = doc.lines[line];
    // the ;FOLD line of an inline form: what the motion inside does
    if (L && L.comment >= 0 && character >= L.comment) {
        const fold = doc.folds.find(f => f.line === line && f.inlineForm);
        return fold ? inlineFormHover(project, doc, fold) : null;
    }
    const target = targetAt(project, filePath, line, character);
    if (!target) { return null; }
    const range: Span = { line, start: target.tok.start, end: target.tok.end };
    switch (target.kind) {
        case 'system': return { markdown: systemDoc(target.name), range };
        case 'builtin': {
            const b = builtinRoutine(target.name)!;
            const sig = `${b.name}(${b.params.map(p => `${p.type} ${p.name}${p.dir === 'OUT' ? ':OUT' : ''}`).join(', ')}${b.variadic ? ', ...' : ''})${b.returnType ? ': ' + b.returnType : ''}`;
            return { markdown: ['```krl', sig, '```', b.doc, b.advanceStop ? '\n*Triggers an advance run stop.*' : ''].join('\n'), range };
        }
        case 'member': {
            const unit = memberUnit(target.type, target.member);
            return { markdown: ['```krl', `${target.memberType} ${target.type}.${target.member}`, '```', unit ? `Unit: ${unit}` : ''].join('\n'), range };
        }
        case 'enum': {
            const owners = project.visibleTypes(filePath).filter(s => s.kind === 'type' && s.type.kind === 'enum'
                && s.type.values.some(v => v.toLowerCase() === target.value.slice(1).toLowerCase()));
            const names = owners.map(s => (s.kind === 'type' ? s.type.name : '')).join(', ');
            return names ? { markdown: `\`${target.value}\`: literal of ENUM **${names}**`, range } : null;
        }
        case 'motion': return { markdown: `**${target.keyword}**: ${MOTIONS[target.keyword]?.doc ?? ''}`, range };
        case 'builtinType': {
            const members = catalogStructMembers(target.name);
            const values = systemEnumValues(target.name);
            const body = members ? `STRUC ${target.name} ${members.map(m => `${m.type} ${m.name}${m.dims.length ? `[${m.dims.join(',')}]` : ''}`).join(', ')}`
                : values ? `ENUM ${target.name} ${values.join(', ')}` : target.name;
            return { markdown: ['```krl', body, '```', members || values ? '*predefined type*' : '*simple type*'].join('\n'), range };
        }
        case 'symbol': return { markdown: symbolMarkdown(project, filePath, target.symbol), range };
        default: return null;
    }
}

function symbolMarkdown(project: KrlProject, filePath: string, sym: KrlSymbol): string {
    const file = path.basename(sym.doc.path);
    switch (sym.kind) {
        case 'decl': {
            const scope = sym.decl.routine ? `local in ${sym.decl.routine.name}` : sym.decl.isGlobal ? 'global' : /^\$config\.dat$/i.test(file) ? 'global ($CONFIG.DAT)' : 'data list of the module';
            if (sym.decl.kind === 'ext') {
                const d = sym.decl;
                const head = `${extKeyword(sym.doc, d)} ${d.name}(${(d.params ?? []).map(p => `${p.type}${p.dims}${p.dir ? ' :' + p.dir : ''}`).join(', ')})`;
                return ['```krl', head, '```', 'Routine of another module, declared with EXT', `*${file}, line ${d.line + 1} · ${scope}*`].join('\n');
            }
            return declarationMarkdown(sym.decl, `${file} · ${scope}`);
        }
        case 'param': {
            const p = sym.param;
            return ['```krl', `${p.type || '(type not declared)'} ${p.name}${p.dims} :${p.dir || 'OUT'}`, '```',
                `Parameter of ${sym.routine.name} · ${paramDoc(p.dir || 'OUT', '')}`].join('\n');
        }
        case 'routine': {
            const r = sym.routine;
            const head = `${r.isGlobal ? 'GLOBAL ' : ''}${r.kind === 'deffct' ? `DEFFCT ${r.returnType}` : 'DEF'} ${r.name}(${r.params.map(p => `${p.type ? p.type + ' ' : ''}${p.name}${p.dims}${p.dir ? ':' + p.dir : ''}`).join(', ')})`;
            const comments = commentAbove(sym.doc, r.line);
            return ['```krl', head, '```', comments, `*${file}, line ${r.line + 1}*`].filter(Boolean).join('\n');
        }
        case 'type': {
            const t = sym.type;
            const body = t.kind === 'enum' ? t.values.map(v => `#${v}`).join(', ') : t.members.map(m => `${m.type} ${m.name}${m.dims}`).join(', ');
            return ['```krl', `${t.isGlobal ? 'GLOBAL ' : ''}${t.kind === 'enum' ? 'ENUM' : 'STRUC'} ${t.name} ${body}`, '```', `*${file}*`].join('\n');
        }
        case 'label': return `Label **${sym.label.name}** (line ${sym.label.line + 1})`;
        default: return '';
    }
}

/** Hover of an inline form ;FOLD line: the motion it contains and its target point. */
function inlineFormHover(project: KrlProject, doc: KrlDocument, fold: KrlFold): { markdown: string; range: Span } | null {
    const end = fold.endLine < 0 ? doc.lines.length : fold.endLine;
    for (let l = fold.line + 1; l < end; l++) {
        if (doc.lines[l].kind !== 'motion') { continue; }
        const statement = doc.lines[l].code.trim();
        const parts = ['```krl', statement, '```'];
        for (const t of motionTargets(doc, l)) {
            const sym = project.resolveVariable(doc.path, l, t.text);
            if (sym?.kind === 'decl') { parts.push('', declarationMarkdown(sym.decl, path.basename(sym.doc.path))); }
        }
        const L = doc.lines[fold.line];
        return { markdown: parts.join('\n'), range: { line: fold.line, start: L.comment, end: fold.metaStart >= 0 ? fold.metaStart : L.text.length } };
    }
    return null;
}

// ---------------------------------------------------------------------------
// definition and references

export interface Location extends Span { path: string; }

function symbolSpan(sym: KrlSymbol): Location {
    const at = sym.kind === 'decl' ? sym.decl : sym.kind === 'param' ? sym.param : sym.kind === 'routine' ? sym.routine
        : sym.kind === 'type' ? sym.type : sym.label;
    return { path: sym.doc.path, line: at.line, start: at.start, end: at.end };
}

export function findDefinition(project: KrlProject, filePath: string, line: number, character: number): Location | null {
    const target = targetAt(project, filePath, line, character);
    switch (target?.kind) {
        case 'symbol': return symbolSpan(target.symbol);
        case 'member': {
            // a member of a STRUC of the project: the member in the STRUC line
            const type = project.resolveType(filePath, target.type);
            if (type?.kind !== 'type') { return null; }
            return wordInLine(type.doc, type.type.line, target.member, type.type.end) ?? symbolSpan(type);
        }
        case 'enum': return enumDefinition(project, filePath, target.value);
        default: return null;
    }
}

function sameSymbol(a: KrlSymbol, b: KrlSymbol): boolean {
    switch (a.kind) {
        case 'decl': return b.kind === 'decl' && a.decl === b.decl;
        case 'param': return b.kind === 'param' && a.param === b.param;
        case 'routine': return b.kind === 'routine' && a.routine === b.routine;
        case 'type': return b.kind === 'type' && a.type === b.type;
        case 'label': return b.kind === 'label' && a.label === b.label;
        default: return false;
    }
}

export function findReferences(project: KrlProject, filePath: string, line: number, character: number, includeDeclaration: boolean): Location[] {
    const target = targetAt(project, filePath, line, character);
    if (target?.kind !== 'symbol') { return []; }
    const sym = target.symbol;
    const key = target.tok.text.toLowerCase();
    // where the symbol can be referenced
    let files: string[];
    if (sym.kind === 'param' || sym.kind === 'label' || (sym.kind === 'decl' && sym.decl.routine)) {
        files = [sym.doc.path];
    } else if (sym.kind === 'decl' && !sym.decl.isGlobal && !/^\$/.test(path.basename(sym.doc.path))) {
        const src = project.companionSource(sym.doc.path);
        files = [sym.doc.path, ...(src ? [src.path] : [])];
    } else {
        files = project.projectFiles(filePath);
    }
    const out: Location[] = [];
    if (includeDeclaration) { out.push(symbolSpan(sym)); }
    for (const f of files) {
        const doc = project.document(f);
        if (!doc) { continue; }
        for (const ref of doc.refs) {
            if (ref.key !== key) { continue; }
            const resolved = ref.role === 'call' ? project.resolveRoutine(f, ref.name)
                : ref.role === 'goto' ? project.resolveLabel(f, ref.line, ref.name)
                    : ref.role === 'type' ? project.resolveType(f, ref.name)
                        : project.resolveVariable(f, ref.line, ref.name) ?? project.resolveRoutine(f, ref.name);
            if (resolved && sameSymbol(resolved, sym)) { out.push({ path: doc.path, line: ref.line, start: ref.start, end: ref.end }); }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// outline and folding

export type SymbolNodeKind = 'function' | 'method' | 'module' | 'variable' | 'constant' | 'struct' | 'enum' | 'event' | 'namespace' | 'parameter';

export interface SymbolNode {
    name: string;
    detail: string;
    kind: SymbolNodeKind;
    /** full range */
    line: number;
    endLine: number;
    /** the name */
    selection: Span;
    children: SymbolNode[];
}

/** Outline: routines, data list, types, declarations and the ;FOLD structure, nested by their lines. */
export function documentSymbols(doc: KrlDocument): SymbolNode[] {
    const nodes: SymbolNode[] = [];
    const lastLine = doc.lines.length - 1;
    for (const r of doc.routines) {
        nodes.push({
            name: r.name, detail: r.kind === 'deffct' ? `DEFFCT ${r.returnType}` : r.isModuleRoutine ? 'DEF (module)' : r.isGlobal ? 'GLOBAL DEF' : 'DEF',
            kind: r.kind === 'deffct' ? 'function' : 'method', line: r.line, endLine: r.endLine >= 0 ? r.endLine : lastLine, selection: r, children: [],
        });
    }
    if (doc.defdat) {
        nodes.push({ name: doc.defdat.name, detail: `DEFDAT${doc.defdat.isPublic ? ' PUBLIC' : ''}`, kind: 'module', line: doc.defdat.line, endLine: doc.defdat.endLine >= 0 ? doc.defdat.endLine : lastLine, selection: doc.defdat, children: [] });
    }
    for (const f of doc.folds) {
        if (f.inlineForm || !f.title) { continue; }
        const L = doc.lines[f.line];
        nodes.push({ name: f.title, detail: ';FOLD', kind: 'namespace', line: f.line, endLine: f.endLine >= 0 ? f.endLine : lastLine, selection: { line: f.line, start: L.comment, end: L.text.length }, children: [] });
    }
    for (const d of doc.decls) {
        const kind: SymbolNodeKind = d.kind === 'struc' ? 'struct' : d.kind === 'enum' ? 'enum' : d.kind === 'const' ? 'constant' : d.kind === 'signal' ? 'event' : 'variable';
        const detail = d.kind === 'struc' || d.kind === 'enum' ? d.kind.toUpperCase() : d.kind === 'signal' ? `SIGNAL ${d.type}` : `${d.type}${d.dims}`;
        nodes.push({ name: d.name, detail, kind, line: d.line, endLine: d.line, selection: d, children: [] });
    }
    for (const r of doc.routines) {
        for (const p of r.params) {
            nodes.push({ name: p.name, detail: `${p.type || 'parameter'}${p.dir ? ' :' + p.dir : ''}`, kind: 'parameter', line: p.line, endLine: p.line, selection: p, children: [] });
        }
    }
    // nest: each node goes into the smallest node containing it
    nodes.sort((a, b) => a.line - b.line || (b.endLine - b.line) - (a.endLine - a.line));
    const roots: SymbolNode[] = [];
    const stack: SymbolNode[] = [];
    for (const n of nodes) {
        while (stack.length > 0 && stack[stack.length - 1].endLine < n.endLine) { stack.pop(); }
        while (stack.length > 0 && stack[stack.length - 1].line === n.line && stack[stack.length - 1].endLine === n.line && n.endLine === n.line) { stack.pop(); }
        const parent = stack[stack.length - 1];
        (parent ? parent.children : roots).push(n);
        if (n.endLine > n.line || n.kind === 'method' || n.kind === 'function') { stack.push(n); }
    }
    return roots;
}

export interface FoldingRange { start: number; end: number; kind: 'region' | 'block'; inlineForm: boolean; }

/** ;FOLD regions (including their ;ENDFOLD, like the smartPAD) and blocks (keeping their closing line visible). */
export function foldingRanges(doc: KrlDocument): FoldingRange[] {
    const out: FoldingRange[] = [];
    for (const f of doc.folds) {
        if (f.endLine > f.line) { out.push({ start: f.line, end: f.endLine, kind: 'region', inlineForm: f.inlineForm }); }
    }
    for (const b of doc.blocks) {
        if (b.endLine - 1 > b.line) { out.push({ start: b.line, end: b.endLine - 1, kind: 'block', inlineForm: false }); }
    }
    return out;
}

/** Type of a symbol for display. */
export function typeOfSymbol(sym: KrlSymbol): string {
    const t = symbolType(sym);
    return `${t.type}${t.dims}`;
}
