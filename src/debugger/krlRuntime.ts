// krlRuntime.ts
// A source-level simulator for KRL programs. It runs the main program and
// any submit programs concurrently as separate threads and implements
// breakpoints, stepping and variable inspection for the DAP debug session.
// Pure logic (no vscode imports).

import * as fs from 'fs';
import * as path from 'path';
import {
    KrlProgram, KrlFunctionInfo, KrlStmt, parseKrlProgram, splitTopLevel,
} from './krlProgram';
import {
    KrlValue, EvalContext, defaultValue, displayValue, krlNumber, krlBool, valuesEqual,
    parseBracedLiteral, KRL_INT, KRL_REAL, KRL_BOOL,
} from './krlValue';
import { evaluateExpression } from './krlExpr';

export interface KrlCallFrame {
    progPath: string;
    functionName: string;
    /** 'prog' | 'fct' | 'defdat' */
    kind: string;
    /** statement index of the next instruction */
    pc: number;
    startIdx: number;
    endIdx: number;
    params: Map<string, KrlValue>;
    locals: Map<string, KrlValue>;
    /** pc to resume at in the caller after this frame returns (-1 = none) */
    returnPc: number;
    callLine: number;
    returnValue: KrlValue | null;
    forLoops: { name: string; endVal: number; startPc: number; guard: number }[];
}

export interface KrlThread {
    id: number;
    name: string;
    file: string;
    finished: boolean;
    stack: KrlCallFrame[];
}

export type StopReason = 'entry' | 'breakpoint' | 'step' | 'pause' | 'end' | 'error';

export interface StopInfo {
    reason: StopReason;
    threadId?: number;
    message?: string;
}

export interface KrlRuntimeOptions {
    mainPath: string;
    submitPaths?: string[];
    sources?: string[];
    /** Explicit path to $config.dat. When omitted the runtime walks up the
     *  directory tree from the main program looking for any file named
     *  $config.dat (case-insensitive). */
    configDatPath?: string;
    stopOnEntry?: boolean;
    maxSteps?: number;
    onOutput?: (text: string) => void;
}

export interface FrameHandle {
    kind: 'frame' | 'runtime' | 'datPrivate' | 'datGlobal' | 'configGlobal' | 'system' | 'value';
    threadId?: number;
    frameIndex?: number;
    value?: KrlValue;
}

export interface VariableEntry {
    name: string;
    type: string;
    value: string;
    reference: number;
}

export interface ThreadView {
    id: number;
    name: string;
    file: string;
    finished: boolean;
    line: number; // 0-based line of current statement (if any)
}

export interface StackFrameView {
    frameId: number;
    threadId: number;
    name: string;
    file: string;
    line: number; // 0-based
}

export class KrlRuntime {
    private static readonly SYSTEM_SCOPE_VARIABLES = [
        // actual robot position and axis angles
        '$POS_ACT', '$POS_ACT_M1', '$AXIS_ACT',
        // active tool / base / robot root frame
        '$TOOL', '$BASE', '$ROBROOT',
        // velocity, acceleration, approximate positioning (expandable structs)
        '$VEL', '$ACC', '$APO',
        // program override and load
        '$OV_PRO',
        // digital I/O arrays
        '$IN', '$OUT',
        // analog I/O arrays
        '$ANIN', '$ANOUT',
        // timers
        '$TIMER',
        // machine-state signals
        '$MOVE_ENABLE', '$PERI_RDY', '$EM_STOP', '$BRAKE', '$DRIVES_ON', '$DRIVES_OFF',
        // misc runtime values
        '$CYCLE', '$PRO_STATE',
    ] as const;

    private programs = new Map<string, KrlProgram>();
    private modules = new Map<string, { path: string; func: KrlFunctionInfo }>();
    private threads: KrlThread[] = [];
    /** GLOBAL declarations from regular .dat files */
    private datGlobals = new Map<string, KrlValue>();
    /** Declarations from $config.dat */
    private configGlobals = new Map<string, KrlValue>();
    /** Non-GLOBAL declarations from regular .dat files, keyed by module basename path */
    private datPrivatesByModule = new Map<string, Map<string, KrlValue>>();
    private breakpoints = new Map<string, Set<number>>();
    private systemTime = 0;
    private stepsExecuted = 0;
    private stopRequested = false;
    private handles = new Map<number, FrameHandle>();
    private nextHandle = 1;
    private lastThreadIdx = 0;
    private functionDepth = 0;
    private running = false;
    private maxSteps: number;
    private onOutput: (text: string) => void;
    private configDatPath: string | null = null;

    constructor(private opts: KrlRuntimeOptions) {
        this.maxSteps = opts.maxSteps ?? 200000;
        this.onOutput = opts.onOutput ?? (() => { });
    }

    /** Read and parse all source files. Returns human readable errors. */
    load(): string[] {
        const errors: string[] = [];
        const resolvedConfigDatPath = this.opts.configDatPath ?? this.findConfigDat(this.opts.mainPath);
        this.configDatPath = resolvedConfigDatPath ?? null;
        const files: { kind: 'main' | 'submit' | 'source'; path: string }[] = [];
        files.push({ kind: 'main', path: this.opts.mainPath });
        for (const p of this.opts.submitPaths ?? []) { files.push({ kind: 'submit', path: p }); }
        for (const p of this.opts.sources ?? []) { files.push({ kind: 'source', path: p }); }

        for (const f of files) {
            let text: string;
            try {
                text = fs.readFileSync(f.path, 'utf8');
            } catch (e) {
                errors.push(`cannot read ${f.path}: ${String(e)}`);
                continue;
            }
            const prog = parseKrlProgram(f.path, text);
            this.programs.set(f.path, prog);
            this.registerModules(prog);
            // load globals coming from a .dat file
            if (/\.dat$/i.test(f.path)) {
                this.loadDatDeclarations(prog, f.path, this.isSamePath(f.path, this.configDatPath));
            }
        }

        // KRL convention: a program usually has a sibling .dat file
        for (const f of files) {
            if (/\.dat$/i.test(f.path)) { continue; }
            const datPath = f.path.replace(/\.[^.\\/]+$/i, '') + '.dat';
            if (fs.existsSync(datPath) && !this.programs.has(datPath)) {
                try {
                    const prog = parseKrlProgram(datPath, fs.readFileSync(datPath, 'utf8'));
                    this.programs.set(datPath, prog);
                    this.loadDatDeclarations(prog, datPath, this.isSamePath(datPath, this.configDatPath));
                } catch (e) {
                    errors.push(`cannot read ${datPath}: ${String(e)}`);
                }
            }
        }

        // Load $config.dat — KUKA global variable declarations shared by all programs
        const configDatPath = this.configDatPath;
        if (configDatPath && !this.programs.has(configDatPath)) {
            try {
                const prog = parseKrlProgram(configDatPath, fs.readFileSync(configDatPath, 'utf8'));
                this.programs.set(configDatPath, prog);
                this.loadDatDeclarations(prog, configDatPath, true);
            } catch (e) {
                errors.push(`cannot read ${configDatPath}: ${String(e)}`);
            }
        }

        // create the main thread
        const mainThread = this.createThread(0, 'MAIN', this.opts.mainPath, errors);
        if (mainThread) { this.threads.push(mainThread); }
        // create a thread for every submit program
        let submitId = 1;
        for (const p of this.opts.submitPaths ?? []) {
            const name = path.basename(p, path.extname(p)).toUpperCase();
            const t = this.createThread(submitId, name, p, errors);
            if (t) { this.threads.push(t); }
            submitId++;
        }
        return errors;
    }

    private registerModules(prog: KrlProgram): void {
        for (const func of prog.funcs.values()) {
            if (func.kind === 'defdat') { continue; }
            if (!this.modules.has(func.name)) {
                this.modules.set(func.name, { path: prog.path, func });
            }
        }
    }

    private loadDatDeclarations(prog: KrlProgram, datPath: string, isConfigDat: boolean): void {
        const thread = this.threadForDatPath(datPath);
        for (const stmt of prog.stmts) {
            if (stmt.kind !== 'decl') { continue; }
            this.executeDeclFrame(null, stmt.text, datPath, isConfigDat, thread);
        }
    }

    private moduleKeyFromPath(filePath: string): string {
        return filePath.replace(/\.[^.\\/]+$/i, '').toLowerCase();
    }

    private isSamePath(a: string | null | undefined, b: string | null | undefined): boolean {
        if (!a || !b) { return false; }
        return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    }

    private getDatPrivateMapForPath(filePath: string): Map<string, KrlValue> {
        const key = this.moduleKeyFromPath(filePath);
        let bucket = this.datPrivatesByModule.get(key);
        if (!bucket) {
            bucket = new Map<string, KrlValue>();
            this.datPrivatesByModule.set(key, bucket);
        }
        return bucket;
    }

    /** Walk up the directory tree from startPath looking for $config.dat. */
    private findConfigDat(startPath: string): string | null {
        let dir = path.dirname(startPath);
        const visited = new Set<string>();
        while (!visited.has(dir)) {
            visited.add(dir);
            let entries: string[];
            try { entries = fs.readdirSync(dir); } catch { break; }
            const found = entries.find(e => /^\$config\.dat$/i.test(e));
            if (found) { return path.join(dir, found); }
            const parent = path.dirname(dir);
            if (parent === dir) { break; }
            dir = parent;
        }
        return null;
    }

    private createThread(id: number, name: string, file: string, errors: string[]): KrlThread | null {
        const prog = this.programs.get(file);
        if (!prog) { errors.push(`program file not loaded: ${file}`); return null; }
        let func: KrlFunctionInfo | null = null;
        for (const f of prog.funcs.values()) {
            if (f.kind === 'prog') { func = f; break; }
        }
        if (!func) { errors.push(`no top level DEF found in ${file}`); return null; }
        const frame: KrlCallFrame = {
            progPath: file,
            functionName: func.displayName,
            kind: func.kind,
            pc: func.startIdx + 1,
            startIdx: func.startIdx,
            endIdx: func.endIdx,
            params: new Map(),
            locals: new Map(),
            returnPc: 0,
            callLine: 0,
            returnValue: null,
            forLoops: [],
        };
        return { id, name, file, finished: false, stack: [frame] };
    }

    // ------------------------------------------------------------------
    // breakpoints

    /** Set breakpoints by client (1-based) line numbers. Returns verified flags. */
    setBreakpoints(sourcePath: string, clientLines: number[]): boolean[] {
        let set = this.breakpoints.get(sourcePath);
        if (!set) { set = new Set<number>(); this.breakpoints.set(sourcePath, set); }
        const prog = this.programs.get(sourcePath);
        const verified: boolean[] = [];
        for (const line of clientLines) {
            let ok = false;
            if (prog) {
                const idx = prog.lineToIndex[line - 1] ?? -1;
                if (idx >= 0) { set.add(idx); ok = true; }
            }
            verified.push(ok);
        }
        return verified;
    }

    clearBreakpoints(sourcePath: string): void {
        this.breakpoints.delete(sourcePath);
    }

    // ------------------------------------------------------------------
    // execution driver

    pause(): void {
        this.stopRequested = true;
    }

    isFinished(): boolean {
        return this.threads.every(t => t.finished);
    }

    /**
     * Run until a stop condition is reached:
     *  - 'continue': round-robin over all threads until breakpoint / pause / end
     *  - 'stepIn' / 'stepOver' / 'stepOut': drive the given thread
     */
    async run(mode: 'continue' | 'stepIn' | 'stepOver' | 'stepOut', threadId?: number): Promise<StopInfo> {
        if (this.running) { return { reason: 'error', message: 'debugger is already running' }; }
        this.running = true;
        this.stopRequested = false;
        const target = threadId !== undefined
            ? this.threads[threadId]
            : (mode !== 'continue' ? this.threads[0] : undefined);
        const targetDepth = target ? target.stack.length : 0;
        let executed = 0;
        try {
            for (;;) {
                if (this.stopRequested) { return { reason: 'pause' }; }
                const advanced = mode === 'continue'
                    ? this.advanceRoundRobin()
                    : this.advanceTarget(target);
                if (!advanced) { return { reason: 'end' }; }
                executed++;
                this.stepsExecuted++;
                if (this.stepsExecuted > this.maxSteps) {
                    this.onOutput(`[krl] instruction limit of ${this.maxSteps} reached; use breakpoints or the pause button`);
                    return { reason: 'error', message: 'instruction limit reached' };
                }
                if (mode === 'continue') {
                    const hit = this.firstBreakpointHit();
                    if (hit >= 0) { return { reason: 'breakpoint', threadId: hit }; }
                } else if (target && !target.finished) {
                    const depth = target.stack.length;
                    if (mode === 'stepIn') { return { reason: 'step', threadId: target.id }; }
                    if (executed >= 1 && mode === 'stepOver' && depth <= targetDepth) {
                        return { reason: 'step', threadId: target.id };
                    }
                    if (mode === 'stepOut' && depth < targetDepth) {
                        return { reason: 'step', threadId: target.id };
                    }
                }
                if (executed % 50 === 0) { await new Promise<void>(r => setImmediate(r)); }
            }
        } finally {
            this.running = false;
        }
    }

    private advanceTarget(target: KrlThread | undefined): boolean {
        if (target && !target.finished) {
            const res = this.executeOne(target);
            if (res === 'finished') { target.finished = true; }
            return true;
        }
        // target is not runnable anymore - fall back to round-robin
        return this.advanceRoundRobin();
    }

    private advanceRoundRobin(): boolean {
        const n = this.threads.length;
        if (n === 0) { return false; }
        for (let k = 0; k < n; k++) {
            this.lastThreadIdx = (this.lastThreadIdx + 1) % n;
            const t = this.threads[this.lastThreadIdx];
            if (t.finished) { continue; }
            const res = this.executeOne(t);
            if (res === 'finished') { t.finished = true; }
            return true;
        }
        return false;
    }

    private firstBreakpointHit(): number {
        for (const t of this.threads) {
            if (t.finished) { continue; }
            const frame = t.stack[t.stack.length - 1];
            if (!frame) { continue; }
            const set = this.breakpoints.get(frame.progPath);
            if (set && set.has(frame.pc)) { return t.id; }
        }
        return -1;
    }


    // ------------------------------------------------------------------
    // DAP-facing views

    getThreads(): ThreadView[] {
        return this.threads.map(t => {
            const line = this.currentLine(t);
            return { id: t.id, name: t.name, file: t.file, finished: t.finished, line };
        });
    }

    getStackTrace(threadId: number): StackFrameView[] {
        const t = this.threads[threadId];
        if (!t) { return []; }
        const out: StackFrameView[] = [];
        const depth = t.stack.length;
        for (let i = depth - 1; i >= 0; i--) {
            const frame = t.stack[i];
            const frameId = this.registerHandle({ kind: 'frame', threadId, frameIndex: i });
            const prog = this.programs.get(frame.progPath);
            const stmt = prog ? prog.stmts[frame.pc] : undefined;
            out.push({
                frameId,
                threadId,
                name: frame.functionName,
                file: frame.progPath,
                line: stmt ? stmt.line : 0,
            });
        }
        return out;
    }

    /** Scopes for a frame handle grouped by KRL storage class. */
    getScopes(frameId: number): { name: string; ref: number }[] {
        const handle = this.handles.get(frameId);
        if (!handle || handle.kind !== 'frame') { return []; }
        return [
            { name: 'System Variables',     ref: this.registerHandle({ kind: 'system' }) },
            { name: 'Runtime Variables',    ref: this.registerHandle({ kind: 'runtime',      threadId: handle.threadId, frameIndex: handle.frameIndex }) },
            { name: 'DAT Private Variables', ref: this.registerHandle({ kind: 'datPrivate',  threadId: handle.threadId, frameIndex: handle.frameIndex }) },
            { name: 'DAT Global Variables', ref: this.registerHandle({ kind: 'datGlobal' }) },
            { name: '$CONFIG.DAT Globals',  ref: this.registerHandle({ kind: 'configGlobal' }) },
        ];
    }

    getVariables(ref: number): VariableEntry[] {
        const handle = this.handles.get(ref);
        if (!handle) { return []; }
        if (handle.kind === 'runtime') {
            const t = this.threads[handle.threadId ?? -1];
            const frame = t ? t.stack[handle.frameIndex ?? 0] : undefined;
            if (!frame) { return []; }
            const merged = new Map<string, KrlValue>();
            for (const [k, v] of frame.params) { merged.set(k, v); }
            for (const [k, v] of frame.locals) { merged.set(k, v); }
            return this.collectVars(merged);
        }
        if (handle.kind === 'datPrivate') {
            const t = this.threads[handle.threadId ?? -1];
            const frame = t ? t.stack[handle.frameIndex ?? 0] : undefined;
            if (!frame) { return []; }
            return this.collectVars(this.getDatPrivateMapForPath(frame.progPath));
        }
        if (handle.kind === 'datGlobal') {
            return this.collectVars(this.datGlobals);
        }
        if (handle.kind === 'configGlobal') {
            return this.collectVars(this.configGlobals);
        }
        if (handle.kind === 'system') {
            return this.collectSystemVars();
        }
        if (handle.kind === 'value' && handle.value) {
            return this.collectVars(null, handle.value);
        }
        return [];
    }

    private collectSystemVars(): VariableEntry[] {
        const out: VariableEntry[] = [];
        for (const variableName of KrlRuntime.SYSTEM_SCOPE_VARIABLES) {
            const value = this.readSystemVariable(variableName);
            if (!value) { continue; }
            out.push(this.makeVariable(variableName, value));
        }
        return out;
    }

    private readSystemVariable(name: string): KrlValue | null {
        const key = name.toLowerCase();
        const dot = key.indexOf('.');
        if (dot < 0) {
            return this.resolveSystemVar(key);
        }
        const base = this.resolveSystemVar(key.slice(0, dot));
        if (!base || base.t !== 'struct') { return null; }
        return base.v.get(key.slice(dot + 1)) ?? null;
    }

    private collectVars(map: Map<string, KrlValue> | null, value?: KrlValue): VariableEntry[] {
        const out: VariableEntry[] = [];
        if (map) {
            for (const [k, v] of map) {
                out.push(this.makeVariable(k, v));
            }
            out.sort((a, b) => a.name.localeCompare(b.name));
            return out;
        }
        if (value) {
            if (value.t === 'struct') {
                for (const [k, v] of value.v) { out.push(this.makeVariable(k.toUpperCase(), v)); }
            } else if (value.t === 'array') {
                value.v.forEach((v, i) => out.push(this.makeVariable(`[${i + 1}]`, v)));
            }
        }
        return out;
    }

    private makeVariable(name: string, v: KrlValue): VariableEntry {
        let reference = 0;
        if (v.t === 'struct' || v.t === 'array') {
            reference = this.registerHandle({ kind: 'value', value: v });
        }
        return { name, type: v.t.toUpperCase(), value: displayValue(v), reference };
    }

    private registerHandle(handle: FrameHandle): number {
        const id = this.nextHandle++;
        this.handles.set(id, handle);
        return id;
    }

    private currentLine(t: KrlThread): number {
        const frame = t.stack[t.stack.length - 1];
        if (!frame) { return 0; }
        const prog = this.programs.get(frame.progPath);
        const stmt = prog ? prog.stmts[frame.pc] : undefined;
        return stmt ? stmt.line : 0;
    }



    // ------------------------------------------------------------------
    // statement execution

    private executeOne(thread: KrlThread): 'ok' | 'finished' {
        const frame = this.top(thread);
        if (!frame) { thread.finished = true; return 'finished'; }
        const prog = this.programs.get(frame.progPath);
        if (!prog) { thread.finished = true; return 'finished'; }
        const stmt = prog.stmts[frame.pc];
        if (!stmt) {
            // ran past the last statement -> the current block is done
            return this.popFrame(thread, frame.returnPc);
        }
        this.systemTime++;
        return this.execStmt(thread, prog, frame, stmt);
    }

    /** Pop the frame and resume the caller (or finish the thread). */
    private popFrame(thread: KrlThread, returnPc: number): 'ok' | 'finished' {
        thread.stack.pop();
        if (thread.stack.length === 0) { thread.finished = true; return 'finished'; }
        const caller = thread.stack[thread.stack.length - 1];
        if (returnPc >= 0) { caller.pc = returnPc; }
        return 'ok';
    }

    private ctxFor(thread: KrlThread): EvalContext {
        const self = this;
        return {
            resolveName(name: string): KrlValue | null {
                return self.resolveName(thread, name);
            },
            invokeFunction(name: string, args: KrlValue[]): KrlValue | null {
                return self.invokeFunction(thread, name, args);
            },
        };
    }

    private execStmt(thread: KrlThread, prog: KrlProgram, frame: KrlCallFrame, stmt: KrlStmt): 'ok' | 'finished' {
        const expr = this.ctxFor(thread);

        switch (stmt.kind) {
            case 'prog': case 'fct': case 'defdat': {
                // definition reached without being called -> skip its body
                const endIdx = prog.fctEnd.get(frame.pc);
                frame.pc = endIdx !== undefined ? endIdx + 1 : frame.pc + 1;
                return 'ok';
            }
            case 'end': case 'endfct': case 'enddat': {
                return this.popFrame(thread, frame.returnPc);
            }
            case 'if': {
                const m = stmt.text.match(/^\s*IF\b\s*(.*?)\s*THEN\b/i);
                const condText = m && m[1].trim() ? m[1] : stmt.text.replace(/^\s*IF\b/i, '');
                if (krlBool(evaluateExpression(condText, expr))) {
                    frame.pc++;
                } else {
                    const elseIdx = prog.ifFalseToElse.get(frame.pc);
                    const after = prog.ifAfter.get(frame.pc) ?? frame.pc + 1;
                    frame.pc = elseIdx !== undefined ? elseIdx + 1 : after + 1;
                }
                return 'ok';
            }
            case 'else': {
                const after = prog.ifAfter.get(frame.pc) ?? frame.pc + 1;
                frame.pc = after + 1;
                return 'ok';
            }
            case 'endif': {
                frame.pc++;
                return 'ok';
            }

            case 'for': {
                const m = stmt.text.match(/^\s*FOR\b\s+([A-Z_$][\w$]*)\s*=\s*(.+?)\s+TO\s+(.+)$/i);
                if (!m) { frame.pc++; return 'ok'; }
                this.setVariablePath(thread, m[1], evaluateExpression(m[2], expr));
                frame.forLoops.push({
                    name: m[1].toLowerCase(),
                    endVal: krlNumber(evaluateExpression(m[3], expr)),
                    startPc: frame.pc,
                    guard: 0,
                });
                frame.pc++;
                return 'ok';
            }
            case 'endfor': {
                const loop = frame.forLoops[frame.forLoops.length - 1];
                if (!loop) { frame.pc++; return 'ok'; }
                loop.guard++;
                if (loop.guard > 1000000) {
                    this.onOutput(`[${thread.name}] FOR loop guard exceeded - stopping loop`);
                    frame.forLoops.pop();
                    frame.pc++;
                    return 'ok';
                }
                const next = krlNumber(this.resolveName(thread, loop.name)) + 1;
                this.setVariablePath(thread, loop.name, KRL_INT(next));
                if (next <= loop.endVal) {
                    frame.pc = loop.startPc + 1;
                } else {
                    frame.forLoops.pop();
                    frame.pc++;
                }
                return 'ok';
            }
            case 'while': {
                const m = stmt.text.match(/^\s*WHILE\b\s*(.*)$/i);
                const condText = m && m[1].trim() ? m[1] : '';
                if (krlBool(evaluateExpression(condText, expr))) {
                    frame.pc++;
                } else {
                    const after = prog.whileEnd.get(frame.pc) ?? frame.pc + 1;
                    frame.pc = after + 1;
                }
                return 'ok';
            }
            case 'endwhile': {
                frame.pc = prog.whileStart.get(frame.pc) ?? frame.pc + 1;
                return 'ok';
            }
            case 'loop': {
                frame.pc++;
                return 'ok';
            }
            case 'endloop': {
                frame.pc = prog.loopStart.get(frame.pc) ?? frame.pc + 1;
                return 'ok';
            }
            case 'repeat': {
                frame.pc++;
                return 'ok';
            }
            case 'until': {
                const m = stmt.text.match(/^\s*UNTIL\b\s*(.*)$/i);
                const condText = m && m[1].trim() ? m[1] : '';
                if (krlBool(evaluateExpression(condText, expr))) {
                    frame.pc++;
                } else {
                    const repeatIdx = prog.untilRepeat.get(frame.pc);
                    frame.pc = repeatIdx !== undefined ? repeatIdx + 1 : frame.pc + 1;
                }
                return 'ok';
            }
            case 'switch': {
                const m = stmt.text.match(/^\s*SWITCH\b\s*(.*)$/i);
                const switchValue = evaluateExpression(m && m[1].trim() ? m[1] : '', expr);
                const cases = prog.switchCases.get(frame.pc) ?? [];
                const defIdx = prog.switchDefault.get(frame.pc);
                const after = prog.switchEnd.get(frame.pc) ?? frame.pc + 1;
                let matched = -1;
                for (const c of cases) {
                    if (valuesEqual(switchValue, evaluateExpression(c.value, expr))) { matched = c.caseIdx; break; }
                }
                frame.pc = matched >= 0 ? matched + 1 : (defIdx !== undefined ? defIdx + 1 : after + 1);
                return 'ok';
            }
            case 'case': case 'default': case 'endswitch': {
                frame.pc++;
                return 'ok';
            }

            case 'decl': {
                this.executeDeclFrame(frame, stmt.text);
                frame.pc++;
                return 'ok';
            }
            case 'assign': {
                const eq = findSingleEq(stmt.text);
                if (eq < 0) { frame.pc++; return 'ok'; }
                const lhs = stmt.text.slice(0, eq).trim();
                const rhs = stmt.text.slice(eq + 1).trim();
                const value = evaluateExpression(rhs, expr);
                this.setVariablePath(thread, lhs, value);
                frame.pc++;
                return 'ok';
            }
            case 'call': {
                const m = stmt.text.match(/^\s*([A-Z_$][\w$]*)\s*\(([^)]*)\)/i);
                if (!m) { frame.pc++; return 'ok'; }
                const mod = this.modules.get(m[1].toLowerCase());
                if (!mod) {
                    this.onOutput(`[${thread.name}] call to unknown routine: ${m[1]}`);
                    frame.pc++;
                    return 'ok';
                }
                const args = splitTopLevel(m[2], ',').filter(s => s.trim() !== '')
                    .map(a => evaluateExpression(a.trim(), expr));
                thread.stack.push(this.makeFrame(mod.path, mod.func, args, frame.pc + 1, stmt.line));
                return 'ok';
            }
            case 'return': {
                const rest = stmt.text.replace(/^\s*RETURN\b/i, '').trim();
                frame.returnValue = rest ? evaluateExpression(rest, expr) : KRL_INT(0);
                return this.popFrame(thread, frame.returnPc);
            }
            case 'motion': {
                this.onOutput(`[${thread.name}] ${stmt.text}`);
                frame.pc++;
                return 'ok';
            }
            case 'wait': {
                this.onOutput(`[${thread.name}] ${stmt.text}`);
                const m = stmt.text.match(/WAIT\s+SEC\s+([\d.]+)/i);
                if (m) { this.systemTime += Math.round(parseFloat(m[1]) * 100); }
                frame.pc++;
                return 'ok';
            }
            case 'other':
            default: {
                frame.pc++;
                return 'ok';
            }
        }
    }

    // ------------------------------------------------------------------
    // variables, declarations, functions

    private makeFrame(progPath: string, func: KrlFunctionInfo, args: KrlValue[],
        returnPc: number, callLine: number): KrlCallFrame {
        const frame: KrlCallFrame = {
            progPath,
            functionName: func.displayName,
            kind: func.kind,
            pc: func.startIdx + 1,
            startIdx: func.startIdx,
            endIdx: func.endIdx,
            params: new Map(),
            locals: new Map(),
            returnPc,
            callLine,
            returnValue: null,
            forLoops: [],
        };
        func.params.forEach((p, i) => {
            if (i < args.length) { frame.params.set(p.name, args[i]); }
        });
        return frame;
    }

    /** Resolve a variable name: locals, params, globals, then system vars. */
    private resolveName(thread: KrlThread, name: string): KrlValue | null {
        const key = name.toLowerCase();
        const frame = this.top(thread);
        if (frame) {
            const local = frame.locals.get(key);
            if (local) { return local; }
            const param = frame.params.get(key);
            if (param) { return param; }
            const datPrivate = this.getDatPrivateMapForPath(frame.progPath).get(key);
            if (datPrivate) { return datPrivate; }
        }
        if (thread.file) {
            const datPrivateFromThread = this.getDatPrivateMapForPath(thread.file).get(key);
            if (datPrivateFromThread) { return datPrivateFromThread; }
        }
        if (this.datGlobals.has(key)) { return this.datGlobals.get(key) ?? null; }
        if (this.configGlobals.has(key)) { return this.configGlobals.get(key) ?? null; }
        return this.resolveSystemVar(key);
    }

    private readonly systemVarStore = new Map<string, KrlValue>();

    private ensureSystemVar(key: string, factory: () => KrlValue): KrlValue {
        const existing = this.systemVarStore.get(key);
        if (existing) { return existing; }
        const created = factory();
        this.systemVarStore.set(key, created);
        return created;
    }

    private makeSystemStruct(name: string, members: string[], init: () => KrlValue): KrlValue {
        const values = new Map<string, KrlValue>();
        for (const member of members) {
            values.set(member.toLowerCase(), init());
        }
        return { t: 'struct', name, v: values };
    }

    private readSystemStructMember(baseKey: string, member: string): KrlValue | null {
        const base = this.resolveSystemVar(baseKey);
        if (!base || base.t !== 'struct') { return null; }
        return base.v.get(member.toLowerCase()) ?? null;
    }

    private writeSystemStructMember(baseKey: string, member: string, value: KrlValue): void {
        const base = this.resolveSystemVar(baseKey);
        if (!base || base.t !== 'struct') { return; }
        base.v.set(member.toLowerCase(), value);
    }

    private resolveSystemVar(key: string): KrlValue | null {
        const normalized = key.toLowerCase();
        switch (normalized) {
            // Timers — always reflect current simulation time
            case '$timer': {
                const timer = this.ensureSystemVar('$timer', () => ({ t: 'array', v: new Array(128).fill(null).map(() => KRL_INT(0)) }));
                if (timer.t !== 'array') { return timer; }
                for (let i = 0; i < timer.v.length; i++) { timer.v[i] = KRL_INT(this.systemTime); }
                return timer;
            }
            // Digital I/O
            case '$out':
                return this.ensureSystemVar('$out', () => ({ t: 'array', v: new Array(4096).fill(null).map(() => KRL_BOOL(false)) }));
            case '$in':
                return this.ensureSystemVar('$in',  () => ({ t: 'array', v: new Array(4096).fill(null).map(() => KRL_BOOL(false)) }));
            // Analog I/O
            case '$anout':
                return this.ensureSystemVar('$anout', () => ({ t: 'array', v: new Array(32).fill(null).map(() => KRL_REAL(0)) }));
            case '$anin':
                return this.ensureSystemVar('$anin',  () => ({ t: 'array', v: new Array(32).fill(null).map(() => KRL_REAL(0)) }));
            // Actual robot positions
            case '$pos_act':
                return this.ensureSystemVar('$pos_act',    () => this.makeSystemStruct('E6POS', ['x','y','z','a','b','c','s','t','e1','e2','e3','e4','e5','e6'], () => KRL_REAL(0)));
            case '$pos_act_m1':
                return this.ensureSystemVar('$pos_act_m1', () => this.makeSystemStruct('E6POS', ['x','y','z','a','b','c','s','t','e1','e2','e3','e4','e5','e6'], () => KRL_REAL(0)));
            case '$axis_act':
                return this.ensureSystemVar('$axis_act',   () => this.makeSystemStruct('E6AXIS', ['a1','a2','a3','a4','a5','a6','e1','e2','e3','e4','e5','e6'], () => KRL_REAL(0)));
            // Active tool / base / robot root
            case '$tool':
                return this.ensureSystemVar('$tool',    () => this.makeSystemStruct('FRAME', ['x','y','z','a','b','c'], () => KRL_REAL(0)));
            case '$base':
                return this.ensureSystemVar('$base',    () => this.makeSystemStruct('FRAME', ['x','y','z','a','b','c'], () => KRL_REAL(0)));
            case '$robroot':
                return this.ensureSystemVar('$robroot', () => this.makeSystemStruct('FRAME', ['x','y','z','a','b','c'], () => KRL_REAL(0)));
            // Approximate positioning (CDIS/CVEL/CPTP/CORI)
            case '$apo':
                return this.ensureSystemVar('$apo', () => this.makeSystemStruct('APO', ['cdis','cvel','cptp','cori'], () => KRL_REAL(0)));
            case '$apo.cdis': case '$apo_cdis':
                return this.readSystemStructMember('$apo', 'cdis') ?? KRL_REAL(0);
            case '$apo.cvel': case '$apo_cvel':
                return this.readSystemStructMember('$apo', 'cvel') ?? KRL_REAL(0);
            case '$apo.cptp': case '$apo_cptp':
                return this.readSystemStructMember('$apo', 'cptp') ?? KRL_REAL(0);
            case '$apo.cori': case '$apo_cori':
                return this.readSystemStructMember('$apo', 'cori') ?? KRL_REAL(0);
            // Legacy alias kept for compatibility
            case '$apo.cpy': case '$apo_cpy':
                return this.readSystemStructMember('$apo', 'cdis') ?? KRL_REAL(0);
            // Velocity
            case '$vel':
                return this.ensureSystemVar('$vel', () => this.makeSystemStruct('VEL', ['cp','ori1','ori2','ap'], () => KRL_REAL(0)));
            case '$vel.cp':   case '$vel_cp':
                return this.readSystemStructMember('$vel', 'cp')   ?? KRL_REAL(0);
            case '$vel.ori1': case '$vel_ori1':
                return this.readSystemStructMember('$vel', 'ori1') ?? KRL_REAL(0);
            case '$vel.ori2': case '$vel_ori2':
                return this.readSystemStructMember('$vel', 'ori2') ?? KRL_REAL(0);
            case '$vel.ap':   case '$vel_ap':
                return this.readSystemStructMember('$vel', 'ap')   ?? KRL_REAL(0);
            // Acceleration
            case '$acc':
                return this.ensureSystemVar('$acc', () => this.makeSystemStruct('ACC', ['cp','ori1','ori2'], () => KRL_REAL(0)));
            case '$acc.cp':   case '$acc_cp':
                return this.readSystemStructMember('$acc', 'cp')   ?? KRL_REAL(0);
            case '$acc.ori1': case '$acc_ori1':
                return this.readSystemStructMember('$acc', 'ori1') ?? KRL_REAL(0);
            case '$acc.ori2': case '$acc_ori2':
                return this.readSystemStructMember('$acc', 'ori2') ?? KRL_REAL(0);
            // Override and machine state
            case '$ov_pro':
                return this.ensureSystemVar('$ov_pro', () => KRL_INT(100));
            case '$move_enable':
                return this.ensureSystemVar('$move_enable', () => KRL_BOOL(true));
            case '$peri_rdy':
                return this.ensureSystemVar('$peri_rdy',   () => KRL_BOOL(true));
            case '$em_stop':
                return this.ensureSystemVar('$em_stop',    () => KRL_BOOL(false));
            case '$brake':
                return this.ensureSystemVar('$brake',      () => KRL_BOOL(false));
            case '$drives_on':
                return this.ensureSystemVar('$drives_on',  () => KRL_BOOL(true));
            case '$drives_off':
                return this.ensureSystemVar('$drives_off', () => KRL_BOOL(false));
            // Misc
            case '$cycle':
                return this.ensureSystemVar('$cycle', () => KRL_INT(0));
            case '$pro_state': case '$pro':
                return this.ensureSystemVar('$pro_state', () => KRL_INT(0));
            case '$state':
                return this.ensureSystemVar('$state', () => KRL_INT(0));
            case '$pose':
                return this.ensureSystemVar('$pose',  () => KRL_INT(0));
            default:
                return null;
        }
    }


    /**
     * Assign to a variable path such as "counter", "cpos.A1" or "$OUT[1]".
     * Deeper components are created on demand.
     */
    private setVariablePath(thread: KrlThread, lvalue: string, value: KrlValue): void {
        const parts = this.parseLValue(lvalue);
        if (!parts) { return; }
        const base = parts.base.toLowerCase();
        const frame = this.top(thread);
        const datPrivate = this.getDatPrivateMapForPath(frame ? frame.progPath : thread.file);

        // locate the base container
        let container: KrlValue | null = null;
        let containerKey: 'local' | 'param' | 'datPrivate' | 'datGlobal' | 'configGlobal' | 'system' = 'local';
        if (frame) {
            const local = frame.locals.get(base);
            if (local) { container = local; containerKey = 'local'; }
            const param = frame.params.get(base);
            if (container === null && param) { container = param; containerKey = 'param'; }
        }
        if (container === null) {
            const priv = datPrivate.get(base);
            if (priv) { container = priv; containerKey = 'datPrivate'; }
        }
        if (container === null) {
            const g = this.datGlobals.get(base);
            if (g) { container = g; containerKey = 'datGlobal'; }
        }
        if (container === null) {
            const c = this.configGlobals.get(base);
            if (c) { container = c; containerKey = 'configGlobal'; }
        }
        if (container === null && base.startsWith('$')) {
            container = this.resolveSystemVar(base);
            if (container) { containerKey = 'system'; }
        }
        if (container === null) {
            container = value;
            if (frame) { frame.locals.set(base, container); }
            else { datPrivate.set(base, container); }
        }

        if (parts.segments.length === 0) {
            if (containerKey === 'datGlobal') { this.datGlobals.set(base, value); }
            else if (containerKey === 'configGlobal') { this.configGlobals.set(base, value); }
            else if (containerKey === 'datPrivate') { datPrivate.set(base, value); }
            else if (frame && containerKey === 'local') { frame.locals.set(base, value); }
            else if (frame && containerKey === 'param') { frame.params.set(base, value); }
            else if (containerKey === 'system') { this.setSystemVar(base, value); }
            else if (frame) { frame.locals.set(base, value); }
            else { datPrivate.set(base, value); }
            return;
        }

        // walk down to the last component and set it
        let current = container;
        for (let i = 0; i < parts.segments.length; i++) {
            const seg = parts.segments[i];
            if (i === parts.segments.length - 1) {
                if (seg.kind === 'index') {
                    const idx = Math.trunc(this.evalSegment(thread, seg.text)) - 1;
                    ensureArray(current);
                    if (idx >= 0) { current.v[idx] = value; }
                } else {
                    if (current.t === 'undef') { upgradeToStruct(current); }
                    if (current.t === 'struct') { current.v.set(seg.text.toLowerCase(), value); }
                }
                return;
            }
            if (seg.kind === 'index') {
                const idx = Math.trunc(this.evalSegment(thread, seg.text)) - 1;
                ensureArray(current);
                if (idx < 0) { return; }
                let next = current.v[idx];
                if (!next) { next = { t: 'undef' }; current.v[idx] = next; }
                current = next;
            } else {
                if (current.t === 'undef') { upgradeToStruct(current); }
                if (current.t !== 'struct') { return; }
                let next = current.v.get(seg.text.toLowerCase());
                if (!next) { next = { t: 'undef' }; current.v.set(seg.text.toLowerCase(), next); }
                current = next;
            }
        }
    }

    private evalSegment(thread: KrlThread, text: string): number {
        return krlNumber(evaluateExpression(text, this.ctxFor(thread)));
    }

    private parseLValue(text: string): { base: string; segments: { kind: 'index' | 'member'; text: string }[] } | null {
        const m = /^([A-Za-z_$][\w$]*)/.exec(text.trim());
        if (!m) { return null; }
        const base = m[1];
        const segments: { kind: 'index' | 'member'; text: string }[] = [];
        let rest = text.trim().slice(m[0].length);
        while (rest.length > 0) {
            if (/^\./.test(rest)) {
                const mm = /^\.([A-Za-z_$][\w$]*)/.exec(rest);
                if (!mm) { break; }
                segments.push({ kind: 'member', text: mm[1] });
                rest = rest.slice(mm[0].length);
                continue;
            }
            if (/^\[/.test(rest)) {
                const close = findClosingBracket(rest);
                if (close < 0) { break; }
                segments.push({ kind: 'index', text: rest.slice(1, close) });
                rest = rest.slice(close + 1);
                continue;
            }
            break;
        }
        return { base, segments };
    }
    /**
     * Execute a declaration statement.
     * - with frame: runtime locals (or GLOBAL into DAT globals)
     * - without frame: .dat loading into config globals / dat globals / dat privates
     */
    private executeDeclFrame(
        frame: KrlCallFrame | null,
        text: string,
        datPath?: string,
        isConfigDat = false,
        datThread?: KrlThread,
    ): void {
        const m = text.match(/^\s*(GLOBAL\s+)?(?:DECL\s+)?([A-Z_$][\w$]*)\s+(.+)$/i);
        if (!m) { return; }
        const isGlobal = !!m[1];
        const typeRaw = m[2].toUpperCase();
        const rest = m[3];
        const ctx = this.ctxFor(this.threadForDecl(frame, datPath, datThread));

        for (const item of splitTopLevel(rest, ',')) {
            const part = item.trim();
            if (!part) { continue; }
            const eq = findSingleEq(part);
            const namePart = (eq >= 0 ? part.slice(0, eq) : part).trim();
            const initText = eq >= 0 ? part.slice(eq + 1).trim() : '';
            const dimMatch = namePart.match(/^([A-Za-z_$][\w$]*)(?:\[(\d+)\])?$/);
            if (!dimMatch) { continue; }
            const baseName = dimMatch[1].toLowerCase();
            const dim = dimMatch[2] ? parseInt(dimMatch[2], 10) : 0;

            let value: KrlValue;
            if (initText) {
                value = initText.startsWith('{') && initText.endsWith('}')
                    ? parseBracedLiteral(initText)
                    : evaluateExpression(initText, ctx);
            } else if (dim > 0) {
                value = { t: 'array', v: new Array(dim).fill(null).map(() => cloneValue(defaultValue(typeRaw))) };
            } else {
                value = defaultValue(typeRaw);
            }

            if (frame) {
                if (isGlobal) { this.datGlobals.set(baseName, value); }
                else { frame.locals.set(baseName, value); }
                continue;
            }
            if (isConfigDat) {
                this.configGlobals.set(baseName, value);
                continue;
            }
            if (isGlobal) {
                this.datGlobals.set(baseName, value);
                continue;
            }
            if (datPath) {
                this.getDatPrivateMapForPath(datPath).set(baseName, value);
            } else {
                this.datGlobals.set(baseName, value);
            }
        }
    }

    /** Thread wrapper used while evaluating .dat declarations. */
    private threadForDecl(frame: KrlCallFrame | null, datPath?: string, datThread?: KrlThread): KrlThread {
        if (frame) {
            return { id: -1, name: 'DAT', file: frame.progPath, finished: false, stack: [frame] };
        }
        if (datThread) { return datThread; }
        if (datPath) { return this.threadForDatPath(datPath); }
        const t = this.threads[0];
        return t ?? { id: -1, name: 'DAT', file: '', finished: true, stack: [] };
    }

    private threadForDatPath(datPath: string): KrlThread {
        return { id: -1, name: 'DAT', file: datPath, finished: false, stack: [] };
    }

    private setSystemVar(name: string, value: KrlValue): void {
        const key = name.toLowerCase();
        switch (key) {
            // Scalar system vars — store directly
            case '$timer': case '$in': case '$out': case '$anin': case '$anout':
            case '$pos_act': case '$pos_act_m1': case '$axis_act':
            case '$tool': case '$base': case '$robroot':
            case '$apo': case '$vel': case '$acc':
            case '$ov_pro': case '$move_enable': case '$peri_rdy':
            case '$em_stop': case '$brake': case '$drives_on': case '$drives_off':
            case '$cycle': case '$pro_state': case '$state': case '$pose':
                this.systemVarStore.set(key, value);
                break;
            // $APO member writes
            case '$apo.cdis': case '$apo_cdis':
                this.writeSystemStructMember('$apo', 'cdis', value); break;
            case '$apo.cvel': case '$apo_cvel':
                this.writeSystemStructMember('$apo', 'cvel', value); break;
            case '$apo.cptp': case '$apo_cptp':
                this.writeSystemStructMember('$apo', 'cptp', value); break;
            case '$apo.cori': case '$apo_cori':
                this.writeSystemStructMember('$apo', 'cori', value); break;
            case '$apo.cpy': case '$apo_cpy':
                this.writeSystemStructMember('$apo', 'cdis', value); break;
            // $VEL member writes
            case '$vel.cp':   case '$vel_cp':
                this.writeSystemStructMember('$vel', 'cp',   value); break;
            case '$vel.ori1': case '$vel_ori1':
                this.writeSystemStructMember('$vel', 'ori1', value); break;
            case '$vel.ori2': case '$vel_ori2':
                this.writeSystemStructMember('$vel', 'ori2', value); break;
            case '$vel.ap':   case '$vel_ap':
                this.writeSystemStructMember('$vel', 'ap',   value); break;
            // $ACC member writes
            case '$acc.cp':   case '$acc_cp':
                this.writeSystemStructMember('$acc', 'cp',   value); break;
            case '$acc.ori1': case '$acc_ori1':
                this.writeSystemStructMember('$acc', 'ori1', value); break;
            case '$acc.ori2': case '$acc_ori2':
                this.writeSystemStructMember('$acc', 'ori2', value); break;
            default:
                break;
        }
    }

    /** Function invocation used by the expression evaluator. */
    private invokeFunction(thread: KrlThread, name: string, args: KrlValue[]): KrlValue | null {
        const low = name.toLowerCase();
        const builtin = this.runBuiltin(low, args);
        if (builtin !== null) { return builtin; }
        const mod = this.modules.get(low);
        if (!mod) { return null; }
        return this.runNestedFunction(thread, mod.path, mod.func, args);
    }

    private runBuiltin(name: string, args: KrlValue[]): KrlValue | null {
        const n = (i: number, fb = 0) => krlNumber(args[i], fb);
        // KRL trig functions use degrees
        const D2R = Math.PI / 180;
        const R2D = 180 / Math.PI;
        switch (name) {
            // Arithmetic
            case 'abs':   return args.length >= 1 ? KRL_REAL(Math.abs(n(0))) : null;
            case 'sign':  return args.length >= 1 ? KRL_INT(Math.sign(n(0))) : null;
            case 'trunc': return args.length >= 1 ? KRL_INT(Math.trunc(n(0))) : null;
            case 'round': return args.length >= 1 ? KRL_INT(Math.round(n(0))) : null;
            case 'sqrt':  return args.length >= 1 ? KRL_REAL(Math.sqrt(Math.abs(n(0)))) : null;
            case 'min':   return args.length >= 2 ? KRL_REAL(Math.min(n(0), n(1))) : null;
            case 'max':   return args.length >= 2 ? KRL_REAL(Math.max(n(0), n(1))) : null;
            case 'pow':   return args.length >= 2 ? KRL_REAL(Math.pow(n(0), n(1))) : null;
            case 'exp':   return args.length >= 1 ? KRL_REAL(Math.exp(n(0))) : null;
            case 'ln':    return args.length >= 1 ? KRL_REAL(Math.log(Math.abs(n(0)) || 1e-300)) : null;
            // Trigonometry (degrees in/out, per KRL spec)
            case 'sin':   return args.length >= 1 ? KRL_REAL(Math.sin(n(0) * D2R)) : null;
            case 'cos':   return args.length >= 1 ? KRL_REAL(Math.cos(n(0) * D2R)) : null;
            case 'tan':   return args.length >= 1 ? KRL_REAL(Math.tan(n(0) * D2R)) : null;
            case 'asin':  return args.length >= 1 ? KRL_REAL(Math.asin(n(0)) * R2D) : null;
            case 'acos':  return args.length >= 1 ? KRL_REAL(Math.acos(n(0)) * R2D) : null;
            case 'atan':  return args.length >= 1 ? KRL_REAL(Math.atan(n(0)) * R2D) : null;
            case 'atan2': return args.length >= 2 ? KRL_REAL(Math.atan2(n(0), n(1)) * R2D) : null;
            // Type / sequence helpers
            case 'odd':   return args.length >= 1 ? KRL_BOOL(Math.abs(Math.trunc(n(0))) % 2 === 1) : null;
            case 'even':  return args.length >= 1 ? KRL_BOOL(Math.abs(Math.trunc(n(0))) % 2 === 0) : null;
            case 'len':   return args.length >= 1 ? KRL_INT(args[0].t === 'str' ? args[0].v.length : (args[0].t === 'array' ? args[0].v.length : 0)) : null;
            // Bitwise
            case 'b_and': return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) & Math.trunc(n(1))) : null;
            case 'b_or':  return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) | Math.trunc(n(1))) : null;
            case 'b_xor': return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) ^ Math.trunc(n(1))) : null;
            case 'b_not': return args.length >= 1 ? KRL_INT(~Math.trunc(n(0))) : null;
            default: return null;
        }
    }

    private top(thread: KrlThread): KrlCallFrame | undefined {
        return thread.stack[thread.stack.length - 1];
    }

    /** Evaluate a KRL expression in the context of the frame identified by a handle.
     *  Returns the display string, or an empty string if evaluation fails. */
    evaluate(expression: string, frameId: number): string {
        const handle = this.handles.get(frameId);
        if (!handle || handle.kind !== 'frame') { return ''; }
        const thread = this.threads[handle.threadId ?? -1];
        if (!thread) { return ''; }
        try {
            const val = evaluateExpression(expression, this.ctxFor(thread));
            return displayValue(val);
        } catch {
            return '';
        }
    }

    /** Run a DEFFCT/DEF synchronously for use inside an expression. */
    private runNestedFunction(thread: KrlThread, progPath: string, func: KrlFunctionInfo, args: KrlValue[]): KrlValue | null {
        if (this.functionDepth > 100) {
            this.onOutput(`[${thread.name}] recursion depth exceeded in ${func.displayName}`);
            return null;
        }
        this.functionDepth++;
        try {
            const frame = this.makeFrame(progPath, func, args, -1, 0);
            thread.stack.push(frame);
            const prog = this.programs.get(progPath);
            let guard = 0;
            while (prog && guard++ < 50000) {
                if (this.stopRequested) { break; }
                const top = thread.stack[thread.stack.length - 1];
                if (!top || top !== frame) { break; }
                const stmt = prog.stmts[top.pc];
                if (!stmt) { this.popFrame(thread, frame.returnPc); break; }
                this.systemTime++;
                const res = this.execStmt(thread, prog, top, stmt);
                if (res === 'finished') { break; }
            }
            const value = frame.returnValue;
            const idx = thread.stack.lastIndexOf(frame);
            if (idx >= 0) { thread.stack.splice(idx, 1); }
            return value;
        } finally {
            this.functionDepth--;
        }
    }

    }


// ---------------------------------------------------------------------------
// module-level helpers

/** Find the first top-level assignment '=' that is not part of == <= >= <>. */
export function findSingleEq(text: string): number {
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === quote) { inString = false; quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { inString = true; quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (c === '=' && depth === 0) {
            const prev = i > 0 ? text[i - 1] : '';
            const next = i + 1 < text.length ? text[i + 1] : '';
            if (!'=!<>'.includes(prev) && next !== '=' && next !== '>') { return i; }
        }
    }
    return -1;
}

/** Find the index of the closing ']' matching the '[' at position 0 of text. */
function findClosingBracket(text: string): number {
    if (!text.startsWith('[')) { return -1; }
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === quote) { inString = false; quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { inString = true; quote = c; continue; }
        if (c === '[') { depth++; continue; }
        if (c === ']') { depth--; if (depth === 0) { return i; } }
    }
    return -1;
}

function ensureArray(v: KrlValue): asserts v is { t: 'array'; v: KrlValue[] } {
    if (v.t !== 'array') {
        (v as unknown as { t: 'array'; v: KrlValue[] }).t = 'array';
        (v as unknown as { t: 'array'; v: KrlValue[] }).v = [];
    }
}

function upgradeToStruct(v: KrlValue): void {
    if (v.t === 'undef') {
        (v as unknown as { t: 'struct'; name: string; v: Map<string, KrlValue> }).t = 'struct';
        (v as unknown as { t: 'struct'; name: string; v: Map<string, KrlValue> }).name = 'STRUCT';
        (v as unknown as { t: 'struct'; name: string; v: Map<string, KrlValue> }).v = new Map();
    }
}

function cloneValue(v: KrlValue): KrlValue {
    switch (v.t) {
        case 'struct': {
            const m = new Map<string, KrlValue>();
            for (const [k, x] of v.v) { m.set(k, cloneValue(x)); }
            return { t: 'struct', name: v.name, v: m };
        }
        case 'array': return { t: 'array', v: v.v.map(cloneValue) };
        default: return v;
    }
}
