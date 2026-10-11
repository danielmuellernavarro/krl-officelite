// krlFormatter.ts
// KRL code formatter: indents blocks (DEF, IF, FOR, SWITCH, ...), puts spaces
// around operators and after commas, keeps headers, ;FOLD lines, comments,
// string literals and the "Key=Value" options of motions (Vel=100%) as they
// are, and removes repeated blank lines. TypeScript port of the former Python
// formatter (formatter/krl.py) with the same output for code, except that the
// text of string literals and comments is no longer changed (it was: padded
// CHAR strings lost their spaces) and block keywords must be whole words
// (`caseNr = 1` is not a CASE).
// Pure logic (no vscode imports).

import { commentStart } from '../language/krlSyntax';

export interface FormatOptions {
    /** spaces per indentation level */
    indentWidth: number;
    /** add a blank line before blocks (FOR, IF, WHILE, LOOP, ...) */
    separateBeforeBlocks: boolean;
    /** add a blank line after blocks */
    separateAfterBlocks: boolean;
    /** indent the body of routines */
    indentAfterFunction: boolean;
    /** with indentAfterFunction: indent the body of the first (main) routine, too */
    indentAfterMainFunction: boolean;
    /** data lists keep their operators as they are */
    isDatFile: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
    indentWidth: 2,
    separateBeforeBlocks: false,
    separateAfterBlocks: false,
    indentAfterFunction: true,
    indentAfterMainFunction: false,
    isDatFile: false,
};

export interface FormatResult {
    /** formatted lines (without line breaks) */
    lines: string[];
    /** problems with the block structure, e.g. more END statements than blocks */
    warnings: string[];
}

/**
 * Motion / option keywords for which "Key=Value" stays compact (PTP P1 Vel=100% C_PTP=10):
 * spaces around '=' would make the instruction invalid.
 */
const MOTION_OPT_KEYS = [
    'VEL', 'C_DIS', 'C_PTP', 'PDAT', 'FDAT', 'TOOL', 'BASE', 'CONT', 'CP',
    'APO', 'PRIO', 'TRIGGER', 'WHEN', 'DISTANCE', 'EVERY', 'GEAR', 'GUN',
    'TQ', 'MAXAGC', 'FITNESS', 'POSP', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6',
    'S7', 'S8', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8',
];

// control structures (anchored like Python's re.match)
const CTRL_1LINE = /^(^|\s*)(if|while|for|loop)(\W\s*\S.*\W)((endif|endwhile|endfor|endloop);?)(\s+\S.*|\s*$)/i;
const FCN_START = /^(^|\s*)(global\s+)?(deffct|defdat|def)\b\s*(.*)$/i;
const FCN_END = /^(^|\s*)(global\s+)?(endfct|enddat|end)\b\s*(.*)$/i;
/** &ACCESS / &REL / &PARAM header lines */
const HEADER = /^\s*&.*$/;
const FOLD_MARKER = /^(\s*)(;FOLD|;ENDFOLD)(.*)$/i;
const LINE_COMMENT = /^\s*;.*$/;
const CTRL_START_FOR = /^(^|\s*)(for)\s+(.*?)\s+(to)\s+(.*)$/i;
const CTRL_START_THEN = /^(^|\s*)(if)\b\s*(.*?)\s+(then)\b\s*(.*)$/i;
const CTRL_START = /^(^|\s*)(while|loop|repeat)\b\s*(.*)$/i;
const CTRL_START_SWITCH = /^(^|\s*)(switch)\b\s*(.*)$/i;
const CTRL_CONT = /^(^|\s*)(else|case|default)\b\s*(.*)$/i;
const CTRL_END = /^(^|\s*)(endif|endwhile|endfor|endloop|endswitch|until)\b\s*(.*)$/i;
const FIND_STRING = /^(.*)"(.*)"(.*)/;

// patterns that split a line into (formatted) parts
const P_COMMENT = /^(^|.*\S)\s*(;)(.*)/;
const P_BLANK = /^\s+$/;
const P_NUM_R = /^(^|.*\W)\s*(\d+)\s*(\/)\s*(\d+)(.*)/;
const P_SIGN = /^(^|.*[([{,;:=*/])\s*(\+|-)(\w.*)/;
const P_ARG_COLON = /^(^|.*\S)\s*(:)\s*(\S.*|$)/;
const P_OP = /^(^|.*\S)\s*(<>|==|<=|>=)\s*(\S.*|$)/;
const P_2OP = /^(^|.*\S)\s*(\*|\\|\||(?<!^)&)\s*(\S.*|$)/;
const P_3OP = /^(^|.*\S)\s*(\+|-|=|!|~|<|>|(?<!^)&)\s*(\S.*|$)/;
const P_4OP = /^(^|.*\S)\s(B_|AND|OR|EXOR)\s(\S.*|$)/i;
const P_COMMA = /^(^|.*\S)\s*(,)\s*(\S.*|$)/;
const P_MULTIWS = /^(^|.*\S)(\s{2,})(\S.*|$)/;
const P_OPT_EQUAL = new RegExp(`\\b((${[...MOTION_OPT_KEYS].sort((a, b) => b.length - a.length).join('|')}))=(\\S+)`, 'i');
/** whitespace before a closing bracket: "(x, 1 )" -> "(x, 1)" */
const P_NOSPACE_CLOSE = /^(^|.*\S)\s+([)}\]])(.*)$/;

const BLANK_LINE = /^\s*$/;

type Parts = [string, string, string];

/** Placeholders (private use characters) for string literals and comments while a line is formatted. */
const MASK = '';
const MASK_FIRST = 0xE100;
const MASKED = /([-])/g;

/**
 * Replace the string literals and the comment of a line by placeholders, so that
 * formatting never changes their text; `restore` puts them back.
 */
function maskLine(line: string): { text: string; restore: (formatted: string) => string } {
    const saved: string[] = [];
    const keep = (s: string): string => {
        saved.push(s);
        return MASK + String.fromCharCode(MASK_FIRST + saved.length - 1);
    };
    const comment = commentStart(line);
    let text = (comment < 0 ? line : line.slice(0, comment)).replace(/"[^"]*"/g, s => `"${keep(s.slice(1, -1))}"`);
    if (comment >= 0) { text += ';' + keep(line.slice(comment + 1).trimStart()); }
    return {
        text,
        restore: formatted => saved.length === 0 ? formatted
            : formatted.replace(MASKED, (_m, c: string) => saved[c.charCodeAt(0) - MASK_FIRST] ?? ''),
    };
}

class Formatter {
    private ilvl = 0;
    private step: number[] = [];
    /** whether each DEF/DEFFCT/DEFDAT pushed indentation, so its END pops exactly that */
    private fcnSteps: number[] = [];
    /** the first DEF (main or submit program) is not indented */
    private firstDef = true;
    readonly warnings: string[] = [];

    constructor(private readonly opts: FormatOptions) { }

    /** Split a part into (before, separator, after) by the first rule that applies. */
    private extract(part: string): Parts | null {
        if (P_BLANK.test(part)) { return ['', ' ', '']; }

        // comment (its text is masked, see maskLine)
        let m = P_COMMENT.exec(part);
        if (m) { return [m[1] + ' ', m[2] + ' ', m[3].trimStart()]; }

        // rational number (e.g. 1/4)
        m = P_NUM_R.exec(part);
        if (m) { return [m[1] + m[2], m[3], m[4] + m[5]]; }

        // compact "Key=Value" inside motion instructions (e.g. Vel=100%)
        m = P_OPT_EQUAL.exec(part);
        if (m && !this.opts.isDatFile) { return [part.slice(0, m.index), m[0], part.slice(m.index + m[0].length)]; }

        // sign (unary - or +)
        m = P_SIGN.exec(part);
        if (m) { return [m[1], m[2], m[3]]; }

        // type / parameter colon (e.g. x:IN), kept compact
        m = P_ARG_COLON.exec(part);
        if (m) { return [m[1], m[2], m[3].trimStart()]; }

        if (!this.opts.isDatFile) {
            // ==, >=, <=, <>
            m = P_OP.exec(part) ?? P_2OP.exec(part) ?? P_3OP.exec(part) ?? P_4OP.exec(part);
            if (m) { return [m[1] + ' ', m[2], ' ' + m[3]]; }
            m = P_COMMA.exec(part);
            if (m) { return [m[1], m[2], ' ' + m[3]]; }
        }

        // multiple whitespace
        m = P_MULTIWS.exec(part);
        if (m) { return [m[1], ' ', m[3]]; }

        // whitespace before a closing bracket
        m = P_NOSPACE_CLOSE.exec(part);
        if (m) { return [m[1], m[2], m[3]]; }

        return null;
    }

    /** Format a part recursively. */
    format(part: string): string {
        const m = this.extract(part);
        return m ? this.format(m[0]) + m[1] + this.format(m[2]) : part;
    }

    private indent(add = 0): string {
        return ' '.repeat(Math.max(0, (this.ilvl + add) * this.opts.indentWidth));
    }

    /** Beginning of a DEF / DEFFCT / DEFDAT / END ... line. */
    private fcnPrefix(m: RegExpExecArray): string {
        const global = (m[2] ?? '').trim();
        return (global ? global + ' ' : '') + m[3];
    }

    private popStep(): number {
        if (this.step.length > 0) { return this.step.pop()!; }
        this.warnings.push('There are more end-statements than blocks!');
        return 0;
    }

    /** Indentation change and text of one line. */
    formatLine(line: string): [number, string] {
        // header (&ACCESS, &REL, ...): kept as is
        if (HEADER.test(line)) { return [0, line.trimEnd()]; }

        // ;FOLD / ;ENDFOLD markers: kept as written, re-indented to the block level
        const fold = FOLD_MARKER.exec(line);
        if (fold) { return [0, this.indent() + fold[2] + fold[3].trimEnd()]; }

        // comment lines: re-indented to the block level
        if (LINE_COMMENT.test(line)) { return [0, this.indent() + line.trim()]; }

        const masked = maskLine(line);
        const [offset, text] = this.formatCode(masked.text);
        return [offset, masked.restore(text)];
    }

    /** Format a line whose strings and comment are masked. */
    private formatCode(line: string): [number, string] {
        // a whole block on one line (IF ... ENDIF)
        let m = CTRL_1LINE.exec(line);
        if (m) {
            return [0, this.indent() + m[2] + ' ' + this.format(m[3]).trim() + ' ' + m[4] + ' ' + this.format(m[6]).trim()];
        }

        m = FCN_START.exec(line);
        if (m) {
            const kw = m[3].toLowerCase();
            const text = this.fcnPrefix(m) + ' ' + this.format(m[4]).trim();
            // DEFDAT ... ENDDAT never adds indentation
            if (kw === 'defdat') {
                this.fcnSteps.push(0);
                return [0, this.indent() + text];
            }
            // the first DEF of a program (main or submit program) is not indented
            if (kw === 'def' && this.firstDef) {
                this.firstDef = false;
                if (!this.opts.indentAfterMainFunction) {
                    this.fcnSteps.push(0);
                    return [0, this.indent() + text];
                }
            }
            if (this.opts.indentAfterFunction) {
                this.step.push(1);
                this.fcnSteps.push(1);
                return [1, this.indent() + text];
            }
            this.fcnSteps.push(0);
            return [0, this.indent() + text];
        }

        m = FCN_END.exec(line);
        if (m) {
            const kw = m[3].toLowerCase();
            const text = this.fcnPrefix(m) + ' ' + this.format(m[4]).trim();
            let fstep = 0;
            if (this.fcnSteps.length > 0) {
                fstep = this.fcnSteps.pop()!;
            } else {
                this.warnings.push('There are more end-statements than begin-statements!');
            }
            if (kw === 'enddat') { return [0, this.indent() + text]; }
            if (fstep && this.opts.indentAfterFunction) {
                const step = this.popStep();
                return [-step, this.indent(-step) + text];
            }
            return [0, this.indent() + text];
        }

        m = CTRL_START_FOR.exec(line) ?? CTRL_START_THEN.exec(line);
        if (m) {
            this.step.push(1);
            return [1, this.indent() + m[2] + ' ' + this.format(m[3]).trim() + ' ' + m[4] + ' ' + this.format(m[5]).trim()];
        }

        m = CTRL_START.exec(line);
        if (m) {
            this.step.push(1);
            return [1, this.indent() + m[2] + ' ' + this.format(m[3]).trim()];
        }

        m = CTRL_START_SWITCH.exec(line);
        if (m) {
            this.step.push(2);
            return [2, this.indent() + m[2] + ' ' + this.format(m[3]).trim()];
        }

        m = CTRL_CONT.exec(line);
        if (m) { return [0, this.indent(-1) + m[2] + ' ' + this.format(m[3]).trim()]; }

        m = CTRL_END.exec(line);
        if (m) {
            const step = this.popStep();
            return [-step, this.indent(-step) + m[2] + ' ' + this.format(m[3]).trim()];
        }

        if (FIND_STRING.test(line)) { return [0, this.indent() + this.format(line).trimStart()]; }
        return [0, this.indent() + this.format(line).trim()];
    }

    /** Format lines; the indentation of the first one is the starting level. */
    formatLines(input: string[]): string[] {
        const rlines = input.length > 0 ? [...input] : [''];
        const out: string[] = [];

        // a blank leading line must not push the whole text to the right
        if (BLANK_LINE.test(rlines[0])) {
            this.ilvl = 0;
        } else {
            const m = /^(\s*)(.*)/.exec(rlines[0])!;
            this.ilvl = this.opts.indentWidth > 0 ? Math.floor(m[1].length / this.opts.indentWidth) : 0;
            rlines[0] = m[2];
        }

        let blank = true;
        let lastLineIsComment = false;
        for (const raw of rlines) {
            // remove repeated blank lines
            if (BLANK_LINE.test(raw)) {
                if (!blank) {
                    blank = true;
                    out.push('');
                }
                continue;
            }

            const [offset, line] = this.formatLine(raw);
            // a blank line before END / ENDFCT / ENDDAT
            if (FCN_END.test(line) && !blank) { out.push(''); }

            this.ilvl = Math.max(0, this.ilvl + offset);
            const isFcnStart = FCN_START.test(line);
            const isFcnEnd = FCN_END.test(line);

            if (this.opts.separateBeforeBlocks && (offset > 0 || isFcnStart) && !blank && !lastLineIsComment) { out.push(''); }
            out.push(line.trimEnd());
            if (this.opts.separateAfterBlocks && (offset < 0 || isFcnEnd)) {
                out.push('');
                blank = true;
            } else {
                blank = false;
            }
            lastLineIsComment = P_COMMENT.test(line);
        }

        while (out.length > 0 && !out[out.length - 1]) { out.pop(); }
        return out.length > 0 ? out : [''];
    }
}

/** Format KRL source lines (a whole file or a range of whole lines). */
export function formatKrlLines(lines: string[], options: Partial<FormatOptions> = {}): FormatResult {
    const formatter = new Formatter({ ...DEFAULT_FORMAT_OPTIONS, ...options });
    const out = formatter.formatLines(lines);
    return { lines: out, warnings: formatter.warnings };
}

/** Replace the old lines `start` ... `end - 1` by `lines`. */
export interface LineEdit {
    start: number;
    end: number;
    lines: string[];
}

/**
 * The smallest set of line replacements turning `oldLines` into `newLines`
 * (longest common subsequence of the lines), so that applying a format keeps
 * the cursor and the scroll position where unchanged lines are. Very large
 * changes fall back to one replacement.
 */
export function lineEdits(oldLines: string[], newLines: string[]): LineEdit[] {
    let pre = 0;
    while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) { pre++; }
    let suf = 0;
    while (suf < oldLines.length - pre && suf < newLines.length - pre
        && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) { suf++; }
    const a = oldLines.slice(pre, oldLines.length - suf);
    const b = newLines.slice(pre, newLines.length - suf);
    if (a.length === 0 && b.length === 0) { return []; }
    const n = a.length;
    const m = b.length;
    if (n * m > 4_000_000) { return [{ start: pre, end: pre + n, lines: b }]; }
    // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
    }
    const out: LineEdit[] = [];
    let hunk: LineEdit | null = null;
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            if (hunk) { out.push(hunk); hunk = null; }
            i++;
            j++;
            continue;
        }
        if (!hunk) { hunk = { start: pre + i, end: pre + i, lines: [] }; }
        if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
            hunk.lines.push(b[j++]);
        } else {
            i++;
            hunk.end = pre + i;
        }
    }
    if (hunk) { out.push(hunk); }
    return out;
}

/** Format a whole KRL file; the result ends with a line break. */
export function formatKrl(text: string, options: Partial<FormatOptions> = {}): FormatResult {
    return formatKrlLines(text.split(/\r?\n/), options);
}
