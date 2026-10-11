// krlExpr.ts
// A small recursive-descent expression parser/evaluator for KRL expressions.
// Operator priorities follow the KRL manual (Tab. 10, highest first):
//   1 NOT B_NOT   2 * /   3 + -   4 AND B_AND   5 EXOR B_EXOR   6 OR B_OR
//   7 == <> < > >= <=
// Pure logic (no vscode imports).

import {
    KrlValue, KRL_INT, KRL_REAL, KRL_BOOL, krlNumber, krlBool, valuesEqual,
    EvalContext, InvalidRead, KrlStopError, hasNoValue,
} from './krlValue';

interface Token {
    kind: 'num' | 'id' | 'str' | 'char' | 'enum' | 'op';
    value: string;
}

const WORD_OPS = new Set(['and', 'or', 'xor', 'exor', 'not', 'mod', 'div', 'b_and', 'b_or', 'b_exor', 'b_not']);
const COMPARE_OPS = ['<', '>', '<=', '>=', '==', '<>', '!=', '='];

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const s = text;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === ';') { break; } // comment
        if (c === '"') {
            const end = s.indexOf('"', i + 1);
            tokens.push({ kind: 'str', value: end < 0 ? s.slice(i) + '"' : s.slice(i, end + 1) });
            i = end < 0 ? s.length : end + 1;
            continue;
        }
        if (c === "'") {
            const end = s.indexOf("'", i + 1);
            const inner = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
            i = end < 0 ? s.length : end + 1;
            // 'B0101' (binary) and 'H1F' (hex) are integer literals
            if (/^B[01]+$/i.test(inner)) { tokens.push({ kind: 'num', value: String(parseInt(inner.slice(1), 2)) }); continue; }
            if (/^H[0-9A-F]+$/i.test(inner)) { tokens.push({ kind: 'num', value: String(parseInt(inner.slice(1), 16)) }); continue; }
            tokens.push({ kind: 'char', value: inner });
            continue;
        }
        if (c === '#') {
            const mm = /^#[A-Za-z_][\w$]*/.exec(s.slice(i));
            if (mm) { tokens.push({ kind: 'enum', value: mm[0] }); i += mm[0].length; continue; }
            i++; continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
            const mm = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
            if (mm) { tokens.push({ kind: 'num', value: mm[0] }); i += mm[0].length; continue; }
        }
        if (/[A-Za-z_$]/.test(c)) {
            const mm = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
            if (mm) { tokens.push({ kind: 'id', value: mm[0] }); i += mm[0].length; continue; }
        }
        const two = s.slice(i, i + 2);
        if (['>=', '<=', '==', '<>', '!='].includes(two)) { tokens.push({ kind: 'op', value: two }); i += 2; continue; }
        if ('+-*/()[],.=<>{}:'.includes(c)) {
            tokens.push({ kind: 'op', value: c }); i++; continue;
        }
        i++;
    }
    return tokens;
}

class Parser {
    private pos = 0;
    /** token position of the argument being parsed (a variable passed whole may have no value: OUT parameters) */
    private argStart = -1;
    /** the last name parsePrimary looked up was not found */
    private unresolved = false;
    constructor(private tokens: Token[], private ctx: EvalContext) { }

    private report(read: InvalidRead): void {
        this.ctx.invalidRead?.(read);
    }

    parse(): KrlValue {
        return this.parseCompare();
    }

    private peek(offset = 0): Token | null { return this.tokens[this.pos + offset] ?? null; }
    private next(): Token | null { return this.tokens[this.pos++] ?? null; }
    private isOp(value: string, offset = 0): boolean {
        const t = this.peek(offset);
        return !!t && t.kind === 'op' && t.value === value;
    }
    private isWord(value: string): boolean {
        const t = this.peek();
        return !!t && t.kind === 'id' && t.value.toLowerCase() === value;
    }
    private expectOp(value: string): boolean {
        if (this.isOp(value)) { this.pos++; return true; }
        return false;
    }

    // priority 7: comparisons bind weakest
    private parseCompare(): KrlValue {
        let left = this.parseOr();
        for (;;) {
            const t = this.peek();
            if (!t || t.kind !== 'op' || !COMPARE_OPS.includes(t.value)) { return left; }
            this.pos++;
            const right = this.parseOr();
            const cmp = compare(left, right);
            switch (t.value) {
                case '<':  left = KRL_BOOL(cmp < 0); break;
                case '>':  left = KRL_BOOL(cmp > 0); break;
                case '<=': left = KRL_BOOL(cmp <= 0); break;
                case '>=': left = KRL_BOOL(cmp >= 0); break;
                case '==': case '=': left = KRL_BOOL(valuesEqual(left, right)); break;
                default:   left = KRL_BOOL(!valuesEqual(left, right)); // <>, !=
            }
        }
    }

    // priority 6
    private parseOr(): KrlValue {
        let left = this.parseExor();
        for (;;) {
            if (this.isWord('or')) { this.pos++; const r = this.parseExor(); left = KRL_BOOL(krlBool(left) || krlBool(r)); }
            else if (this.isWord('b_or')) { this.pos++; left = KRL_INT(int(left) | int(this.parseExor())); }
            else { return left; }
        }
    }

    // priority 5
    private parseExor(): KrlValue {
        let left = this.parseAnd();
        for (;;) {
            if (this.isWord('exor') || this.isWord('xor')) { this.pos++; const r = this.parseAnd(); left = KRL_BOOL(krlBool(left) !== krlBool(r)); }
            else if (this.isWord('b_exor')) { this.pos++; left = KRL_INT(int(left) ^ int(this.parseAnd())); }
            else { return left; }
        }
    }

    // priority 4
    private parseAnd(): KrlValue {
        let left = this.parseAdd();
        for (;;) {
            if (this.isWord('and')) { this.pos++; const r = this.parseAdd(); left = KRL_BOOL(krlBool(left) && krlBool(r)); }
            else if (this.isWord('b_and')) { this.pos++; left = KRL_INT(int(left) & int(this.parseAdd())); }
            else { return left; }
        }
    }

    // priority 3
    private parseAdd(): KrlValue {
        let left = this.parseMul();
        for (;;) {
            if (this.isOp('+')) { this.pos++; left = arith(left, this.parseMul(), '+'); }
            else if (this.isOp('-')) { this.pos++; left = arith(left, this.parseMul(), '-'); }
            else { return left; }
        }
    }

    // priority 2
    private parseMul(): KrlValue {
        let left = this.parseUnary();
        for (;;) {
            if (this.isOp('*')) { this.pos++; left = arith(left, this.parseUnary(), '*'); }
            else if (this.isOp('/')) { this.pos++; left = arith(left, this.parseUnary(), '/'); }
            else if (this.isWord('mod')) {
                this.pos++;
                const d = int(this.parseUnary());
                left = KRL_INT(d === 0 ? 0 : int(left) % d);
            }
            else if (this.isWord('div')) {
                this.pos++;
                const d = krlNumber(this.parseUnary());
                left = KRL_INT(d === 0 ? 0 : Math.trunc(krlNumber(left) / d));
            }
            else { return left; }
        }
    }

    // priority 1
    private parseUnary(): KrlValue {
        if (this.isWord('not')) { this.pos++; return KRL_BOOL(!krlBool(this.parseUnary())); }
        if (this.isWord('b_not')) { this.pos++; return KRL_INT(~int(this.parseUnary())); }
        if (this.isOp('-')) { this.pos++; return negate(this.parseUnary()); }
        if (this.isOp('+')) { this.pos++; return this.parseUnary(); }
        return this.parsePostfix();
    }

    private parsePostfix(): KrlValue {
        const head = this.peek();
        // a variable: a name that is not TRUE / FALSE, an operator word or a function call
        const isVariable = !!head && head.kind === 'id' && !/^(?:true|false)$/i.test(head.value)
            && !WORD_OPS.has(head.value.toLowerCase()) && !this.isOp('(', 1);
        const wholeArgument = this.pos === this.argStart;
        let v = this.parsePrimary();
        const unresolved = isVariable && this.unresolved;
        let path = head?.value ?? '';
        let wholeArray = false;
        for (;;) {
            if (this.isOp('.')) {
                this.pos++;
                const name = this.next();
                v = name && name.kind === 'id' ? memberGet(v, name.value) : { t: 'undef' };
                path += `.${name?.value ?? ''}`;
                continue;
            }
            if (this.isOp('[')) {
                this.pos++;
                // `NAME[]` addresses the whole array (e.g. CHAR arrays passed to routines)
                if (this.expectOp(']')) {
                    wholeArray = true;
                    path += '[]';
                    continue;
                }
                const indices: number[] = [];
                for (;;) {
                    const index = Math.trunc(krlNumber(this.parseCompare()));
                    indices.push(index);
                    if (isVariable && !unresolved && v.t === 'array' && (index < 1 || index > v.v.length)) {
                        this.report({ kind: 'index', path: `${path}[${indices.join(',')}]` });
                    }
                    v = indexGet(v, index);
                    if (this.expectOp(',')) { continue; }
                    break;
                }
                path += `[${indices.join(',')}]`;
                this.expectOp(']');
                continue;
            }
            break;
        }
        if (isVariable) {
            if (unresolved) {
                this.report({ kind: 'undeclared', path: head!.value });
            } else if (!wholeArray && !(wholeArgument && (this.isOp(',') || this.isOp(')'))) && hasNoValue(v)) {
                // a variable passed whole to a routine may be an OUT parameter that gets its value there
                this.report({ kind: 'uninitialized', path });
            }
        }
        return v;
    }

    private parsePrimary(): KrlValue {
        const t = this.next();
        if (!t) { return { t: 'undef' }; }
        switch (t.kind) {
            case 'num':
                return /[.eE]/.test(t.value) ? KRL_REAL(parseFloat(t.value)) : KRL_INT(parseInt(t.value, 10));
            case 'str': return { t: 'str', v: t.value.slice(1, -1) };
            case 'char': return t.value.length === 1 ? { t: 'char', v: t.value } : { t: 'str', v: t.value };
            case 'enum': return { t: 'enum', v: t.value };
            case 'id': {
                const low = t.value.toLowerCase();
                if (low === 'true') { return KRL_BOOL(true); }
                if (low === 'false') { return KRL_BOOL(false); }
                if (WORD_OPS.has(low)) { return { t: 'undef' }; }
                if (this.isOp('(')) {
                    const args = this.parseArguments();
                    return this.ctx.invokeFunction(t.value, args) ?? { t: 'undef' };
                }
                const value = this.ctx.resolveName(t.value);
                this.unresolved = value === null;
                return value ?? { t: 'undef' };
            }
            case 'op': {
                if (t.value === '(') {
                    const inner = this.parseCompare();
                    this.expectOp(')');
                    return inner;
                }
                if (t.value === '{') { return this.parseAggregate(); }
                return { t: 'undef' };
            }
        }
        return { t: 'undef' };
    }

    /** `{X 1.0, Y 2.0}`, `{E6POS: X 1}`, `{NAME[] "abc"}` or a plain list `{1, 2, 3}`. */
    private parseAggregate(): KrlValue {
        let typeName = 'STRUCT';
        if (this.peek()?.kind === 'id' && this.isOp(':', 1)) {
            typeName = this.next()!.value.toUpperCase();
            this.pos++;
        }
        const named = this.peek()?.kind === 'id' && !this.isOp(',', 1) && !this.isOp('}', 1);
        if (!named) {
            const items: KrlValue[] = [];
            while (this.peek() && !this.isOp('}')) {
                items.push(this.parseCompare());
                if (!this.expectOp(',')) { break; }
            }
            this.expectOp('}');
            return items.length > 0 || typeName === 'STRUCT'
                ? { t: 'array', v: items }
                : { t: 'struct', name: typeName, v: new Map() };
        }
        const members = new Map<string, KrlValue>();
        while (this.peek() && !this.isOp('}')) {
            const name = this.next();
            if (!name || name.kind !== 'id') { break; }
            if (this.isOp('[') && this.isOp(']', 1)) { this.pos += 2; }
            members.set(name.value.toLowerCase(), this.parseCompare());
            if (!this.expectOp(',')) { break; }
        }
        this.expectOp('}');
        return { t: 'struct', name: typeName, v: members };
    }

    private parseArguments(): KrlValue[] {
        const args: KrlValue[] = [];
        this.expectOp('(');
        if (!this.isOp(')')) {
            for (;;) {
                // omitted optional arguments: F(a,,c)
                this.argStart = this.pos;
                args.push(this.isOp(',') || this.isOp(')') ? { t: 'undef' } : this.parseCompare());
                if (this.expectOp(',')) { continue; }
                break;
            }
        }
        this.expectOp(')');
        return args;
    }
}

function int(v: KrlValue): number {
    return Math.trunc(krlNumber(v));
}

function compare(a: KrlValue, b: KrlValue): number {
    const an = krlNumber(a, Number.NaN);
    const bn = krlNumber(b, Number.NaN);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) { return an - bn; }
    const av = a.t === 'str' || a.t === 'enum' || a.t === 'char' ? a.v.toLowerCase() : `${a.t}`;
    const bv = b.t === 'str' || b.t === 'enum' || b.t === 'char' ? b.v.toLowerCase() : `${b.t}`;
    return av < bv ? -1 : av > bv ? 1 : 0;
}

function arith(a: KrlValue, b: KrlValue, op: string): KrlValue {
    const an = krlNumber(a);
    const bn = krlNumber(b);
    const isReal = a.t === 'real' || b.t === 'real';
    let v = 0;
    switch (op) {
        case '+': v = an + bn; break;
        case '-': v = an - bn; break;
        case '*': v = an * bn; break;
        case '/': v = bn === 0 ? 0 : an / bn; break;
    }
    return isReal ? KRL_REAL(v) : KRL_INT(v);
}

function negate(v: KrlValue): KrlValue {
    switch (v.t) {
        case 'int': return KRL_INT(-v.v);
        case 'real': return KRL_REAL(-v.v);
        default: return v;
    }
}

function memberGet(v: KrlValue, member: string): KrlValue {
    if (v.t === 'struct') {
        return v.v.get(member.toLowerCase()) ?? { t: 'undef' };
    }
    return { t: 'undef' };
}

function indexGet(v: KrlValue, idx: number): KrlValue {
    const i = Math.trunc(idx) - 1; // KRL arrays are 1-based
    if (v.t === 'array') {
        return (i >= 0 && i < v.v.length) ? v.v[i] : { t: 'undef' };
    }
    // a string literal passed for a CHAR[] parameter: TEXT[3] is its third character
    if (v.t === 'str') {
        return (i >= 0 && i < v.v.length) ? { t: 'char', v: v.v[i] } : { t: 'undef' };
    }
    return { t: 'undef' };
}

export function evaluateExpression(text: string, ctx: EvalContext): KrlValue {
    const tokens = tokenize(text);
    if (tokens.length === 0) { return { t: 'undef' }; }
    const parser = new Parser(tokens, ctx);
    try {
        return parser.parse();
    } catch (e) {
        // the simulator stops the statement
        if (e instanceof KrlStopError) { throw e; }
        return { t: 'undef' };
    }
}
