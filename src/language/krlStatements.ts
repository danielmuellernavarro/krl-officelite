// krlStatements.ts
// Syntax of single KRL statements: every line is parsed with the grammar of
// its statement (assignment, call, IF ... THEN, FOR ... TO, motions with their
// points and options, DEF headers, declarations, INTERRUPT, TRIGGER, ...) and
// the expressions in it (operators, calls, indices, members, aggregates). The
// first error of a line is reported at the token where it is, e.g. a missing
// operand, a missing ')', '=' used to compare, or an unknown statement with a
// suggestion for a misspelled keyword.
// Pure logic (no vscode imports).

import type { KrlLine, Tok } from './krlSyntax';
import { KEYWORDS, motionInfo } from './krlCatalog';

export interface SyntaxProblem {
    start: number;
    end: number;
    message: string;
    /** 'syntax', or the code of an error a quick fix can repair */
    code: string;
    data?: Record<string, string | number>;
}

class Fail extends Error {
    constructor(readonly problem: SyntaxProblem) { super(problem.message); }
}

const BINARY_OPS = new Set(['+', '-', '*', '/', ':', '==', '<>', '<', '>', '<=', '>=']);
const BINARY_WORDS = new Set(['AND', 'OR', 'EXOR', 'B_AND', 'B_OR', 'B_EXOR']);
const UNARY_WORDS = new Set(['NOT', 'B_NOT']);
const APPROXIMATION = new Set(['C_PTP', 'C_DIS', 'C_VEL', 'C_ORI', 'C_SPL']);
const KNOWN_CHARS = new Set([...BINARY_OPS, '=', '!=', '(', ')', '[', ']', '{', '}', ',', '.']);
/** statement keywords a misspelled first word is compared with */
const STATEMENT_WORDS = [
    'PTP', 'LIN', 'CIRC', 'SPTP', 'SLIN', 'SCIRC', 'PTP_REL', 'LIN_REL', 'CIRC_REL', 'SPTP_REL', 'SLIN_REL', 'SCIRC_REL', 'SPL',
    'IF', 'ELSE', 'ENDIF', 'FOR', 'ENDFOR', 'WHILE', 'ENDWHILE', 'LOOP', 'ENDLOOP', 'REPEAT', 'UNTIL', 'SWITCH', 'CASE',
    'DEFAULT', 'ENDSWITCH', 'WAIT', 'HALT', 'EXIT', 'RETURN', 'GOTO', 'INTERRUPT', 'TRIGGER', 'CONTINUE', 'BRAKE', 'RESUME',
    'DECL', 'DEF', 'DEFFCT', 'END', 'ENDFCT', 'DEFDAT', 'ENDDAT', 'SIGNAL', 'STRUC', 'ENUM', 'GLOBAL', 'SPLINE', 'ENDSPLINE',
    'ON_ERROR_PROCEED', 'TIME_BLOCK', 'ANIN', 'ANOUT', 'DIGIN', 'PULSE', 'CONFIRM',
];

const describe = (t: Tok): string => (t.kind === 'str' ? 'string' : `'${t.text}'`);

/** Levenshtein distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cur = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
    }
    return row[b.length];
}

/** The closest of `words` to `word` (at most 2 edits for longer words), or ''. */
export function closestWord(word: string, words: Iterable<string>): string {
    const w = word.toUpperCase();
    if (w.length < 3) { return ''; }
    let best = '';
    let bestDistance = w.length >= 6 ? 3 : 2;
    for (const candidate of words) {
        const d = distance(w, candidate);
        if (d > 0 && d < bestDistance) { best = candidate; bestDistance = d; }
    }
    return best;
}

interface ExprContext {
    /** a condition: '=' is a mistake for '==' */
    condition?: boolean;
    /** words that end the expression (THEN, TO, DO, ...) */
    stop?: Set<string>;
}

class Cursor {
    i = 0;
    constructor(readonly toks: Tok[], readonly lineEnd: number) { }

    get done(): boolean { return this.i >= this.toks.length; }
    peek(offset = 0): Tok | undefined { return this.toks[this.i + offset]; }
    next(): Tok { return this.toks[this.i++]; }
    word(offset = 0): string {
        const t = this.peek(offset);
        return t && t.kind === 'id' ? t.text.toUpperCase() : '';
    }
    isOp(text: string, offset = 0): boolean {
        const t = this.peek(offset);
        return !!t && t.kind === 'op' && t.text === text;
    }

    /** Report an error at a token (default: the current one, or the last one at the end of the line). */
    fail(message: string, tok?: Tok, code = 'syntax', data?: SyntaxProblem['data']): never {
        const t = tok ?? this.peek() ?? this.toks[this.toks.length - 1];
        throw new Fail({ start: t ? t.start : this.lineEnd, end: t ? t.end : this.lineEnd, message, code, data });
    }

    expectWord(word: string, message: string): Tok {
        if (this.word() !== word) { this.fail(this.done ? message : `${message}, found ${describe(this.peek()!)}`); }
        return this.next();
    }

    expectOp(op: string, message: string): Tok {
        if (!this.isOp(op)) { this.fail(this.done ? message : `${message}, found ${describe(this.peek()!)}`); }
        return this.next();
    }

    /** Nothing may follow. */
    end(after = ''): void {
        const t = this.peek();
        if (!t) { return; }
        const hint = t.kind === 'id' ? closestWord(t.text, APPROXIMATION) : '';
        this.fail(`Unexpected ${describe(t)}${after ? ` after ${after}` : ''}${hint ? ` (did you mean ${hint}?)` : ''}`, t);
    }
}

// ---------------------------------------------------------------------------
// expressions

function expression(c: Cursor, ctx: ExprContext = {}): void {
    unary(c, ctx);
    for (;;) {
        const t = c.peek();
        if (!t) { return; }
        const isBinary = (t.kind === 'op' && BINARY_OPS.has(t.text)) || (t.kind === 'id' && BINARY_WORDS.has(t.text.toUpperCase()));
        if (isBinary) {
            c.next();
            if (c.done) { c.fail(`Expected a value after '${t.text}'`, t); }
            unary(c, ctx);
            continue;
        }
        if (t.kind === 'op' && t.text === '=' && ctx.condition) {
            c.fail("Use '==' to compare ('=' assigns)", t, 'compareAssign', { replace: '==' });
        }
        if (t.kind === 'op' && t.text === '!=') {
            c.fail("Use '<>' for 'not equal'", t, 'notEqual', { replace: '<>' });
        }
        return;
    }
}

function unary(c: Cursor, ctx: ExprContext): void {
    const t = c.peek();
    if (!t) { c.fail('Expected an expression'); }
    if ((t.kind === 'id' && UNARY_WORDS.has(t.text.toUpperCase())) || (t.kind === 'op' && (t.text === '-' || t.text === '+'))) {
        c.next();
        if (c.done) { c.fail(`Expected a value after '${t.text}'`, t); }
        unary(c, ctx);
        return;
    }
    postfix(c, ctx);
}

/** A value with its members and indices: XP1.X, WZ_PS[i].SENSOR.AUF, NAME[]. */
function postfix(c: Cursor, ctx: ExprContext): void {
    primary(c, ctx);
    selectors(c);
}

function selectors(c: Cursor): void {
    for (;;) {
        if (c.isOp('.')) {
            const dot = c.next();
            const m = c.peek();
            if (!m || (m.kind !== 'id' && m.kind !== 'sys')) { c.fail('Expected a member name after .', m ?? dot); }
            c.next();
            continue;
        }
        if (c.isOp('[')) {
            const open = c.next();
            // NAME[] is the whole array; TEXT[1,] a string of a CHAR array
            list(c, ']', open, true);
            continue;
        }
        return;
    }
}

/** Expressions separated by commas up to `close`; with `optional` they may be omitted: F(a,,c), TEXT[1,]. */
function list(c: Cursor, close: string, open: Tok, optional: boolean): void {
    for (;;) {
        if (!(optional && (c.isOp(',') || c.isOp(close)))) { expression(c); }
        if (c.isOp(',')) { c.next(); continue; }
        if (c.isOp(close)) { c.next(); return; }
        if (c.done) { c.fail(`Missing '${close}'`, open, 'missingClose', { insert: close }); }
        c.fail(`Unexpected ${describe(c.peek()!)}`);
    }
}

function primary(c: Cursor, ctx: ExprContext): void {
    const t = c.peek();
    if (!t) { c.fail('Expected an expression'); }
    switch (t.kind) {
        case 'num': case 'str': case 'char': case 'enum':
            c.next();
            return;
        case 'sys': case 'id': {
            const upper = t.text.toUpperCase();
            if (t.kind === 'id') {
                if (upper === 'TRUE' || upper === 'FALSE') { c.next(); return; }
                if (ctx.stop?.has(upper) || (KEYWORDS.has(upper.toLowerCase()) && !BINARY_WORDS.has(upper))) {
                    c.fail(`Expected an expression before ${t.text}`, t);
                }
            }
            c.next();
            if (c.isOp('(')) {
                const open = c.next();
                list(c, ')', open, true);
            }
            return;
        }
        case 'op':
            if (t.text === '(') {
                const open = c.next();
                expression(c, { condition: ctx.condition });
                if (!c.isOp(')')) {
                    // the end of the line or a keyword like THEN: the ')' is missing
                    const w = c.word();
                    if (c.done || ctx.stop?.has(w) || KEYWORDS.has(w.toLowerCase())) { c.fail("Missing ')'", open, 'missingClose', { insert: ')' }); }
                    c.fail(`Unexpected ${describe(c.peek()!)}`);
                }
                c.next();
                return;
            }
            if (t.text === '{') { aggregate(c); return; }
            if (t.text === ')' || t.text === ']' || t.text === '}') { c.fail(`Unexpected '${t.text}' without its opening bracket`, t); }
            c.fail(`Expected a value, found '${t.text}'`, t);
    }
}

/** `{X 1.0, Y 2.0}`, `{E6POS: X 1}`, `{POINT2[] " ", AX {A1 0}}`, or a list of values. */
function aggregate(c: Cursor): void {
    const open = c.next();
    if (c.peek()?.kind === 'id' && c.isOp(':', 1)) { c.next(); c.next(); }
    if (c.isOp('}')) { c.next(); return; }
    /** once members are named ({X 1, ...}), every item is a member with a value */
    let named = false;
    for (;;) {
        const t = c.peek();
        if (!t) { c.fail("Missing '}'", open, 'missingClose', { insert: '}' }); }
        const after = c.peek(1);
        if (named && t.kind === 'id' && (!after || (after.kind === 'op' && (after.text === ',' || after.text === '}')))) {
            c.fail(`Expected a value for ${t.text}`, t);
        }
        const member = t.kind === 'id' && !!after && !/^(TRUE|FALSE|NOT|B_NOT)$/i.test(t.text)
            && !(after.kind === 'op' && [',', '}', '.', '(', '*', '/', ':', '==', '<>', '<', '>', '<=', '>='].includes(after.text))
            && !(after.kind === 'op' && after.text === '[' && !c.isOp(']', 2))
            && !(after.kind === 'id' && BINARY_WORDS.has(after.text.toUpperCase()));
        if (member) {
            named = true;
            c.next();
            if (c.isOp('[') && c.isOp(']', 1)) { c.next(); c.next(); }
            if (c.isOp(',') || c.isOp('}')) { c.fail(`Expected a value for ${t.text}`, t); }
        }
        expression(c);
        if (c.isOp(',')) { c.next(); continue; }
        if (c.isOp('}')) { c.next(); return; }
        if (c.done) { c.fail("Missing '}'", open, 'missingClose', { insert: '}' }); }
        c.fail(`Unexpected ${describe(c.peek()!)}`);
    }
}

// ---------------------------------------------------------------------------
// statements

/** `name.member[i] = expression` */
function assignment(c: Cursor): void {
    const target = c.peek();
    if (!target || (target.kind !== 'id' && target.kind !== 'sys')) { c.fail('Expected a variable'); }
    if (target.kind === 'id' && KEYWORDS.has(target.text.toLowerCase())) { c.fail(`${target.text} is a keyword, not a variable`, target); }
    c.next();
    selectors(c);
    const eq = c.expectOp('=', "Expected '='");
    if (c.done) { c.fail("Expected a value after '='", eq); }
    expression(c);
}

/** `NAME(arguments)` */
function call(c: Cursor): void {
    const name = c.peek();
    if (!name || (name.kind !== 'id' && name.kind !== 'sys')) { c.fail('Expected a subprogram call'); }
    c.next();
    const open = c.expectOp('(', `Expected '(' after ${name.text}`);
    list(c, ')', open, true);
}

/** The assignments of a WITH clause. */
function assignments(c: Cursor): void {
    for (;;) {
        assignment(c);
        if (!c.isOp(',')) { return; }
        c.next();
    }
}

function motion(c: Cursor): void {
    const keyword = c.next();
    const info = motionInfo(keyword.text)!;
    const stop = new Set(['WITH', 'CA', ...APPROXIMATION]);
    if (c.done || stop.has(c.word())) { c.fail(`${keyword.text.toUpperCase()} requires a target point`, keyword); }
    expression(c, { stop });
    if (info.points === 2) {
        if (!c.isOp(',')) { c.fail(`${keyword.text.toUpperCase()} requires an auxiliary point and a target: ${keyword.text.toUpperCase()} XAUX, XP1`, c.peek() ?? keyword); }
        c.next();
        expression(c, { stop });
        if (c.isOp(',')) {
            c.next();
            c.expectWord('CA', 'Expected CA <angle>');
            expression(c, { stop });
        }
    }
    // relative motions may name their coordinate system: LIN_REL {X 10} #TOOL
    if (/_REL$/i.test(keyword.text) && c.peek()?.kind === 'enum') { c.next(); }
    for (;;) {
        const w = c.word();
        if (APPROXIMATION.has(w)) { c.next(); continue; }
        if (w === 'WITH') { c.next(); assignments(c); continue; }
        break;
    }
    c.end();
}

/** `[GLOBAL] DEF NAME(P1 :IN, P2[] :OUT)` / `[GLOBAL] DEFFCT TYPE NAME(...)` */
function header(c: Cursor, isFunction: boolean): void {
    if (c.word() === 'GLOBAL') { c.next(); }
    const keyword = c.next();
    if (isFunction) {
        const type = c.peek();
        if (!type || type.kind !== 'id') { c.fail('Expected the return type of the function', type ?? keyword); }
        c.next();
        if (c.isOp('[')) { const open = c.next(); list(c, ']', open, true); }
    }
    const name = c.peek();
    if (!name || (name.kind !== 'id' && name.kind !== 'sys')) { c.fail(`Expected the name of the ${isFunction ? 'function' : 'routine'}`, name ?? keyword); }
    c.next();
    const open = c.expectOp('(', `Expected '(' after ${name.text}`);
    if (c.isOp(')')) { c.next(); c.end(')'); return; }
    for (;;) {
        const p = c.peek();
        if (!p || p.kind !== 'id') { c.fail(p ? `Expected a parameter name, found ${describe(p)}` : "Missing ')'", p ?? open); }
        c.next();
        if (c.isOp('[')) { const b = c.next(); list(c, ']', b, true); }
        if (c.isOp(':')) {
            const colon = c.next();
            const dir = c.word();
            if (dir !== 'IN' && dir !== 'OUT') { c.fail("Expected IN or OUT after ':'", c.peek() ?? colon); }
            c.next();
        }
        if (c.isOp(',')) { c.next(); continue; }
        if (c.isOp(')')) { c.next(); c.end(')'); return; }
        if (c.done) { c.fail("Missing ')'", open, 'missingClose', { insert: ')' }); }
        c.fail(`Unexpected ${describe(c.peek()!)}`);
    }
}

/** `[GLOBAL] [DECL] [CONST] TYPE NAME[dims] [= value], ...` */
function declaration(c: Cursor): void {
    while (/^(GLOBAL|DECL|CONST)$/.test(c.word())) { c.next(); }
    const type = c.peek();
    if (!type || type.kind !== 'id') { c.fail('Expected a data type'); }
    c.next();
    for (;;) {
        const name = c.peek();
        if (!name || (name.kind !== 'id' && name.kind !== 'sys')) { c.fail(name ? `Expected a name, found ${describe(name)}` : `Expected a name after ${type.text}`, name ?? type); }
        if (name.kind === 'id' && KEYWORDS.has(name.text.toLowerCase())) { c.fail(`${name.text} is a keyword and cannot be a name`, name); }
        c.next();
        if (c.isOp('[')) { const open = c.next(); list(c, ']', open, true); }
        if (c.isOp('=')) {
            const eq = c.next();
            if (c.done) { c.fail("Expected a value after '='", eq); }
            expression(c);
        }
        if (c.isOp(',')) { c.next(); continue; }
        c.end();
        return;
    }
}

function interrupt(c: Cursor): void {
    if (c.word() === 'GLOBAL') { c.next(); }
    const keyword = c.next();
    switch (c.word()) {
        case 'DECL': {
            c.next();
            expression(c, { stop: new Set(['WHEN']) });
            c.expectWord('WHEN', 'Expected WHEN <condition>');
            expression(c, { condition: true, stop: new Set(['DO']) });
            c.expectWord('DO', 'Expected DO <subprogram>()');
            call(c);
            c.end();
            return;
        }
        case 'ON': case 'OFF': case 'ENABLE': case 'DISABLE':
            c.next();
            if (!c.done) { expression(c); }
            c.end();
            return;
        default:
            c.fail('Expected DECL, ON, OFF, ENABLE or DISABLE after INTERRUPT', c.peek() ?? keyword);
    }
}

function trigger(c: Cursor): void {
    const keyword = c.next();
    c.expectWord('WHEN', 'Expected WHEN after TRIGGER');
    const stop = new Set(['DELAY', 'DO', 'PRIO', 'ONSTART']);
    const kind = c.word();
    if (kind !== 'DISTANCE' && kind !== 'PATH') { c.fail('Expected DISTANCE or PATH after TRIGGER WHEN', c.peek() ?? keyword); }
    c.next();
    c.expectOp('=', `Expected '=' after ${kind}`);
    expression(c, { stop });
    if (kind === 'PATH' && c.word() === 'ONSTART') { c.next(); }
    c.expectWord('DELAY', 'Expected DELAY = <ms>');
    c.expectOp('=', "Expected '=' after DELAY");
    expression(c, { stop });
    c.expectWord('DO', 'Expected DO <statement>');
    if (c.isOp('(', 1)) { call(c); } else { assignment(c); }
    if (c.word() === 'PRIO') {
        c.next();
        c.expectOp('=', "Expected '=' after PRIO");
        expression(c);
    }
    c.end();
}

/** Statements the parser of the simulator does not distinguish, and unknown ones. */
function other(c: Cursor, toks: Tok[]): void {
    const first = toks[0];
    const word = c.word();
    switch (word) {
        case 'CONTINUE': case 'RESUME': case 'ON_ERROR_PROCEED':
            c.next();
            c.end(word);
            return;
        case 'BRAKE':
            c.next();
            if (c.word() === 'F') { c.next(); }
            c.end(word);
            return;
        case 'CONFIRM':
            c.next();
            expression(c);
            c.end();
            return;
        case 'TIME_BLOCK':
            c.next();
            if (c.word() === 'START') { c.next(); c.end(); return; }
            if (c.word() === 'PART' || c.word() === 'END') {
                const w = c.next();
                if (c.isOp('=')) { c.next(); expression(c); } else if (w.text.toUpperCase() === 'PART') { c.fail("Expected '=' after PART"); }
                c.end();
                return;
            }
            c.fail('Expected START, PART or END after TIME_BLOCK');
            return;
        case 'ANIN': case 'ANOUT': case 'DIGIN':
            c.next();
            if (c.word() !== 'ON' && c.word() !== 'OFF') { c.fail(`Expected ON or OFF after ${word}`); }
            return;
        case 'CHANNEL':
            return;
        case 'GOTO':
            c.next();
            if (c.done || c.peek()!.kind !== 'id') { c.fail('GOTO requires a label', c.peek() ?? first); }
            c.next();
            c.end();
            return;
        default: break;
    }
    // a comparison alone does nothing
    const cmp = toks.find(t => t.kind === 'op' && (t.text === '==' || t.text === '<>'));
    if (cmp && !toks.some(t => t.kind === 'op' && t.text === '=')) {
        c.fail(`A comparison is not a statement (assign with '=')`, cmp, cmp.text === '==' ? 'compareStatement' : 'syntax', cmp.text === '==' ? { replace: '=' } : undefined);
    }
    if (first.kind === 'id' || first.kind === 'sys') {
        const known = STATEMENT_WORDS.includes(first.text.toUpperCase()) || KEYWORDS.has(first.text.toLowerCase());
        const suggestion = first.kind === 'id' && !known ? closestWord(first.text, STATEMENT_WORDS) : '';
        if (suggestion) {
            c.fail(`Unknown statement '${first.text}' (did you mean ${suggestion}?)`, first, 'unknownStatement', { replace: suggestion });
        }
        if (toks.length === 1) {
            c.fail(`Unknown statement '${first.text}' (a subprogram call needs parentheses: ${first.text}())`, first, 'missingCallParens', { insert: '()' });
        }
        if (KEYWORDS.has(first.text.toLowerCase())) {
            c.i = 1;
            c.end(first.text.toUpperCase());
        }
    }
    c.fail(`Unknown statement '${first.text}'`, first);
}

/** Characters that are not KRL, strings and character literals without their closing quote. */
function lexical(line: KrlLine): SyntaxProblem | null {
    for (const t of line.tokens) {
        if (t.kind === 'str' && (t.text.length < 2 || !t.text.endsWith('"'))) {
            return { start: t.start, end: t.end, message: 'Missing closing " of the string', code: 'unterminatedString', data: { insert: '"' } };
        }
        if (t.kind === 'char' && (t.text.length < 2 || !t.text.endsWith("'"))) {
            return { start: t.start, end: t.end, message: "Missing closing ' of the character", code: 'syntax' };
        }
        if (t.kind === 'op' && !KNOWN_CHARS.has(t.text)) {
            return {
                start: t.start, end: t.end, code: 'syntax',
                message: t.text === '#' ? 'Expected the name of an enumeration literal after #' : `Unexpected character '${t.text}'`,
            };
        }
    }
    return null;
}

/** The first syntax error of a line, or null. Headers, comments and type declarations are not checked here. */
export function checkStatement(line: KrlLine): SyntaxProblem | null {
    const toks = line.tokens;
    if (toks.length === 0 || line.kind === 'header' || line.kind === 'blank') { return null; }
    const lex = lexical(line);
    if (lex) { return lex; }
    const c = new Cursor(toks, line.code.trimEnd().length);
    const keyword = toks[0].text.toUpperCase();
    try {
        switch (line.kind) {
            case 'assign': assignment(c); c.end(); break;
            case 'call': call(c); c.end(); break;
            case 'if': {
                c.next();
                if (c.done || c.word() === 'THEN') { c.fail('IF requires a condition', toks[0]); }
                expression(c, { condition: true, stop: new Set(['THEN']) });
                if (c.word() === 'THEN') { c.next(); c.end('THEN'); break; }
                if (c.done) {
                    c.fail('IF requires THEN', toks[0], 'missingThen', { insertAt: line.code.trimEnd().length, insert: ' THEN' });
                }
                c.fail(`Expected THEN, found ${describe(c.peek()!)}`);
                break;
            }
            case 'while': case 'until':
                c.next();
                if (c.done) { c.fail(`${keyword} requires a condition`, toks[0]); }
                expression(c, { condition: true });
                c.end();
                break;
            case 'switch': c.next(); expression(c); c.end(); break;
            case 'case':
                c.next();
                for (;;) {
                    expression(c);
                    if (!c.isOp(',')) { break; }
                    c.next();
                }
                c.end();
                break;
            case 'for': {
                c.next();
                const counter = c.peek();
                if (!counter || counter.kind !== 'id' || KEYWORDS.has(counter.text.toLowerCase())) {
                    c.fail('FOR requires an INT counter: FOR i = 1 TO 10', counter ?? toks[0]);
                }
                c.next();
                c.expectOp('=', "Expected '=' after the counter");
                expression(c, { stop: new Set(['TO', 'STEP']) });
                c.expectWord('TO', 'Expected TO <end value>');
                expression(c, { stop: new Set(['STEP']) });
                if (c.word() === 'STEP') { c.next(); expression(c); }
                c.end();
                break;
            }
            case 'wait':
                c.next();
                if (c.word() === 'FOR') { c.next(); expression(c, { condition: true }); c.end(); break; }
                if (c.word() === 'SEC') { c.next(); expression(c); c.end(); break; }
                c.fail('WAIT requires FOR <condition> or SEC <time>', c.peek() ?? toks[0]);
                break;
            case 'return':
                c.next();
                if (!c.done) { expression(c); }
                c.end();
                break;
            case 'else': case 'endif': case 'endfor': case 'endwhile': case 'loop': case 'endloop': case 'repeat':
            case 'endswitch': case 'default': case 'end': case 'endfct': case 'enddat': case 'halt': case 'exit': case 'endspline':
                c.next();
                c.end(keyword);
                break;
            case 'motion': motion(c); break;
            case 'prog': header(c, false); break;
            case 'fct': header(c, true); break;
            case 'defdat':
                if (c.word() === 'GLOBAL') { c.next(); }
                c.next();
                if (c.peek()?.kind !== 'id' && c.peek()?.kind !== 'sys') { c.fail('Expected the name of the data list', c.peek() ?? toks[0]); }
                c.next();
                if (c.word() === 'PUBLIC') { c.next(); }
                c.end();
                break;
            case 'decl': declaration(c); break;
            case 'interrupt': interrupt(c); break;
            case 'trigger': trigger(c); break;
            case 'spline':
                c.next();
                if (c.word() === 'WITH') { c.next(); assignments(c); }
                c.end();
                break;
            case 'other': other(c, toks); break;
            default: break;
        }
    } catch (e) {
        if (e instanceof Fail) { return e.problem; }
        throw e;
    }
    return null;
}
