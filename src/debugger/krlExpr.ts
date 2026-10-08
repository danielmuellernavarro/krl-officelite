// krlExpr.ts
// A small Pratt-style expression parser/evaluator for KRL expressions.
// Pure logic (no vscode imports).

import {
    KrlValue, KRL_INT, KRL_REAL, KRL_BOOL, krlNumber, krlBool, valuesEqual,
    EvalContext,
} from './krlValue';

interface Token {
    kind: 'num' | 'id' | 'str' | 'char' | 'enum' | 'op';
    value: string;
}

const WORD_OPS = new Set(['AND', 'OR', 'XOR', 'NOT', 'MOD', 'DIV']);

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const s = text;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"') {
            const end = s.indexOf('"', i + 1);
            tokens.push({ kind: 'str', value: end < 0 ? s.slice(i) : s.slice(i, end + 1) });
            i = end < 0 ? s.length : end + 1;
            continue;
        }
        if (c === "'") {
            const end = s.indexOf("'", i + 1);
            tokens.push({ kind: 'char', value: end < 0 ? s.slice(i) : s.slice(i, end + 1) });
            i = end < 0 ? s.length : end + 1;
            continue;
        }
        if (c === '#') {
            const m = /^#[A-Za-z_][\w$]*/.exec(s.slice(i));
            if (m) { tokens.push({ kind: 'enum', value: m[0] }); i += m[0].length; continue; }
            i++; continue;
        }
        if (/[0-9.]/.test(c)) {
            const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
            if (m) { tokens.push({ kind: 'num', value: m[0] }); i += m[0].length; continue; }
        }
        if (/[A-Za-z_$]/.test(c)) {
            const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
            if (m) { tokens.push({ kind: 'id', value: m[0] }); i += m[0].length; continue; }
        }
        const two = s.slice(i, i + 2);
        if (['>=', '<=', '==', '<>', '!='].includes(two)) { tokens.push({ kind: 'op', value: two }); i += 2; continue; }
        if (['+', '-', '*', '/', '(', ')', '[', ']', ',', '.', '=', '<', '>'].includes(c)) {
            tokens.push({ kind: 'op', value: c }); i++; continue;
        }
        i++;
    }
    return tokens;
}

class Parser {
    private pos = 0;
    constructor(private tokens: Token[], private ctx: EvalContext) { }

    parse(): KrlValue {
        const v = this.parseOr();
        return v;
    }

    private peek(): Token | null { return this.tokens[this.pos] ?? null; }
    private next(): Token | null { return this.tokens[this.pos++] ?? null; }
    private isOp(value: string): boolean {
        const t = this.peek();
        return !!t && t.kind === 'op' && t.value.toLowerCase() === value.toLowerCase();
    }
    private isWord(value: string): boolean {
        const t = this.peek();
        return !!t && t.kind === 'id' && t.value.toLowerCase() === value.toLowerCase();
    }
    private expectOp(value: string): boolean {
        if (this.isOp(value)) { this.pos++; return true; }
        return false;
    }

    // OR XOR (lowest real precedence)
    private parseOr(): KrlValue {
        let left = this.parseAnd();
        for (;;) {
            if (this.isWord('or')) { this.pos++; left = KRL_BOOL(krlBool(left) || krlBool(this.parseAnd())); }
            else if (this.isWord('xor')) { this.pos++; left = KRL_BOOL(krlBool(left) !== krlBool(this.parseAnd())); }
            else { return left; }
        }
    }

    private parseAnd(): KrlValue {
        let left = this.parseNot();
        while (this.isWord('and')) {
            this.pos++;
            const right = this.parseNot();
            left = KRL_BOOL(krlBool(left) && krlBool(right));
        }
        return left;
    }

    private parseNot(): KrlValue {
        if (this.isWord('not')) { this.pos++; return KRL_BOOL(!krlBool(this.parseNot())); }
        return this.parseCompare();
    }

    private parseCompare(): KrlValue {
        let left = this.parseAdd();
        for (;;) {
            const t = this.peek();
            if (t && t.kind === 'op' && ['<', '>', '<=', '>=', '==', '<>', '!=', '='].includes(t.value)) {
                this.pos++;
                const right = this.parseAdd();
                const cmp = compare(left, right);
                switch (t.value) {
                    case '<':  left = KRL_BOOL(cmp < 0); break;
                    case '>':  left = KRL_BOOL(cmp > 0); break;
                    case '<=': left = KRL_BOOL(cmp <= 0); break;
                    case '>=': left = KRL_BOOL(cmp >= 0); break;
                    case '==': case '=': left = KRL_BOOL(valuesEqual(left, right)); break;
                    default:   left = KRL_BOOL(!valuesEqual(left, right)); // <>, !=
                }
            } else { return left; }
        }
    }

    private parseAdd(): KrlValue {
        let left = this.parseMul();
        for (;;) {
            if (this.isOp('+')) { this.pos++; left = arith(left, this.parseMul(), '+'); }
            else if (this.isOp('-')) { this.pos++; left = arith(left, this.parseMul(), '-'); }
            else { return left; }
        }
    }

    private parseMul(): KrlValue {
        let left = this.parseUnary();
        for (;;) {
            if (this.isOp('*')) { this.pos++; left = arith(left, this.parseUnary(), '*'); }
            else if (this.isOp('/')) { this.pos++; left = arith(left, this.parseUnary(), '/'); }
            else if (this.isWord('mod')) { this.pos++; left = KRL_INT(Math.trunc(krlNumber(left)) % Math.trunc(krlNumber(this.parseUnary()))); }
            else if (this.isWord('div')) { this.pos++; const d = krlNumber(this.parseUnary()); left = KRL_INT(d === 0 ? 0 : Math.trunc(krlNumber(left) / d)); }
            else { return left; }
        }
    }

    private parseUnary(): KrlValue {
        if (this.isOp('-')) { this.pos++; const v = this.parseUnary(); return negate(v); }
        if (this.isOp('+')) { this.pos++; return this.parseUnary(); }
        return this.parsePostfix();
    }

    private parsePostfix(): KrlValue {
        let v = this.parsePrimary();
        for (;;) {
            if (this.isOp('.')) {
                this.pos++;
                const name = this.next();
                if (name && name.kind === 'id') {
                    v = memberGet(v, name.value);
                } else if (name) { v = { t: 'undef' }; }
                continue;
            }
            if (this.isOp('[')) {
                this.pos++;
                const idx = this.parseOr();
                this.expectOp(']');
                v = indexGet(v, krlNumber(idx));
                continue;
            }
            return v;
        }
    }

    private parsePrimary(): KrlValue {
        const t = this.next();
        if (!t) { return { t: 'undef' }; }
        switch (t.kind) {
            case 'num':
                return t.value.includes('.') || /[eE]/.test(t.value) ? KRL_REAL(parseFloat(t.value)) : KRL_INT(parseInt(t.value, 10));
            case 'str': return { t: 'str', v: t.value.slice(1, -1) };
            case 'char': return { t: 'char', v: t.value.slice(1, -1) };
            case 'enum': return { t: 'enum', v: t.value };
            case 'id': {
                const low = t.value.toLowerCase();
                if (low === 'true') { return KRL_BOOL(true); }
                if (low === 'false') { return KRL_BOOL(false); }
                if (WORD_OPS.has(low)) { return { t: 'undef' }; }
                // function call?
                if (this.isOp('(')) {
                    const args = this.parseArguments();
                    const invoked = this.ctx.invokeFunction(t.value, args);
                    if (invoked) { return invoked; }
                    return { t: 'undef' };
                }
                const resolved = this.ctx.resolveName(t.value);
                return resolved ?? { t: 'undef' };
            }
            case 'op': {
                if (t.value === '(') {
                    const inner = this.parseOr();
                    this.expectOp(')');
                    return inner;
                }
                return { t: 'undef' };
            }
        }
        return { t: 'undef' };
    }

    private parseArguments(): KrlValue[] {
        const args: KrlValue[] = [];
        this.expectOp('(');
        if (!this.isOp(')')) {
            for (;;) {
                args.push(this.parseOr());
                if (this.isOp(',')) { this.pos++; continue; }
                break;
            }
        }
        this.expectOp(')');
        return args;
    }
}


function compare(a: KrlValue, b: KrlValue): number {
    if (typeof a === 'undefined' || typeof b === 'undefined') { return 0; }
    const an = krlNumber(a, Number.NaN);
    const bn = krlNumber(b, Number.NaN);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) { return an - bn; }
    const av = a.t === 'str' ? a.v : `${a.t}`;
    const bv = b.t === 'str' ? b.v : `${b.t}`;
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
    const key = member.toLowerCase();
    if (v.t === 'struct') {
        return v.v.get(key) ?? { t: 'undef' };
    }
    if (v.t === 'array') {
        // some position types are stored internally as arrays of components
        const idx = ['x', 'y', 'z', 'a', 'b', 'c', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'].indexOf(key);
        if (idx >= 0 && idx < v.v.length) { return v.v[idx]; }
    }
    if (v.t === 'undef') { return { t: 'undef' }; }
    // $X.Y style system variables default to 0
    return KRL_INT(0);
}

function indexGet(v: KrlValue, idx: number): KrlValue {
    if (v.t === 'array') {
        const i = Math.trunc(idx) - 1; // KRL arrays are 1-based
        return (i >= 0 && i < v.v.length) ? v.v[i] : { t: 'undef' };
    }
    if (v.t === 'undef') { return { t: 'undef' }; }
    return KRL_INT(0);
}

export function evaluateExpression(text: string, ctx: EvalContext): KrlValue {
    const tokens = tokenize(text);
    if (tokens.length === 0) { return { t: 'undef' }; }
    const parser = new Parser(tokens, ctx);
    try {
        return parser.parse();
    } catch (e) {
        return { t: 'undef' };
    }
}

