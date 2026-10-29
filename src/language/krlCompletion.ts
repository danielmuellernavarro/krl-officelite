// krlCompletion.ts
// Context-aware completion for KRL. What is offered depends on where the
// cursor is: point names after PTP / LIN / CIRC (the module's data list
// first), INT variables as FOR counter, numbers in arithmetic, Boolean values
// in conditions, the members of the structure before a dot, the literals of
// the expected ENUM after #, system variables with type and access after $,
// statements with snippets at the start of a line, DEF / DEFFCT named like the
// file at module level, labels after GOTO, routines after DO. Only names that
// are visible at the cursor are offered: the routine's own declarations, the
// module's data list and the globals.
// Pure logic (no vscode imports).

import * as path from 'path';
import { KrlDocument, KrlDecl, commentStart, routineAt } from './krlSyntax';
import { KrlProject, KrlSymbol } from './krlProject';
import {
    systemVariables, systemVariable, builtinRoutines, builtinRoutine, BuiltinRoutine, PREDEFINED_TYPES, POSITION_TYPES,
    NUMERIC_TYPES, systemEnums, motionInfo, memberUnit, MOTIONS,
} from './krlCatalog';
import { evaluateExpression } from '../debugger/krlExpr';
import { positionSummary, matrixOf, matrixMarkdown } from '../debugger/krlRobotFormat';

export type CompletionKind =
    | 'variable' | 'constant' | 'signal' | 'parameter' | 'field' | 'enumMember' | 'function' | 'procedure'
    | 'keyword' | 'snippet' | 'type' | 'label' | 'value' | 'system';

export interface KrlCompletion {
    label: string;
    kind: CompletionKind;
    /** short info right of the label: type, scope, file */
    detail?: string;
    /** where it comes from, right-aligned in the list: "runtime · INT", "cell.dat · E6POS", "system · BOOL[]" */
    description?: string;
    /** markdown */
    documentation?: string;
    /** text to insert; a snippet when `snippet` is set */
    insertText?: string;
    snippet?: boolean;
    sortText?: string;
    filterText?: string;
    /** selected in the list, so that Tab inserts it */
    preselect?: boolean;
    /** open the parameter hints after inserting (routine calls) */
    signatureHelp?: boolean;
    /** command to run after inserting: create a point in the data list */
    createPoint?: { name: string; datPath: string };
}

export interface CompletionResult {
    items: KrlCompletion[];
    /** column where the replaced word starts */
    replaceStart: number;
}

type Category = 'position' | 'axis' | 'numeric' | 'bool' | 'char' | 'enum' | 'struct' | 'unknown';

/**
 * Order of the suggestions: what the context asks for (members, ENUM literals), then the
 * variables - runtime variables of the routine (.src), the module's data list (.dat), the
 * globals, the system variables - then routines, standard functions and statements.
 */
const SORT = { context: '0', runtime: '1', dat: '2', global: '3', system: '4', routine: '5', builtin: '6', statement: '7', value: '8' } as const;

// ---------------------------------------------------------------------------
// helpers shared with signature help and hovers

/** Whether a column of a line is inside a comment or a string literal. */
export function inCommentOrString(lineText: string, character: number): boolean {
    const before = lineText.slice(0, character);
    if (commentStart(before) >= 0) { return true; }
    let quote = '';
    for (const c of before) {
        if (quote) { if (c === quote) { quote = ''; } continue; }
        if (c === '"' || c === "'") { quote = c; }
    }
    return quote !== '';
}

/** The access path ending at the end of `text`: `WZ_PS[i].SENSOR`, `$VEL`, `XP1`. */
export function pathBefore(text: string): string | null {
    let i = text.length;
    let depth = 0;
    while (i > 0) {
        const c = text[i - 1];
        if (c === ']') { depth++; i--; continue; }
        if (c === '[') { if (depth === 0) { break; } depth--; i--; continue; }
        if (depth > 0) { i--; continue; }
        if (/[\w$.]/.test(c) || c === ' ' && /[.[\]]/.test(text[i] ?? '')) { i--; continue; }
        break;
    }
    const p = text.slice(i).trim();
    return /^\$?[A-Za-z_]/.test(p) ? p : null;
}

/** The innermost call the column is an argument of: routine name and argument index. */
export function enclosingCall(code: string, character: number): { name: string; nameStart: number; open: number; argIndex: number } | null {
    const stack: { open: number; commas: number }[] = [];
    let quote = '';
    for (let i = 0; i < character && i < code.length; i++) {
        const c = code[i];
        if (quote) { if (c === quote) { quote = ''; } continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { stack.push({ open: c === '(' ? i : -1, commas: 0 }); continue; }
        if (c === ')' || c === ']' || c === '}') { stack.pop(); continue; }
        if (c === ',' && stack.length > 0) { stack[stack.length - 1].commas++; }
    }
    for (let s = stack.length - 1; s >= 0; s--) {
        const frame = stack[s];
        if (frame.open < 0) { return null; }
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(0, frame.open));
        if (!m) { return null; }
        return { name: m[1], nameStart: m.index, open: frame.open, argIndex: frame.commas };
    }
    return null;
}

function categoryOf(project: KrlProject, filePath: string, type: string): Category {
    const t = type.toUpperCase();
    if (!t) { return 'unknown'; }
    if (t === 'AXIS' || t === 'E6AXIS') { return 'axis'; }
    if (POSITION_TYPES.has(t)) { return 'position'; }
    if (NUMERIC_TYPES.has(t)) { return 'numeric'; }
    if (t === 'BOOL') { return 'bool'; }
    if (t === 'CHAR') { return 'char'; }
    if (project.enumValues(filePath, t)) { return 'enum'; }
    if (project.structMembers(filePath, t)) { return 'struct'; }
    return 'unknown';
}

/** Type and dimensions of a visible symbol. */
export function symbolType(sym: KrlSymbol): { type: string; dims: string } {
    switch (sym.kind) {
        case 'decl':
            if (sym.decl.kind === 'signal') { return { type: /\bTO\b/i.test(sym.decl.type) ? 'INT' : 'BOOL', dims: '' }; }
            return { type: sym.decl.type, dims: sym.decl.dims };
        case 'param': return { type: sym.param.type, dims: sym.param.dims };
        case 'routine': return { type: sym.routine.returnType, dims: '' };
        default: return { type: '', dims: '' };
    }
}

/** Markdown with the declaration of a data list entry; positions with their components and matrix. */
export function declarationMarkdown(decl: KrlDecl, fileName: string): string {
    const head = `${decl.isGlobal ? 'GLOBAL ' : ''}${decl.kind === 'const' ? 'CONST ' : ''}${decl.kind === 'signal' ? 'SIGNAL' : decl.type} ${decl.name}${decl.dims}`;
    const lines = ['```krl', decl.kind === 'signal' ? `SIGNAL ${decl.name} ${decl.type}` : head, '```', `*${fileName}*`];
    if (decl.init) {
        const value = evaluateExpression(decl.init, { resolveName: () => null, invokeFunction: () => null });
        const summary = value.t === 'struct' ? positionSummary(value.v) : null;
        if (summary && value.t === 'struct') {
            lines.push('', summary.split(', ').map(s => `\`${s}\``).join(' · '));
            const m = POSITION_TYPES.has(decl.type) && decl.type !== 'AXIS' && decl.type !== 'E6AXIS' ? matrixOf(value.v) : null;
            if (m) { lines.push('', 'Frame as homogeneous matrix:', '', matrixMarkdown(m)); }
        } else {
            lines.push('', '```krl', `${decl.name} = ${decl.init.length > 400 ? decl.init.slice(0, 400) + ' ...' : decl.init}`, '```');
        }
    }
    return lines.join('\n');
}

function scopeLabel(project: KrlProject, filePath: string, sym: KrlSymbol, scope: string): string {
    if (scope === 'local') { return 'local'; }
    if (scope === 'param') { return 'parameter'; }
    const file = path.basename(sym.doc.path);
    if (scope === 'module') { return file; }
    return `${file} (global)`;
}

// ---------------------------------------------------------------------------
// completion

const STATEMENT_SNIPPETS: { label: string; body: string; doc: string; sort?: string }[] = [
    // block bodies start as a comment (;): a block is never empty, and typing replaces it
    { label: 'IF', body: 'IF ${1:condition} THEN\n\t$2\nENDIF', doc: 'IF ... THEN ... ENDIF' },
    { label: 'IF ELSE', body: 'IF ${1:condition} THEN\n\t$2\nELSE\n\t$3\nENDIF', doc: 'IF ... THEN ... ELSE ... ENDIF' },
    { label: 'FOR', body: 'FOR ${1:i} = ${2:1} TO ${3:10}\n\t$4\nENDFOR', doc: 'Counting loop; the counter must be INT.' },
    { label: 'WHILE', body: 'WHILE ${1:condition}\n\t$2\nENDWHILE', doc: 'Loop checked before each pass.' },
    { label: 'REPEAT', body: 'REPEAT\n\t$1\nUNTIL ${2:condition}', doc: 'Loop checked after each pass.' },
    { label: 'LOOP', body: 'LOOP\n\t$1\nENDLOOP', doc: 'Endless loop (leave it with EXIT).' },
    {
        label: 'SWITCH', doc: 'State machine: SWITCH with CASE branches and a DEFAULT branch that recovers from unknown states.',
        body: 'SWITCH ${1:nState}\n\tCASE ${2:1}\n\t\t${3:; first state}\n\t\t${1:nState} = ${4:2}\n\tCASE ${4:2}\n\t\t${5:; second state}\n\t\t${1:nState} = ${2:1}\n\tDEFAULT\n\t\t; unknown state: recover\n\t\t${6:${1:nState} = ${2:1}}\nENDSWITCH',
    },
    { label: 'WAIT FOR', body: 'WAIT FOR ${1:condition}', doc: 'Waits until the condition is TRUE (advance run stop).' },
    { label: 'WAIT SEC', body: 'WAIT SEC ${1:1.0}', doc: 'Waits the given time in seconds (advance run stop).' },
    { label: 'INTERRUPT DECL', body: 'INTERRUPT DECL ${1:10} WHEN ${2:\\$IN[1]} DO ${3:IR_ROUTINE}()\nINTERRUPT ON ${1:10}', doc: 'Declares an interrupt and switches it on.' },
    { label: 'TRIGGER WHEN DISTANCE', body: 'TRIGGER WHEN DISTANCE=${1|0,1|} DELAY=${2:0} DO ${3:\\$OUT[1]=TRUE} PRIO=-1', doc: 'Switching action at the start (0) or end (1) point of the next motion.' },
    { label: 'TRIGGER WHEN PATH', body: 'TRIGGER WHEN PATH=${1:0} DELAY=${2:0} DO ${3:\\$OUT[1]=TRUE} PRIO=-1', doc: 'Switching action at a distance (mm) from the end point of the next motion.' },
    { label: 'PTP', body: 'PTP ${1:XP1}', doc: MOTIONS.PTP.doc },
    { label: 'LIN', body: 'LIN ${1:XP1}', doc: MOTIONS.LIN.doc },
    { label: 'CIRC', body: 'CIRC ${1:XAUX}, ${2:XP1}', doc: MOTIONS.CIRC.doc },
    { label: 'SPTP', body: 'SPTP ${1:XP1}', doc: MOTIONS.SPTP.doc },
    { label: 'SLIN', body: 'SLIN ${1:XP1}', doc: MOTIONS.SLIN.doc },
    { label: 'SCIRC', body: 'SCIRC ${1:XAUX}, ${2:XP1}', doc: MOTIONS.SCIRC.doc },
    { label: 'FOLD', body: ';FOLD ${1:name}\n$0\n;ENDFOLD', doc: 'A ;FOLD ... ;ENDFOLD block (collapsed on the smartPAD).' },
    { label: 'HALT', body: 'HALT', doc: 'Stops the program; it continues with START.' },
    { label: 'EXIT', body: 'EXIT', doc: 'Leaves the innermost loop.' },
    { label: 'RETURN', body: 'RETURN', doc: 'Returns from the routine (a function returns a value: RETURN value).' },
    { label: 'CONTINUE', body: 'CONTINUE', doc: 'Prevents the advance run stop of the next line.' },
    { label: 'GOTO', body: 'GOTO ${1:label}', doc: 'Jumps to a label of the routine.' },
    { label: 'BRAKE', body: 'BRAKE', doc: 'Stops the robot in an interrupt routine.' },
    { label: 'RESUME', body: 'RESUME', doc: 'Cancels the routines up to the level of the interrupt declaration.' },
    { label: 'PULSE', body: 'PULSE(\\$OUT[${1:1}], ${2:TRUE}, ${3:0.5})', doc: 'Sets an output for the given time (s).' },
];

const DECLARATION_SNIPPETS: { label: string; body: string; doc: string }[] = [
    { label: 'DECL', body: 'DECL ${1:INT} ${2:name}', doc: 'Declaration of a variable.' },
    { label: 'STRUC', body: 'STRUC ${1:NAME_T} ${2:INT} ${3:member}', doc: 'User-defined structure type.' },
    { label: 'ENUM', body: 'ENUM ${1:NAME_T} ${2:VALUE1}, ${3:VALUE2}', doc: 'User-defined enumeration type.' },
    { label: 'SIGNAL', body: 'SIGNAL ${1:name} \\$IN[${2:1}]', doc: 'Name for an input or output (or a group: $IN[1] TO $IN[8]).' },
];

export function computeCompletions(project: KrlProject, filePath: string, line: number, character: number, triggerCharacter?: string): CompletionResult | null {
    const doc = project.document(filePath);
    const L = doc?.lines[line];
    if (!doc || !L) { return null; }
    const before = L.text.slice(0, character);
    if (inCommentOrString(L.text, character)) { return null; }
    const word = /(?:[$#]?[A-Za-z_][\w$]*|[$#])$/.exec(before);
    const prefix = word ? word[0] : '';
    const replaceStart = character - prefix.length;
    const head = before.slice(0, replaceStart);
    const result = (items: KrlCompletion[]): CompletionResult => ({ items, replaceStart });
    const routine = routineAt(doc, line);

    // members of the structure before a dot
    if (/\.\s*$/.test(head)) {
        const p = pathBefore(head.replace(/\.\s*$/, ''));
        if (!p) { return null; }
        const type = project.typeOfPath(filePath, line, p);
        const members = type ? project.structMembers(filePath, type) : undefined;
        if (!members) { return result([]); }
        return result(members.map((m, i) => {
            const unit = memberUnit(type, m.name);
            return {
                label: m.name, kind: 'field', sortText: String(i).padStart(3, '0'),
                detail: `${m.type}${m.dims.length ? `[${m.dims.join(',')}]` : ''}${unit ? ` (${unit})` : ''} · ${type}`,
            };
        }));
    }

    // literals of an enumeration
    if (prefix.startsWith('#')) {
        return result(enumCompletions(project, doc, line, head));
    }

    // a space opens the suggestions only where something specific is expected
    const spaceOnly = triggerCharacter === ' ';

    if (/\bGOTO\s+$/i.test(head)) {
        return result(doc.labels.filter(l => l.routine === routine).map(l => ({ label: l.name, kind: 'label' as const, detail: `label, line ${l.line + 1}` })));
    }
    if (/^\s*WAIT\s+$/i.test(head)) {
        return result([
            { label: 'FOR', kind: 'keyword', insertText: 'FOR ', detail: 'WAIT FOR <condition>' },
            { label: 'SEC', kind: 'keyword', insertText: 'SEC ', detail: 'WAIT SEC <seconds>' },
        ]);
    }
    if (/^\s*(GLOBAL\s+)?INTERRUPT\s+$/i.test(head)) {
        return result(['DECL', 'ON', 'OFF', 'ENABLE', 'DISABLE'].map(k => ({ label: k, kind: 'keyword' as const, insertText: `${k} ` })));
    }
    if (/^\s*TRIGGER\s+$/i.test(head)) { return result([{ label: 'WHEN', kind: 'keyword', insertText: 'WHEN ' }]); }
    if (/^\s*TRIGGER\s+WHEN\s+$/i.test(head)) {
        return result([
            { label: 'DISTANCE', kind: 'keyword', insertText: 'DISTANCE=', detail: 'start (0) or end (1) point of the motion' },
            { label: 'PATH', kind: 'keyword', insertText: 'PATH=', detail: 'distance from the end point in mm' },
        ]);
    }
    if (/\bINTERRUPT\b.*\bDO\s+$/i.test(head)) { return result(routineCompletions(project, doc, 'procedure')); }
    if (/\bTRIGGER\b.*\bDO\s+$/i.test(head)) {
        return result([...routineCompletions(project, doc, 'procedure'), ...systemCompletions('statement')]);
    }

    // the name of a new routine or data list: the first one is named like the file
    if (/^\s*(GLOBAL\s+)?(DEF|DEFDAT)\s+$/i.test(head) || /^\s*(GLOBAL\s+)?DEFFCT\s+\w+\s+$/i.test(head)) {
        const isFirst = /DEFDAT/i.test(head) ? !doc.defdat : doc.routines.every(r => r.line >= line);
        return result(isFirst ? [{ label: path.basename(filePath).replace(/\.[^.]+$/, ''), kind: 'value', detail: 'named like the file' }] : []);
    }
    // types after DECL / CONST / DEFFCT
    if (/^\s*(GLOBAL\s+)?((DECL|CONST)\s+)(GLOBAL\s+)?(CONST\s+)?$/i.test(head) || /^\s*(GLOBAL\s+)?DEFFCT\s+$/i.test(head)) {
        return result(typeCompletions(project, filePath));
    }
    // a new name after the type of a declaration: nothing to suggest
    const declType = /^\s*(?:GLOBAL\s+)?(?:DECL\s+)?(?:GLOBAL\s+)?(?:CONST\s+)?([A-Za-z_][\w$]*)\s+(?:[^=]*,\s*)?$/i.exec(head);
    if (declType && (PREDEFINED_TYPES.includes(declType[1].toUpperCase()) || /^\s*(GLOBAL\s+)?(DECL|CONST)\b/i.test(head))) {
        return result([]);
    }

    // motions: points first, then the approximation options
    const motion = /^\s*([A-Za-z_]+)\s+(.*)$/.exec(head);
    const info = motion ? motionInfo(motion[1]) : undefined;
    if (motion && info) {
        const args = motion[2];
        const commas = (args.match(/,/g) ?? []).length;
        if (args.trim() === '' || (info.points === 2 && commas === 1 && /,\s*$/.test(args))) {
            return result(pointCompletions(project, doc, filePath, line, motion[1].toUpperCase()));
        }
        if (/\s$/.test(args) && !/[([{,=]\s*$/.test(args)) {
            const opts = /^S/i.test(motion[1]) ? ['WITH', 'C_SPL'] : info.cp ? ['C_DIS', 'C_VEL', 'C_ORI'] : ['C_PTP', 'C_DIS'];
            if (info.points === 2) { opts.push('CA'); }
            return result(opts.map(o => ({ label: o, kind: 'keyword' as const, detail: approximationDoc(o) })));
        }
    }

    // FOR counter: INT variables only
    if (/^\s*FOR\s+$/i.test(head)) {
        return result(variableCompletions(project, filePath, line, c => c === 'numeric' || c === 'unknown', t => t === 'INT' || t === ''));
    }

    // statement start
    if (/^\s*$/.test(head)) {
        if (spaceOnly) { return null; }
        return result(statementCompletions(project, doc, filePath, line, prefix));
    }
    if (spaceOnly) { return null; }

    // expressions: offer what fits the expected type
    const expected = expectedCategory(project, doc, filePath, line, head);
    const items: KrlCompletion[] = [];
    const filter = (c: Category) => {
        switch (expected.category) {
            case 'numeric': return c === 'numeric' || c === 'unknown';
            case 'bool': return c !== 'position' && c !== 'axis' && c !== 'struct';
            case 'position': return c === 'position' || c === 'axis' || c === 'unknown';
            case 'enum': return c === 'enum' || c === 'unknown';
            default: return true;
        }
    };
    items.push(...variableCompletions(project, filePath, line, filter));
    items.push(...routineCompletions(project, doc, 'function', expected.category));
    if (expected.category === 'enum' && expected.type) {
        for (const v of project.enumValues(filePath, expected.type) ?? []) {
            items.push({ label: `#${v}`, kind: 'enumMember', detail: expected.type, sortText: SORT.context });
        }
    }
    if (expected.category === 'bool' || expected.category === 'unknown') {
        items.push({ label: 'TRUE', kind: 'value', sortText: SORT.value }, { label: 'FALSE', kind: 'value', sortText: SORT.value });
        items.push({ label: 'NOT', kind: 'keyword', insertText: 'NOT ', sortText: SORT.value });
    }
    items.push(...systemCompletions(expected.category === 'unknown' ? 'any' : expected.category));
    return result(items);
}

function approximationDoc(option: string): string {
    switch (option) {
        case 'C_PTP': return 'approximate positioning PTP ($APO.CPTP)';
        case 'C_DIS': return 'approximate by distance ($APO.CDIS, mm)';
        case 'C_VEL': return 'approximate by velocity ($APO.CVEL, %)';
        case 'C_ORI': return 'approximate by orientation ($APO.CORI, °)';
        case 'C_SPL': return 'approximate positioning of spline motions';
        case 'WITH': return 'motion parameters for this motion only';
        case 'CA': return 'circular angle (°)';
        default: return '';
    }
}

/** What the expression at the cursor should be. */
function expectedCategory(project: KrlProject, doc: KrlDocument, filePath: string, line: number, head: string): { category: Category; type: string } {
    const typed = (type: string) => ({ category: categoryOf(project, filePath, type), type });
    // argument of a call: the type of the parameter
    const call = enclosingCall(head, head.length);
    if (call) {
        const params = parameterTypes(project, filePath, call.name);
        const t = params?.[call.argIndex];
        if (t) { return typed(t); }
        return { category: 'unknown', type: '' };
    }
    if (/\[[^\]]*$/.test(head)) { return { category: 'numeric', type: 'INT' }; }
    if (/^\s*(IF|WHILE|UNTIL|WAIT\s+FOR)\b(?!.*\bTHEN\b)/i.test(head) || /\b(AND|OR|NOT|EXOR)\s+$/i.test(head) || /\bWHEN\s+$/i.test(head)) {
        // a comparison inside the condition: the type of its left side
        const cmp = /^(.*?)\s*(==|<>|>=|<=|<|>)\s*$/.exec(head);
        if (cmp) { return typed(operandType(project, filePath, line, cmp[1])); }
        return { category: 'bool', type: 'BOOL' };
    }
    if (/^\s*FOR\b/i.test(head) || /\bSEC\s+$/i.test(head) || /[-+*/]\s*$/.test(head) || /\b(TO|STEP)\s+$/i.test(head)) {
        return { category: 'numeric', type: 'REAL' };
    }
    const cmp = /^(.*?)\s*(==|<>|>=|<=|<|>)\s*$/.exec(head);
    if (cmp) { return typed(operandType(project, filePath, line, cmp[1])); }
    const assign = /^\s*(\$?[A-Za-z_][\w$.[\], ]*?)\s*=\s*$/.exec(head);
    if (assign) { return typed(project.typeOfPath(filePath, line, assign[1])); }
    return { category: 'unknown', type: '' };
}

/**
 * Type of the operand ending at the end of `text`: an access path (`WZ_PS[i].ZUSTAND`,
 * `$MODE_OP`) or a function call (`VARSTATE("X")` has the return type of the function).
 */
export function operandType(project: KrlProject, filePath: string, line: number, text: string): string {
    const t = text.trimEnd();
    if (t.endsWith(')')) {
        let depth = 0;
        for (let i = t.length - 1; i >= 0; i--) {
            if (t[i] === ')') { depth++; }
            if (t[i] === '(' && --depth === 0) {
                const name = /([A-Za-z_$][\w$]*)\s*$/.exec(t.slice(0, i));
                if (!name) { return ''; }
                const sym = project.resolveRoutine(filePath, name[1]);
                if (sym?.kind === 'routine') { return sym.routine.returnType; }
                return builtinRoutine(name[1])?.returnType ?? '';
            }
        }
        return '';
    }
    const p = pathBefore(t);
    return p ? project.typeOfPath(filePath, line, p) : '';
}

/** Types of the parameters of a routine (user routine or standard function). */
export function parameterTypes(project: KrlProject, filePath: string, name: string): string[] | null {
    const sym = project.resolveRoutine(filePath, name);
    if (sym?.kind === 'routine') { return sym.routine.params.map(p => p.type); }
    if (sym?.kind === 'decl' && sym.decl.params) { return sym.decl.params.map(p => p.type); }
    const builtin = builtinRoutine(name);
    return builtin ? builtin.params.map(p => p.type.replace(/\[\]$/, '')) : null;
}

function variableCompletions(project: KrlProject, filePath: string, line: number, accept: (c: Category) => boolean, acceptType?: (t: string) => boolean): KrlCompletion[] {
    const out: KrlCompletion[] = [];
    const group = { local: SORT.runtime, param: SORT.runtime, module: SORT.dat, global: SORT.global };
    const categories = new Map<string, Category>();
    for (const { symbol, scope } of project.visibleVariables(filePath, line)) {
        const { type, dims } = symbolType(symbol);
        let category = categories.get(type);
        if (category === undefined) {
            category = categoryOf(project, filePath, type);
            categories.set(type, category);
        }
        if (!accept(category) || (acceptType && !acceptType(type.toUpperCase()))) { continue; }
        const name = symbol.kind === 'decl' ? symbol.decl.name : symbol.kind === 'param' ? symbol.param.name : '';
        const kind: CompletionKind = symbol.kind === 'param' ? 'parameter'
            : symbol.kind === 'decl' && symbol.decl.kind === 'const' ? 'constant'
                : symbol.kind === 'decl' && symbol.decl.kind === 'signal' ? 'signal' : 'variable';
        const typeText = `${type || '?'}${dims}`;
        const where = scope === 'local' || scope === 'param' ? 'runtime' : scope === 'module' ? path.basename(symbol.doc.path) : 'global';
        out.push({
            label: name, kind, sortText: `${group[scope]}${name.toLowerCase()}`,
            description: `${where} · ${typeText}`,
            detail: `${typeText} · ${scopeLabel(project, filePath, symbol, scope)}`,
            documentation: symbol.kind === 'decl' ? declarationMarkdown(symbol.decl, path.basename(symbol.doc.path)) : undefined,
        });
    }
    return out;
}

/** Point names for a motion: positions of the module's data list first, then locals and globals; and a new point. */
function pointCompletions(project: KrlProject, doc: KrlDocument, filePath: string, line: number, motion: string): KrlCompletion[] {
    const axisAllowed = /PTP/.test(motion);
    const out = variableCompletions(project, filePath, line, c => c === 'position' || (axisAllowed && c === 'axis'));
    const dat = project.companionDat(filePath);
    const datName = path.basename(project.companionDatPath(filePath));
    for (const item of out) {
        // inline form data of the point: FDAT F<name>, PDAT / LDAT
        const base = item.label.replace(/^X/i, '');
        const fdat = dat?.decls.some(d => d.key === `f${base.toLowerCase()}` && d.type === 'FDAT');
        if (fdat) { item.detail = `${item.detail} · FDAT F${base}`; }
    }
    out.push(
        { label: '$POS_ACT', kind: 'system', detail: 'E6POS · current position', description: 'system · E6POS', sortText: `${SORT.system}$pos_act` },
        ...(axisAllowed ? [{ label: '$AXIS_ACT', kind: 'system' as const, detail: 'E6AXIS · current axis position', description: 'system · E6AXIS', sortText: `${SORT.system}$axis_act` }] : []),
    );
    if (axisAllowed) {
        out.push({
            label: '{A1 ...}', kind: 'snippet', sortText: SORT.statement, detail: 'axis position (E6AXIS aggregate)', snippet: true,
            insertText: '{A1 ${1:0.0}, A2 ${2:-90.0}, A3 ${3:90.0}, A4 ${4:0.0}, A5 ${5:0.0}, A6 ${6:0.0}}',
        });
    }
    out.push({
        label: '{X ...}', kind: 'snippet', sortText: SORT.statement, detail: 'Cartesian position (POS aggregate)', snippet: true,
        insertText: '{X ${1:0.0}, Y ${2:0.0}, Z ${3:0.0}, A ${4:0.0}, B ${5:0.0}, C ${6:0.0}}',
    });
    // a new point in the data list: the next free XP<n>
    const taken = new Set([...(dat?.decls ?? []), ...doc.decls].map(d => d.key));
    let n = 1;
    while (taken.has(`xp${n}`)) { n++; }
    out.push({
        label: `XP${n}`, kind: 'snippet', sortText: SORT.routine, insertText: `XP${n}`, description: `new point in ${datName}`,
        detail: `new point: DECL E6POS XP${n} in ${datName}`,
        documentation: `Inserts \`XP${n}\` and declares it in **${datName}**, to be taught or edited there.`,
        createPoint: { name: `XP${n}`, datPath: project.companionDatPath(filePath) },
    });
    return out;
}

function routineCompletions(project: KrlProject, doc: KrlDocument, want: 'procedure' | 'function', category: Category = 'unknown'): KrlCompletion[] {
    const out: KrlCompletion[] = [];
    for (const sym of project.visibleRoutines(doc.path)) {
        if (sym.kind === 'routine') {
            const r = sym.routine;
            const isFct = r.kind === 'deffct';
            if ((want === 'procedure') === isFct) { continue; }
            if (want === 'function' && category !== 'unknown' && categoryOf(project, doc.path, r.returnType) !== category
                && !(category === 'bool' && categoryOf(project, doc.path, r.returnType) !== 'position')) { continue; }
            const params = r.params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ');
            out.push({
                label: r.name, kind: isFct ? 'function' : 'procedure', snippet: true, insertText: `${r.name}(${params})`,
                signatureHelp: true, sortText: `${SORT.routine}${r.name.toLowerCase()}`, description: isFct ? `function · ${r.returnType}` : 'subprogram',
                detail: `${isFct ? `DEFFCT ${r.returnType}` : 'DEF'} ${r.name}(${r.params.map(p => p.name + (p.dir ? ':' + p.dir : '')).join(', ')}) · ${path.basename(sym.doc.path)}`,
            });
        } else if (sym.kind === 'decl' && sym.decl.kind === 'ext') {
            const isFct = !!sym.decl.type;
            if ((want === 'procedure') === isFct) { continue; }
            const params = (sym.decl.params ?? []).map(p => `${p.type}${p.dims}${p.dir ? ':' + p.dir : ''}`).join(', ');
            out.push({
                label: sym.decl.name, kind: isFct ? 'function' : 'procedure', insertText: `${sym.decl.name}($0)`, snippet: true, signatureHelp: true,
                sortText: `${SORT.routine}${sym.decl.key}`, description: isFct ? `EXT function · ${sym.decl.type}` : 'EXT subprogram',
                detail: `${isFct ? `EXTFCT ${sym.decl.type}` : 'EXT'} ${sym.decl.name}(${params}) · ${path.basename(sym.doc.path)}`,
            });
        }
    }
    for (const b of builtinRoutines()) {
        const isFct = !!b.returnType;
        if (want === 'procedure' ? isFct : !isFct) { continue; }
        if (want === 'function' && category !== 'unknown' && category !== 'bool' && categoryOf(project, doc.path, b.returnType) !== category) { continue; }
        out.push(builtinCompletion(b));
    }
    return out;
}

function builtinCompletion(b: BuiltinRoutine): KrlCompletion {
    const params = b.params.filter(x => !x.optional).map((x, i) => `\${${i + 1}:${x.name.replace(/[[\]]/g, '')}}`).join(', ');
    return {
        label: b.name, kind: b.returnType ? 'function' : 'procedure', snippet: true, insertText: `${b.name}(${params})`, signatureHelp: true,
        detail: `${b.name}(${b.params.map(x => x.name).join(', ')})${b.returnType ? ': ' + b.returnType : ''}`,
        documentation: b.doc, sortText: `${SORT.builtin}${b.name.toLowerCase()}`, description: b.returnType ? `standard function · ${b.returnType}` : 'standard procedure',
    };
}

/** System variables; `want` filters by the expected kind of value. */
function systemCompletions(want: Category | 'any' | 'statement'): KrlCompletion[] {
    const out: KrlCompletion[] = [];
    for (const v of systemVariables()) {
        const t = v.type.replace(/\[\]$/, '');
        if (want === 'numeric' && !NUMERIC_TYPES.has(t)) { continue; }
        if (want === 'bool' && (POSITION_TYPES.has(t) || v.struct)) { continue; }
        if ((want === 'position' || want === 'axis') && !POSITION_TYPES.has(t)) { continue; }
        if (want === 'statement' && v.access === 'R') { continue; }
        const isArray = v.type.endsWith('[]');
        out.push({
            label: v.name, kind: 'system', sortText: `${SORT.system}${v.name.toLowerCase()}`, filterText: v.name,
            description: `system · ${v.type}${v.access === 'R' ? ' · read-only' : ''}`,
            detail: `${v.type} · ${v.access === 'R' ? 'read-only' : 'read/write'}${v.unit ? ` · ${v.unit}` : ''}`,
            documentation: systemDoc(v.name),
            insertText: isArray ? `\\${v.name}[\${1}]` : `\\${v.name}`, snippet: true,
        });
    }
    return out;
}

/** Markdown documentation of a system variable. */
export function systemDoc(name: string): string {
    const v = systemVariable(name);
    if (!v) { return ''; }
    const facts = [`**${v.name}** · \`${v.type}\` · ${v.access === 'R' ? 'read-only' : 'read/write'}`];
    if (v.unit) { facts.push(`unit: ${v.unit}`); }
    if (v.range) { facts.push(`values: ${v.range[0]} … ${v.range[1]}`); }
    if (v.index) { facts.push(`index: ${v.index[0]} … ${v.index[1]}`); }
    const lines = [facts.join(' · '), '', v.doc];
    if (v.advanceStop) { lines.push('', '*Triggers an advance run stop.*'); }
    return lines.join('\n');
}

function enumCompletions(project: KrlProject, doc: KrlDocument, line: number, head: string): KrlCompletion[] {
    const filePath = doc.path;
    let type = '';
    const call = enclosingCall(head, head.length);
    if (call) {
        type = parameterTypes(project, filePath, call.name)?.[call.argIndex] ?? '';
    } else {
        const cmp = /^(.*?)\s*(==|<>|=)\s*$/.exec(head);
        if (cmp) { type = operandType(project, filePath, line, cmp[1]); }
        if (!type && /^\s*CASE\b/i.test(head)) {
            // CASE of a SWITCH: the type of the SWITCH expression
            for (let l = line - 1; l >= 0; l--) {
                const m = /^\s*SWITCH\s+(.+)$/i.exec(doc.lines[l].code);
                if (m) { type = project.typeOfPath(filePath, l, m[1].trim()); break; }
            }
        }
    }
    const values = type ? project.enumValues(filePath, type) : undefined;
    if (values) {
        return values.map((v, i) => ({ label: `#${v}`, kind: 'enumMember' as const, detail: type, sortText: String(i).padStart(3, '0') }));
    }
    // unknown: every literal of the visible ENUM types
    const out: KrlCompletion[] = [];
    const seen = new Set<string>();
    const add = (value: string, typeName: string) => {
        const key = `${value}:${typeName}`.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push({ label: `#${value}`, kind: 'enumMember', detail: typeName }); }
    };
    for (const sym of project.visibleTypes(filePath)) {
        if (sym.kind !== 'type' || sym.type.kind !== 'enum') { continue; }
        for (const v of sym.type.values) { add(v, sym.type.name); }
    }
    for (const [name, values2] of systemEnums()) {
        for (const v of values2) { add(v, name); }
    }
    return out;
}

function typeCompletions(project: KrlProject, filePath: string): KrlCompletion[] {
    const out: KrlCompletion[] = PREDEFINED_TYPES.map(t => ({ label: t, kind: 'type' as const, sortText: `${SORT.statement}0${t}`, detail: 'predefined type' }));
    for (const sym of project.visibleTypes(filePath)) {
        if (sym.kind === 'type') {
            out.push({ label: sym.type.name, kind: 'type', detail: `${sym.type.kind.toUpperCase()} · ${path.basename(sym.doc.path)}`, sortText: `${SORT.statement}1${sym.type.name}` });
        }
    }
    for (const t of ['FDAT', 'PDAT', 'LDAT']) {
        if (!out.some(o => o.label.toUpperCase() === t)) { out.push({ label: t, kind: 'type', detail: 'inline form data', sortText: `${SORT.statement}2${t}` }); }
    }
    return out;
}

function statementCompletions(project: KrlProject, doc: KrlDocument, filePath: string, line: number, prefix = ''): KrlCompletion[] {
    const out: KrlCompletion[] = [];
    const routine = routineAt(doc, line);
    const moduleName = path.basename(filePath).replace(/\.[^.]+$/, '');
    const snippet = (label: string, body: string, documentation: string, sortText = `${SORT.statement}${label}`): KrlCompletion =>
        ({ label, kind: 'snippet', insertText: body, snippet: true, documentation, sortText, filterText: label.split(' ')[0] });

    if (doc.fileKind === 'dat') {
        if (!doc.defdat) {
            out.push(snippet('DEFDAT', `DEFDAT \${1:${moduleName}} PUBLIC\n\t$0\nENDDAT`, 'Data list of the module (named like the file).'));
        }
        // initializations of the data list's own and the global variables, then declarations
        out.push(...variableCompletions(project, filePath, line, () => true));
        for (const s of DECLARATION_SNIPPETS) { out.push(snippet(s.label, s.body, s.doc)); }
        out.push(...typeCompletions(project, filePath));
        out.push({ label: 'GLOBAL', kind: 'keyword', insertText: 'GLOBAL ', sortText: SORT.statement }, { label: 'CONST', kind: 'keyword', insertText: 'CONST ', sortText: SORT.statement });
        out.push(snippet('FOLD', ';FOLD ${1:name}\n$0\n;ENDFOLD', 'A ;FOLD ... ;ENDFOLD block.'));
        return out;
    }

    if (!routine) {
        // module level: the first routine is named like the file and callable from other modules
        const first = doc.routines.every(r => r.line > line);
        const name = first ? moduleName : 'name';
        out.push(snippet('DEF', `DEF \${1:${name}}(\${2})\n\t$0\nEND`, first ? `Main routine of the module, named like the file (${moduleName}).` : 'Local subprogram of the module.', '0DEF'));
        out.push(snippet('DEFFCT', `DEFFCT \${1|INT,REAL,BOOL,CHAR,FRAME,E6POS,E6AXIS|} \${2:${first ? moduleName : 'name'}}(\${3})\n\t$0\n\tRETURN \${4:value}\nENDFCT`, 'Function with a return value.', '0DEFFCT'));
        out.push(snippet('GLOBAL DEF', 'GLOBAL DEF ${1:name}(${2})\n\t$0\nEND', 'Subprogram callable from all modules.', '0GLOBAL DEF'));
        out.push(snippet('GLOBAL DEFFCT', 'GLOBAL DEFFCT ${1|INT,REAL,BOOL|} ${2:name}(${3})\n\t$0\n\tRETURN ${4:value}\nENDFCT', 'Function callable from all modules.', '0GLOBAL DEFFCT'));
        out.push(snippet('FOLD', ';FOLD ${1:name}\n$0\n;ENDFOLD', 'A ;FOLD ... ;ENDFOLD block.'));
        return out;
    }

    // the declaration section ends with the first instruction
    const inDeclarations = routine.firstInstruction < 0 || line <= routine.firstInstruction;
    if (inDeclarations) {
        for (const s of DECLARATION_SNIPPETS) { out.push(snippet(s.label, s.body, s.doc)); }
        out.push(...typeCompletions(project, filePath).map(t => ({ ...t, insertText: `${t.label} ` })));
    }
    // variables to assign (runtime, data list, global, system), calls, then statements
    out.push(...variableCompletions(project, filePath, line, () => true));
    out.push(...systemCompletions('statement'));
    out.push(...routineCompletions(project, doc, 'procedure'));
    // typing the start of a statement (fo, wh, wa, if, lo, ...): its templates come first, the common
    // ones first (FOR before FOLD), and the first is selected, so Tab inserts it
    const typed = prefix.toUpperCase();
    const first = typed ? STATEMENT_SNIPPETS.findIndex(s => s.label.startsWith(typed)) : -1;
    STATEMENT_SNIPPETS.forEach((s, i) => {
        const matches = typed.length > 0 && s.label.startsWith(typed);
        const item = snippet(s.label, s.body, s.doc, matches ? `${SORT.context}${String(i).padStart(2, '0')}` : undefined);
        if (i === first) { item.preselect = true; }
        out.push(item);
    });
    return out;
}
