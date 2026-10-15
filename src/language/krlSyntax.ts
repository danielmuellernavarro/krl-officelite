// krlSyntax.ts
// Parses one KRL file (.src / .sub / .dat) into a document model with source
// positions: routines and their parameters, declarations, STRUC / ENUM types,
// signals, labels, ;FOLD regions, the block structure (IF ... ENDIF, ...) and
// every name the code refers to. Syntax errors found on the way (blocks that
// do not match, ;FOLD without ;ENDFOLD, declarations after the first
// instruction, ...) are collected as issues. The statement classification is
// the one of the debugger (krlProgram.ts), so editor and simulator agree.
// Pure logic (no vscode imports).

import { classifyLine } from '../debugger/krlProgram';
import { KEYWORDS, statementKeywords } from './krlCatalog';
import { checkStatement } from './krlStatements';

// ---------------------------------------------------------------------------
// tokens

export type TokKind = 'id' | 'sys' | 'enum' | 'num' | 'str' | 'char' | 'op';

export interface Tok {
    kind: TokKind;
    text: string;
    /** columns in the line */
    start: number;
    end: number;
}

const TWO_CHAR_OPS = new Set(['>=', '<=', '==', '<>', '!=']);

/** Tokens of the code part of a line (without its comment). */
export function tokenizeCode(code: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < code.length) {
        const c = code[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
        const start = i;
        if (c === '"' || c === "'") {
            const close = code.indexOf(c, i + 1);
            i = close < 0 ? code.length : close + 1;
            const text = code.slice(start, i);
            // 'B0101' (binary) and 'H1F' (hex) are integer literals
            const kind: TokKind = c === '"' ? 'str' : /^'[BH][0-9A-F]+'$/i.test(text) ? 'num' : 'char';
            out.push({ kind, text, start, end: i });
            continue;
        }
        if (c === '#') {
            const m = /^#[A-Za-z_$][\w$]*/.exec(code.slice(i));
            i += m ? m[0].length : 1;
            out.push({ kind: m ? 'enum' : 'op', text: code.slice(start, i), start, end: i });
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
            const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(code.slice(i));
            if (m) {
                i += m[0].length;
                out.push({ kind: 'num', text: m[0], start, end: i });
                continue;
            }
        }
        if (c === '$' || /[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i))!;
            i += m[0].length;
            out.push({ kind: c === '$' ? 'sys' : 'id', text: m[0], start, end: i });
            continue;
        }
        const two = code.slice(i, i + 2);
        if (TWO_CHAR_OPS.has(two)) {
            i += 2;
            out.push({ kind: 'op', text: two, start, end: i });
            continue;
        }
        i++;
        out.push({ kind: 'op', text: c, start, end: i });
    }
    return out;
}

/** Column where the comment of a line starts (`;` outside of strings), or -1. */
export function commentStart(line: string): number {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ';') { return i; }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// document model

export type LineKind =
    | ReturnType<typeof classifyLine>
    | 'blank' | 'header' | 'interrupt' | 'trigger' | 'ext' | 'import' | 'spline' | 'endspline';

export interface KrlLine {
    text: string;
    /** the line up to its comment (same columns as `text`) */
    code: string;
    /** column of the `;` starting the comment, -1 without comment */
    comment: number;
    tokens: Tok[];
    kind: LineKind;
}

export interface Span { line: number; start: number; end: number; }

export interface KrlParamDecl extends Span {
    name: string;
    key: string;
    dir: 'IN' | 'OUT' | '';
    /** from the DECL of the parameter inside the routine, '' if not declared */
    type: string;
    dims: string;
}

export interface KrlRoutine extends Span {
    name: string;
    key: string;
    kind: 'def' | 'deffct';
    returnType: string;
    isGlobal: boolean;
    params: KrlParamDecl[];
    /** line of END / ENDFCT, -1 when missing */
    endLine: number;
    /** line of the first instruction, -1 when there is none */
    firstInstruction: number;
    /** the first routine of a .src / .sub: callable from other modules by its name */
    isModuleRoutine: boolean;
}

export type DeclKind = 'var' | 'const' | 'signal' | 'struc' | 'enum' | 'ext' | 'import';

export interface KrlDecl extends Span {
    name: string;
    key: string;
    kind: DeclKind;
    /** data type (uppercase): INT, E6POS, FDAT, ... ; for signals the I/O range text; for ext the return type */
    type: string;
    /** array dimensions as written, e.g. "[10]" or "[]" */
    dims: string;
    isGlobal: boolean;
    /** null: data list level (.dat) or module level */
    routine: KrlRoutine | null;
    /** initial value as written (data lists) */
    init: string;
    /** column of the initial value */
    initStart: number;
}

export interface KrlTypeDef extends Span {
    name: string;
    key: string;
    kind: 'struc' | 'enum';
    members: { name: string; type: string; dims: string }[];
    values: string[];
    isGlobal: boolean;
}

export interface KrlLabel extends Span {
    name: string;
    key: string;
    routine: KrlRoutine | null;
}

export interface KrlFold {
    line: number;
    /** line of ;ENDFOLD, -1 when missing */
    endLine: number;
    /** text after ;FOLD up to the inline form parameters */
    title: string;
    /** a fold generated by an inline form (;FOLD PTP P1 ...;%{PE}...) */
    inlineForm: boolean;
    /** column where the inline form parameters (;%{PE}...) start, -1 if none */
    metaStart: number;
}

export interface KrlBlock {
    kind: string;
    line: number;
    endLine: number;
}

export type RefRole = 'read' | 'write' | 'call' | 'goto' | 'type';

export interface KrlRef extends Span {
    name: string;
    key: string;
    role: RefRole;
    /** routine containing the reference */
    routine: KrlRoutine | null;
}

export interface KrlSysRef extends Span {
    name: string;
    key: string;
    /** literal index of `$OUT[5]`, NaN when the index is not a literal */
    index: number;
    write: boolean;
}

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface KrlIssue extends Span {
    message: string;
    severity: Severity;
    /** stable identifier of the check, used by quick fixes */
    code: string;
    /** fades the code (unused declarations) */
    unnecessary?: boolean;
    /** extra information for quick fixes */
    data?: Record<string, string | number>;
}

export interface KrlDocument {
    path: string;
    fileKind: 'src' | 'sub' | 'dat' | 'other';
    /** lowercased file name without extension: the module a .src and its .dat belong to */
    moduleKey: string;
    lines: KrlLine[];
    routines: KrlRoutine[];
    defdat: (Span & { name: string; key: string; isPublic: boolean; endLine: number }) | null;
    decls: KrlDecl[];
    types: KrlTypeDef[];
    labels: KrlLabel[];
    folds: KrlFold[];
    blocks: KrlBlock[];
    refs: KrlRef[];
    sysRefs: KrlSysRef[];
    issues: KrlIssue[];
}

export const MAX_NAME_LENGTH = 24;

const DECLARATION_KINDS = new Set<LineKind>(['decl', 'struc', 'enumdef', 'signal', 'ext', 'import']);
const NON_STATEMENT_KINDS = new Set<LineKind>(['blank', 'header']);

export function isInstruction(kind: LineKind): boolean {
    return !DECLARATION_KINDS.has(kind) && !NON_STATEMENT_KINDS.has(kind);
}

/** Statement kind of a line; finer than the simulator's for the statements it does not run. */
export function lineKind(code: string): LineKind {
    const t = code.trim();
    if (t === '') { return 'blank'; }
    // &ACCESS, &REL, &PARAM ...; also after a byte order mark of a UTF-8 file decoded as Windows-1252
    if (/^(?:﻿|ï»¿)?&/.test(t)) { return 'header'; }
    if (/^(?:GLOBAL\s+)?INTERRUPT\b/i.test(t)) { return 'interrupt'; }
    if (/^TRIGGER\b/i.test(t)) { return 'trigger'; }
    if (/^(?:GLOBAL\s+)?(?:EXT|EXTFCT|EXTP|EXTFCTP)\b/i.test(t)) { return 'ext'; }
    if (/^IMPORT\b/i.test(t)) { return 'import'; }
    if (/^(?:SPLINE|PTP_SPLINE)\b/i.test(t)) { return 'spline'; }
    if (/^ENDSPLINE\b/i.test(t)) { return 'endspline'; }
    if (/^(?:SPL|SLIN|SCIRC|SPTP)\b/i.test(t)) { return 'motion'; }
    if (/^TIME_BLOCK\b/i.test(t)) { return 'other'; }
    return classifyLine(t);
}

export function fileKindOf(filePath: string): KrlDocument['fileKind'] {
    const m = /\.(src|sub|dat)$/i.exec(filePath);
    return m ? (m[1].toLowerCase() as KrlDocument['fileKind']) : 'other';
}

export function moduleKeyOf(filePath: string): string {
    const base = filePath.replace(/^.*[\\/]/, '');
    return base.replace(/\.[^.]*$/, '').toLowerCase();
}

/** Index of the token closing the bracket at `open`, or tokens.length. */
function closingToken(tokens: Tok[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        const t = tokens[i].text;
        if (tokens[i].kind !== 'op') { continue; }
        if (t === '(' || t === '[' || t === '{') { depth++; }
        if (t === ')' || t === ']' || t === '}') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return tokens.length;
}

const isWord = (t: Tok | undefined, word: string): boolean =>
    !!t && t.kind === 'id' && t.text.toUpperCase() === word;

const span = (line: number, t: Tok): Span => ({ line, start: t.start, end: t.end });

// ---------------------------------------------------------------------------
// parsing

export function parseKrlDocument(filePath: string, text: string): KrlDocument {
    const doc: KrlDocument = {
        path: filePath,
        fileKind: fileKindOf(filePath),
        moduleKey: moduleKeyOf(filePath),
        lines: [],
        routines: [],
        defdat: null,
        decls: [],
        types: [],
        labels: [],
        folds: [],
        blocks: [],
        refs: [],
        sysRefs: [],
        issues: [],
    };
    const raw = text.split(/\r?\n/);
    for (const lineText of raw) {
        const comment = commentStart(lineText);
        const code = comment < 0 ? lineText : lineText.slice(0, comment);
        const kind = lineKind(code);
        doc.lines.push({ text: lineText, code, comment, tokens: kind === 'header' ? [] : tokenizeCode(code), kind });
    }
    parseStructure(doc);
    return doc;
}

interface OpenBlock {
    kind: string;
    line: number;
    tok: Tok;
    elseSeen?: boolean;
}

const OPENERS: Record<string, string> = {
    if: 'IF', for: 'FOR', while: 'WHILE', loop: 'LOOP', repeat: 'REPEAT', switch: 'SWITCH', spline: 'SPLINE',
};
const CLOSERS: Record<string, { opens: string; word: string }> = {
    endif: { opens: 'if', word: 'ENDIF' },
    endfor: { opens: 'for', word: 'ENDFOR' },
    endwhile: { opens: 'while', word: 'ENDWHILE' },
    endloop: { opens: 'loop', word: 'ENDLOOP' },
    until: { opens: 'repeat', word: 'UNTIL' },
    endswitch: { opens: 'switch', word: 'ENDSWITCH' },
    endspline: { opens: 'spline', word: 'ENDSPLINE' },
};

function parseStructure(doc: KrlDocument): void {
    const issue = (s: Span, severity: Severity, code: string, message: string, data?: KrlIssue['data']) =>
        doc.issues.push({ ...s, severity, code, message, data });
    const isDat = doc.fileKind === 'dat';

    let routine: KrlRoutine | null = null;
    let routineTok: Tok | null = null;
    const blocks: OpenBlock[] = [];
    const folds: KrlFold[] = [];
    let blockFoldStarts: { kind: string; line: number }[] = [];

    /** report the blocks still open when their routine ends */
    const closeOpenBlocks = (atLine: number) => {
        for (const b of blocks) {
            const closer = Object.values(CLOSERS).find(c => c.opens === b.kind)?.word ?? 'END';
            issue(span(b.line, b.tok), 'error', 'unclosedBlock',
                `${OPENERS[b.kind] ?? b.kind.toUpperCase()} without ${closer}`, { insert: closer, beforeLine: atLine });
        }
        blocks.length = 0;
        blockFoldStarts = [];
    };

    const endRoutine = (line: number, closer: Tok | null, kind: 'end' | 'endfct') => {
        if (!routine) {
            if (closer) { issue(span(line, closer), 'error', 'unmatchedEnd', `${closer.text.toUpperCase()} without ${kind === 'end' ? 'DEF' : 'DEFFCT'}`); }
            return;
        }
        closeOpenBlocks(line);
        if (closer && routine.kind === 'deffct' && kind === 'end') {
            issue(span(line, closer), 'error', 'wrongEnd', `DEFFCT ${routine.name} must end with ENDFCT`);
        } else if (closer && routine.kind === 'def' && kind === 'endfct') {
            issue(span(line, closer), 'error', 'wrongEnd', `DEF ${routine.name} must end with END`);
        }
        routine.endLine = line;
        doc.blocks.push({ kind: routine.kind, line: routine.line, endLine: line });
        routine = null;
        routineTok = null;
    };

    for (let ln = 0; ln < doc.lines.length; ln++) {
        const L = doc.lines[ln];
        const toks = L.tokens;

        // ;FOLD / ;ENDFOLD markers on comment-only lines
        if (L.comment >= 0 && L.code.trim() === '') {
            const comment = L.text.slice(L.comment);
            const fold = /^;\s*FOLD\b\s?(.*)$/i.exec(comment);
            if (fold) {
                const meta = fold[1].search(/;\s*%\{/);
                const title = (meta >= 0 ? fold[1].slice(0, meta) : fold[1]).trim();
                const metaStart = meta >= 0 ? L.comment + comment.length - fold[1].length + meta : -1;
                folds.push({ line: ln, endLine: -1, title, inlineForm: meta >= 0, metaStart });
            } else if (/^;\s*ENDFOLD\b/i.test(comment)) {
                const open = folds.pop();
                if (open) {
                    open.endLine = ln;
                    doc.folds.push(open);
                } else {
                    issue({ line: ln, start: L.comment, end: L.text.length }, 'warning', 'unmatchedEndfold', ';ENDFOLD without ;FOLD');
                }
            }
        }
        if (L.kind === 'blank' || L.kind === 'header' || toks.length === 0) { continue; }
        const first = toks[0];
        checkStatementSyntax(doc, ln, issue);

        switch (L.kind) {
            case 'prog': case 'fct': {
                if (routine) {
                    issue(span(routine.line, routineTok!), 'error', 'unclosedRoutine',
                        `${routine.kind === 'def' ? 'DEF' : 'DEFFCT'} ${routine.name} without ${routine.kind === 'def' ? 'END' : 'ENDFCT'}`,
                        { insert: routine.kind === 'def' ? 'END' : 'ENDFCT', beforeLine: ln });
                    endRoutine(ln - 1, null, routine.kind === 'def' ? 'end' : 'endfct');
                }
                const r = parseRoutineHeader(doc, ln, L.kind === 'fct' ? 'deffct' : 'def');
                if (r) {
                    routine = r;
                    routineTok = toks.find(t => isWord(t, 'DEF') || isWord(t, 'DEFFCT')) ?? first;
                    doc.routines.push(r);
                    if (isDat) { issue(span(ln, routineTok), 'error', 'routineInDat', 'Routines cannot be defined in a data list (.dat)'); }
                }
                continue;
            }
            case 'end': endRoutine(ln, first, 'end'); continue;
            case 'endfct': endRoutine(ln, first, 'endfct'); continue;
            case 'defdat': {
                const nameTok = toks.find((t, i) => i > 0 && (t.kind === 'id' || t.kind === 'sys') && isWord(toks[i - 1], 'DEFDAT'));
                if (nameTok) {
                    doc.defdat = {
                        ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(),
                        isPublic: toks.some(t => isWord(t, 'PUBLIC')), endLine: -1,
                    };
                }
                if (!isDat) { issue(span(ln, first), 'error', 'defdatInSrc', 'DEFDAT belongs in a data list (.dat)'); }
                continue;
            }
            case 'enddat':
                if (doc.defdat) {
                    doc.defdat.endLine = ln;
                    doc.blocks.push({ kind: 'defdat', line: doc.defdat.line, endLine: ln });
                } else {
                    issue(span(ln, first), 'error', 'unmatchedEnd', 'ENDDAT without DEFDAT');
                }
                continue;
            default: break;
        }

        // declarations and instructions inside routines
        if (routine) {
            if (isInstruction(L.kind)) {
                if (routine.firstInstruction < 0) { routine.firstInstruction = ln; }
            } else if (routine.firstInstruction >= 0 && L.kind !== 'ext' && L.kind !== 'import') {
                issue(span(ln, first), 'error', 'declAfterInstruction',
                    `Declarations must come before the first instruction of ${routine.name} (line ${routine.firstInstruction + 1})`,
                    { routineLine: routine.line });
            }
        } else if (isInstruction(L.kind) && !(isDat && (L.kind === 'assign' || L.kind === 'other'))) {
            if (isDat && doc.defdat && doc.defdat.endLine < 0) {
                issue(span(ln, first), 'error', 'instructionInDat', 'Instructions are not allowed in a data list');
            } else if (!isDat) {
                issue(span(ln, first), 'error', 'outsideRoutine', 'Statement outside of a DEF ... END routine');
            }
        }

        // block structure
        if (OPENERS[L.kind]) {
            blocks.push({ kind: L.kind, line: ln, tok: first });
            blockFoldStarts.push({ kind: L.kind, line: ln });
        } else if (CLOSERS[L.kind]) {
            const closer = CLOSERS[L.kind];
            const at = findOpen(blocks, closer.opens);
            if (at < 0) {
                issue(span(ln, first), 'error', 'unmatchedClose', `${closer.word} without ${OPENERS[closer.opens]}`);
            } else {
                for (let i = blocks.length - 1; i > at; i--) {
                    const inner = blocks[i];
                    const innerCloser = Object.values(CLOSERS).find(c => c.opens === inner.kind)!.word;
                    issue(span(inner.line, inner.tok), 'error', 'unclosedBlock', `${OPENERS[inner.kind]} without ${innerCloser}`,
                        { insert: innerCloser, beforeLine: ln });
                }
                blocks.length = at;
                // folding: the part since the last ELSE / CASE, else since the opener
                const startIdx = findFoldStart(blockFoldStarts, closer.opens);
                if (startIdx >= 0) {
                    const starts = blockFoldStarts.splice(startIdx);
                    for (const s of starts.filter(x => x.kind === closer.opens || x.kind === 'branch')) {
                        doc.blocks.push({ kind: s.kind, line: s.line, endLine: ln });
                    }
                }
            }
        } else if (L.kind === 'else' || L.kind === 'case' || L.kind === 'default') {
            const want = L.kind === 'else' ? 'if' : 'switch';
            const top = blocks[blocks.length - 1];
            if (!top || top.kind !== want) {
                issue(span(ln, first), 'error', 'misplacedBranch', `${first.text.toUpperCase()} outside of ${want === 'if' ? 'IF ... ENDIF' : 'SWITCH ... ENDSWITCH'}`);
            } else if (L.kind === 'else' && top.elseSeen) {
                issue(span(ln, first), 'error', 'misplacedBranch', 'IF has more than one ELSE');
            } else {
                if (L.kind === 'else') { top.elseSeen = true; }
                // the previous branch folds up to here
                closeBranchFold(doc, blockFoldStarts, ln);
                blockFoldStarts.push({ kind: 'branch', line: ln });
            }
        }

        collectDeclarations(doc, ln, routine, issue);
        collectReferences(doc, ln, routine);
    }

    if (routine) {
        const r: KrlRoutine = routine;
        issue(span(r.line, routineTok!), 'error', 'unclosedRoutine',
            `${r.kind === 'def' ? 'DEF' : 'DEFFCT'} ${r.name} without ${r.kind === 'def' ? 'END' : 'ENDFCT'}`,
            { insert: r.kind === 'def' ? 'END' : 'ENDFCT', beforeLine: doc.lines.length });
        endRoutine(doc.lines.length - 1, null, r.kind === 'def' ? 'end' : 'endfct');
        r.endLine = -1;
    } else {
        closeOpenBlocks(doc.lines.length);
    }
    if (doc.defdat && doc.defdat.endLine < 0) {
        issue(doc.defdat, 'error', 'unclosedRoutine', `DEFDAT ${doc.defdat.name} without ENDDAT`, { insert: 'ENDDAT', beforeLine: doc.lines.length });
    }
    for (const f of folds) {
        const L = doc.lines[f.line];
        issue({ line: f.line, start: L.comment, end: L.text.length }, 'warning', 'unclosedFold',
            `;FOLD ${f.title} without ;ENDFOLD`, { insert: ';ENDFOLD', beforeLine: findFoldEnd(doc, f) });
        doc.folds.push(f);
    }
    doc.folds.sort((a, b) => a.line - b.line);
    checkModuleNames(doc, issue);
}

function findOpen(blocks: OpenBlock[], kind: string): number {
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === kind) { return i; }
    }
    return -1;
}

/** Index in the fold start list of the opener of `kind` (branches above it belong to it). */
function findFoldStart(starts: { kind: string; line: number }[], kind: string): number {
    for (let i = starts.length - 1; i >= 0; i--) {
        if (starts[i].kind === kind) { return i; }
    }
    return -1;
}

/** An ELSE / CASE ends the fold of the branch before it. */
function closeBranchFold(doc: KrlDocument, starts: { kind: string; line: number }[], ln: number): void {
    const last = starts[starts.length - 1];
    if (last && ln - 1 > last.line) {
        doc.blocks.push({ kind: last.kind, line: last.line, endLine: ln });
    }
    if (last?.kind === 'branch') { starts.pop(); }
}

/** Where a missing ;ENDFOLD most likely belongs: before the next ;FOLD or routine end at the same level. */
function findFoldEnd(doc: KrlDocument, fold: KrlFold): number {
    for (let ln = fold.line + 1; ln < doc.lines.length; ln++) {
        const L = doc.lines[ln];
        if (L.kind === 'end' || L.kind === 'endfct' || L.kind === 'enddat') { return ln; }
        if (L.comment >= 0 && L.code.trim() === '' && /^;\s*FOLD\b/i.test(L.text.slice(L.comment))) { return ln; }
    }
    return doc.lines.length;
}

function parseRoutineHeader(doc: KrlDocument, ln: number, kind: 'def' | 'deffct'): KrlRoutine | null {
    const toks = doc.lines[ln].tokens;
    let i = 0;
    let isGlobal = false;
    if (isWord(toks[i], 'GLOBAL')) { isGlobal = true; i++; }
    i++; // DEF / DEFFCT
    let returnType = '';
    if (kind === 'deffct') {
        const typeTok = toks[i];
        if (!typeTok) { return null; }
        returnType = typeTok.text.toUpperCase();
        i++;
        // DEFFCT CHAR NAME[] is not allowed, but arrays of the return type are skipped
        if (toks[i]?.text === '[') { i = closingToken(toks, i) + 1; }
    }
    const nameTok = toks[i];
    if (!nameTok || (nameTok.kind !== 'id' && nameTok.kind !== 'sys')) { return null; }
    const params: KrlParamDecl[] = [];
    const open = toks.findIndex((t, j) => j > i && t.text === '(');
    if (open >= 0) {
        const close = closingToken(toks, open);
        let j = open + 1;
        while (j < close) {
            const pTok = toks[j];
            if (pTok.kind === 'id' || pTok.kind === 'sys') {
                let k = j + 1;
                let dims = '';
                if (toks[k]?.text === '[') {
                    const c = closingToken(toks, k);
                    dims = doc.lines[ln].code.slice(toks[k].start, (toks[c] ?? toks[k]).end);
                    k = c + 1;
                }
                let dir: KrlParamDecl['dir'] = '';
                if (toks[k]?.text === ':' && (isWord(toks[k + 1], 'IN') || isWord(toks[k + 1], 'OUT'))) {
                    dir = toks[k + 1].text.toUpperCase() as KrlParamDecl['dir'];
                    k += 2;
                }
                params.push({ ...span(ln, pTok), name: pTok.text, key: pTok.text.toLowerCase(), dir, type: '', dims });
                j = k;
                while (j < close && toks[j].text !== ',') { j++; }
            }
            j++;
        }
    }
    return {
        ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(), kind, returnType, isGlobal, params,
        endLine: -1, firstInstruction: -1,
        isModuleRoutine: doc.routines.length === 0 && doc.fileKind !== 'dat',
    };
}

/** The first syntax error of the statement of a line (see krlStatements.ts). */
function checkStatementSyntax(doc: KrlDocument, ln: number, issue: (s: Span, sev: Severity, code: string, msg: string, data?: KrlIssue['data']) => void): void {
    const problem = checkStatement(doc.lines[ln]);
    if (problem) {
        issue({ line: ln, start: problem.start, end: problem.end }, 'error', problem.code, problem.message, problem.data);
    }
}

/** Declarations, types, signals and labels of a line. */
function collectDeclarations(doc: KrlDocument, ln: number, routine: KrlRoutine | null,
    issue: (s: Span, sev: Severity, code: string, msg: string, data?: KrlIssue['data']) => void): void {
    const L = doc.lines[ln];
    const toks = L.tokens;
    const nameCheck = (t: Tok) => {
        if (t.text.length > MAX_NAME_LENGTH) {
            issue(span(ln, t), 'error', 'nameTooLong', `${t.text} is longer than ${MAX_NAME_LENGTH} characters`);
        }
    };
    let i = 0;
    let isGlobal = false;
    const skipModifiers = () => {
        for (;;) {
            if (isWord(toks[i], 'GLOBAL')) { isGlobal = true; i++; continue; }
            if (isWord(toks[i], 'DECL')) { i++; continue; }
            break;
        }
    };
    switch (L.kind) {
        case 'decl': {
            skipModifiers();
            let isConst = false;
            if (isWord(toks[i], 'CONST')) { isConst = true; i++; skipModifiers(); }
            const typeTok = toks[i];
            if (!typeTok) { return; }
            const type = typeTok.text.toUpperCase();
            i++;
            while (i < toks.length) {
                const nameTok = toks[i];
                if (!nameTok || (nameTok.kind !== 'id' && nameTok.kind !== 'sys')) { break; }
                i++;
                let dims = '';
                if (toks[i]?.text === '[') {
                    const c = closingToken(toks, i);
                    dims = L.code.slice(toks[i].start, (toks[c] ?? toks[toks.length - 1]).end);
                    i = c + 1;
                }
                let init = '';
                let initStart = -1;
                if (toks[i]?.text === '=') {
                    initStart = toks[i].end;
                    let depth = 0;
                    i++;
                    while (i < toks.length) {
                        const t = toks[i].text;
                        if (toks[i].kind === 'op') {
                            if (t === '(' || t === '[' || t === '{') { depth++; }
                            if (t === ')' || t === ']' || t === '}') { depth--; }
                            if (t === ',' && depth === 0) { break; }
                        }
                        i++;
                    }
                    init = L.code.slice(initStart, toks[i] ? toks[i].start : L.code.length).trim();
                    while (initStart < L.code.length && L.code[initStart] === ' ') { initStart++; }
                }
                // DECL INT P inside a routine with parameter P declares the parameter's type
                const param = routine?.params.find(pp => pp.key === nameTok.text.toLowerCase());
                if (param) {
                    param.type = type;
                    param.dims = dims;
                } else {
                    nameCheck(nameTok);
                    doc.decls.push({
                        ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(),
                        kind: isConst ? 'const' : 'var', type, dims, isGlobal, routine, init, initStart,
                    });
                }
                if (toks[i]?.text === ',') { i++; } else { break; }
            }
            return;
        }
        case 'struc': case 'enumdef': {
            skipModifiers();
            i++; // STRUC / ENUM
            const nameTok = toks[i];
            if (!nameTok || nameTok.kind !== 'id') { return; }
            nameCheck(nameTok);
            const body = L.code.slice(nameTok.end);
            const def: KrlTypeDef = {
                ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(),
                kind: L.kind === 'struc' ? 'struc' : 'enum', members: [], values: [], isGlobal,
            };
            if (def.kind === 'enum') {
                def.values = body.split(',').map(v => v.trim()).filter(Boolean);
            } else {
                let type = 'INT';
                for (const piece of splitTopLevel(body)) {
                    const words = piece.trim().split(/\s+/).filter(Boolean);
                    if (words.length === 0) { continue; }
                    if (words.length >= 2) { type = words[0].toUpperCase(); }
                    const decl = (words.length >= 2 ? words.slice(1) : words).join('');
                    const m = /^([A-Za-z_$][\w$]*)(\[[^\]]*\])?$/.exec(decl);
                    if (m) { def.members.push({ name: m[1], type, dims: m[2] ?? '' }); }
                }
            }
            doc.types.push(def);
            doc.decls.push({ ...span(ln, nameTok), name: nameTok.text, key: def.key, kind: def.kind, type: def.kind.toUpperCase(), dims: '', isGlobal, routine, init: '', initStart: -1 });
            return;
        }
        case 'signal': {
            skipModifiers();
            i++; // SIGNAL
            const nameTok = toks[i];
            if (!nameTok || nameTok.kind !== 'id') { return; }
            nameCheck(nameTok);
            const target = L.code.slice(nameTok.end).trim();
            doc.decls.push({ ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(), kind: 'signal', type: target, dims: '', isGlobal, routine, init: '', initStart: -1 });
            return;
        }
        case 'ext': {
            // EXT NAME(params) / EXTFCT TYPE NAME(params): routines of other modules
            skipModifiers();
            const isFct = /^EXTFCT/i.test(toks[i]?.text ?? '');
            i += isFct ? 2 : 1;
            const nameTok = toks[i];
            if (!nameTok || nameTok.kind !== 'id') { return; }
            doc.decls.push({ ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(), kind: 'ext', type: isFct ? (toks[i - 1]?.text ?? '').toUpperCase() : '', dims: '', isGlobal, routine, init: '', initStart: -1 });
            return;
        }
        case 'import': {
            // IMPORT INT NAME IS /R1/MODULE..NAME
            const typeTok = toks[1];
            const nameTok = toks[2];
            if (!typeTok || !nameTok || nameTok.kind !== 'id') { return; }
            doc.decls.push({ ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(), kind: 'import', type: typeTok.text.toUpperCase(), dims: '', isGlobal: false, routine, init: '', initStart: -1 });
            return;
        }
        case 'label': {
            const nameTok = toks[0];
            doc.labels.push({ ...span(ln, nameTok), name: nameTok.text, key: nameTok.text.toLowerCase(), routine });
            return;
        }
        default: return;
    }
}

/** Split on commas outside of brackets. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') { depth++; }
        if (c === ')' || c === ']' || c === '}') { depth--; }
        if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
}

/** Names a statement refers to (variables, routines, labels, types), and the system variables it uses. */
function collectReferences(doc: KrlDocument, ln: number, routine: KrlRoutine | null): void {
    const L = doc.lines[ln];
    const toks = L.tokens;
    if (toks.length === 0) { return; }
    let from = 0;
    let to = toks.length;
    switch (L.kind) {
        case 'prog': case 'fct': case 'defdat': case 'end': case 'endfct': case 'enddat':
        case 'struc': case 'enumdef': case 'label': case 'ext': case 'import':
            return;
        case 'decl': {
            // only the initial values refer to other names; the type is a type reference
            const typeIdx = toks.findIndex(t => t.kind === 'id' && !['global', 'decl', 'const'].includes(t.text.toLowerCase()));
            if (typeIdx >= 0) { doc.refs.push({ ...span(ln, toks[typeIdx]), name: toks[typeIdx].text, key: toks[typeIdx].text.toLowerCase(), role: 'type', routine }); }
            collectInitRefs(doc, ln, routine);
            return;
        }
        case 'signal': {
            const nameIdx = toks.findIndex((t, i) => i > 0 && isWord(toks[i - 1], 'SIGNAL'));
            from = nameIdx + 1;
            break;
        }
        case 'goto': {
            const target = toks[1];
            if (target) { doc.refs.push({ ...span(ln, target), name: target.text, key: target.text.toLowerCase(), role: 'goto', routine }); }
            return;
        }
        default: break;
    }
    // the variable an assignment writes
    let writeIdx = -1;
    if (L.kind === 'assign' || L.kind === 'for') {
        writeIdx = L.kind === 'for' ? 1 : 0;
    }
    const first = isWord(toks[0], 'GLOBAL') ? toks[1] : toks[0];
    addRefs(doc, ln, routine, toks, from, to, writeIdx, statementKeywords(first?.text ?? '', L.kind === 'motion'));
}

function collectInitRefs(doc: KrlDocument, ln: number, routine: KrlRoutine | null): void {
    const L = doc.lines[ln];
    for (const d of doc.decls) {
        if (d.line !== ln || !d.init) { continue; }
        const from = L.tokens.findIndex(t => t.start >= d.initStart);
        if (from < 0) { continue; }
        let to = from;
        while (to < L.tokens.length && L.tokens[to].start < d.initStart + d.init.length) { to++; }
        addRefs(doc, ln, routine, L.tokens, from, to, -1);
    }
}

function addRefs(doc: KrlDocument, ln: number, routine: KrlRoutine | null, toks: Tok[], from: number, to: number, writeIdx: number,
    statementWords: Set<string> = new Set()): void {
    /** innermost open brackets, to recognize member names of aggregates {X 1, Y 2} */
    const brackets: string[] = [];
    for (let i = from; i < to; i++) {
        const t = toks[i];
        if (t.kind === 'op') {
            if (t.text === '(' || t.text === '[' || t.text === '{') { brackets.push(t.text); }
            if (t.text === ')' || t.text === ']' || t.text === '}') { brackets.pop(); }
            continue;
        }
        const prev = toks[i - 1];
        const next = toks[i + 1];
        if (t.kind === 'sys') {
            if (prev?.text === '.') { continue; }
            let index = Number.NaN;
            if (next?.text === '[' && toks[i + 2]?.kind === 'num' && toks[i + 3]?.text === ']') { index = Number(toks[i + 2].text); }
            doc.sysRefs.push({ ...span(ln, t), name: t.text, key: t.text.toLowerCase(), index, write: i === writeIdx });
            continue;
        }
        if (t.kind !== 'id') { continue; }
        const key = t.text.toLowerCase();
        if (KEYWORDS.has(key) || statementWords.has(key) || prev?.text === '.') { continue; }
        if (brackets[brackets.length - 1] === '{') {
            // {E6POS: X 1}: type name before the colon; member names after {, a comma or the colon
            if (next?.text === ':') {
                doc.refs.push({ ...span(ln, t), name: t.text, key, role: 'type', routine });
                continue;
            }
            if (prev && (prev.text === '{' || prev.text === ',' || prev.text === ':')) { continue; }
        }
        const role: RefRole = next?.text === '(' ? 'call' : i === writeIdx ? 'write' : 'read';
        doc.refs.push({ ...span(ln, t), name: t.text, key, role, routine });
    }
}

/** The first routine of a module and its DEFDAT should be named like the file. */
function checkModuleNames(doc: KrlDocument, issue: (s: Span, sev: Severity, code: string, msg: string, data?: KrlIssue['data']) => void): void {
    const fileName = doc.path.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
    const first = doc.routines[0];
    if (first && doc.fileKind !== 'dat' && first.key !== doc.moduleKey) {
        issue(first, 'warning', 'moduleName', `The first routine ${first.name} should be named like its file (${fileName})`, { name: fileName });
    }
    if (doc.defdat && doc.fileKind === 'dat' && doc.defdat.key !== doc.moduleKey) {
        issue(doc.defdat, 'warning', 'moduleName', `DEFDAT ${doc.defdat.name} should be named like its file (${fileName})`, { name: fileName });
    }
}

// ---------------------------------------------------------------------------
// queries

/** The routine containing a line (its DEF line up to its END). */
export function routineAt(doc: KrlDocument, line: number): KrlRoutine | null {
    for (const r of doc.routines) {
        const end = r.endLine >= 0 ? r.endLine : doc.lines.length - 1;
        if (line >= r.line && line <= end) { return r; }
    }
    return null;
}

/** Token at a column of a line (the one the cursor touches; the left one at a boundary). */
export function tokenAt(doc: KrlDocument, line: number, character: number): { tok: Tok; index: number } | null {
    const toks = doc.lines[line]?.tokens ?? [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (character >= t.start && character <= t.end && (t.kind !== 'op' || character < t.end)) {
            // prefer a name ending at the cursor over the operator starting there
            return { tok: t, index: i };
        }
    }
    return null;
}

/** The text of the ;FOLD fold containing a line, innermost first. */
export function foldsAt(doc: KrlDocument, line: number): KrlFold[] {
    return doc.folds
        .filter(f => line > f.line && (f.endLine < 0 || line < f.endLine))
        .sort((a, b) => b.line - a.line);
}
