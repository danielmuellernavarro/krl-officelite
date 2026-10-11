// krlDebug.ts
// Inline VS Code debug adapter for KRL. Bridges the VS Code debug UI to the
// KrlRuntime simulator via the Debug Adapter Protocol (DAP).
// Registered by extension.ts via registerKrlDebugAdapter().

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KrlRuntime, RunMode, formatOverride } from './krlRuntime';
import { KrlMode, KRL_MODES } from './krlMotion';
import { resolveLaunchFiles } from './krlWorkspace';
import { parseKrlDocument } from '../language/krlSyntax';

// ---------------------------------------------------------------------------
// Public registration — called once from extension.ts activate()

export function registerKrlDebugAdapter(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('krl', {
            createDebugAdapterDescriptor() {
                return new vscode.DebugAdapterInlineImplementation(new KrlDebugSession());
            },
        })
    );
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('krl', new KrlConfigurationProvider())
    );
}

// ---------------------------------------------------------------------------
// Launch configuration provider

class KrlConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // Allow F5 with no launch.json when a .src/.sub file is open
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && /\.(src|sub)$/i.test(editor.document.fileName)) {
                config.type = 'krl';
                config.name = 'KRL: Debug';
                config.request = 'launch';
                config.program = editor.document.fileName;
                config.stopOnEntry = true;
            }
        }
        if (!config.program) {
            return vscode.window
                .showInformationMessage('Open a KRL .src file to debug.')
                .then(() => undefined);
        }
        return config;
    }
}

// ---------------------------------------------------------------------------
// Minimal DAP message shapes (no external package required)

interface DapMessage { seq: number; type: string; }
interface DapRequest extends DapMessage { type: 'request'; command: string; arguments?: any; }
interface DapResponse extends DapMessage {
    type: 'response'; request_seq: number; success: boolean;
    command: string; message?: string; body?: any;
}
interface DapEvent extends DapMessage { type: 'event'; event: string; body?: any; }

// ---------------------------------------------------------------------------
// Inline DAP session

class KrlDebugSession implements vscode.DebugAdapter {
    private readonly _emitter = new vscode.EventEmitter<DapMessage>();
    readonly onDidSendMessage: vscode.Event<DapMessage> = this._emitter.event;

    private seq = 1;
    private runtime: KrlRuntime | undefined;
    private stopOnEntry = true;
    private disposed = false;
    /** breakpoints received before the program was loaded, by source path */
    private pendingBreakpoints = new Map<string, number[]>();

    // ---- vscode.DebugAdapter -------------------------------------------------

    handleMessage(message: any): void {
        if ((message as DapMessage).type === 'request') {
            this.dispatch(message as DapRequest).catch(err => {
                this.sendEvent('output', {
                    category: 'stderr',
                    output: `[krl] internal debugger error: ${err}\n`,
                });
            });
        }
    }

    dispose(): void {
        this.disposed = true;
        this.runtime?.pause();
        this._emitter.dispose();
    }

    // ---- request dispatcher --------------------------------------------------

    private async dispatch(req: DapRequest): Promise<void> {
        const args = req.arguments ?? {};
        switch (req.command) {
            case 'initialize':               this.onInitialize(req); break;
            case 'launch':                   await this.onLaunch(req, args); break;
            case 'configurationDone':        await this.onConfigurationDone(req); break;
            case 'setBreakpoints':           this.onSetBreakpoints(req, args); break;
            case 'setExceptionBreakpoints':  this.respond(req); break;
            case 'continue':                 await this.onContinue(req); break;
            case 'next':                     await this.onStep(req, 'stepOver', args.threadId); break;
            case 'stepIn':                   await this.onStep(req, 'stepIn', args.threadId); break;
            case 'stepOut':                  await this.onStep(req, 'stepOut', args.threadId); break;
            case 'pause':                    this.onPause(req); break;
            case 'threads':                  this.onThreads(req); break;
            case 'stackTrace':               this.onStackTrace(req, args); break;
            case 'scopes':                   this.onScopes(req, args); break;
            case 'variables':                this.onVariables(req, args); break;
            case 'setVariable':              this.onSetVariable(req, args); break;
            case 'evaluate':                 this.onEvaluate(req, args); break;
            case 'krlLiveWatch':             this.onLiveWatch(req, args); break;
            case 'krlInterpreter':           this.onInterpreter(req, args); break;
            case 'krlMessage':               this.onMessage(req, args); break;
            case 'krlMainRun':               this.respond(req, { mainRun: this.runtime?.getMainRun() ?? [], advanceRun: this.runtime?.getAdvanceRun() ?? [] }); break;
            case 'krlVariables':             this.respond(req, { variables: this.runtime?.listVariables() ?? [] }); break;
            case 'krlRobot':                 this.respond(req, { entries: this.runtime?.getRobotState() ?? [] }); break;
            case 'krlIo':                    this.onIo(req, args); break;
            case 'krlOverride':              this.onOverride(req, args); break;
            case 'krlMode':                  this.onMode(req, args); break;
            case 'exceptionInfo':            this.onExceptionInfo(req); break;
            case 'disconnect':
            case 'terminate':                this.onDisconnect(req); break;
            default:                         this.respond(req); break;
        }
    }

    // ---- handlers ------------------------------------------------------------

    private onInitialize(req: DapRequest): void {
        this.respond(req, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true,
            supportsTerminateRequest: true,
            supportsExceptionInfoRequest: true,
        });
    }

    private async onLaunch(req: DapRequest, args: any): Promise<void> {
        this.stopOnEntry = args.stopOnEntry !== false;
        const files = resolveLaunchFiles({
            program: args.program ?? '',
            submitPrograms: args.submitPrograms,
            configDat: args.configDat,
            sources: args.sources,
            machineData: args.machineData,
        });
        const cfg = vscode.workspace.getConfiguration('krl-officelite');
        const override = typeof args.override === 'number' ? args.override : cfg.get<number>('simulation.override', 100);
        const modeArg = String(args.mode ?? cfg.get<string>('simulation.mode', 'T1')).toUpperCase().replace(/^EXT$/, 'EX');
        const mode: KrlMode = KRL_MODES.includes(modeArg as KrlMode) ? modeArg as KrlMode : 'T1';

        const rt = new KrlRuntime({
            mainPath: files.mainPath,
            submitPaths: files.submitPaths,
            sources: files.sources,
            configDatPath: files.configDatPath,
            machineDataPath: files.machineDataPath,
            // simulated time runs in real time; an override above 100 % speeds it up
            simulationOverride: 100,
            override,
            mode,
            onOverrideOrModeChanged: () => this.sendState(),
            stopOnEntry: this.stopOnEntry,
            onOutput: (text) =>
                this.sendEvent('output', { category: 'stdout', output: text + '\n' }),
            onThreadExit: (threadId) =>
                this.sendEvent('thread', { reason: 'exited', threadId }),
            onMessagesChanged: (messages) => this.sendEvent('krlMessages', { messages }),
        });

        const rel = (p: string) => path.relative(files.robotRoot, p) || path.basename(p);
        this.sendEvent('output', {
            category: 'console',
            output: `[krl] robot program: ${rel(files.mainPath)}\n`
                + `[krl] submit programs: ${files.submitPaths.length > 0 ? files.submitPaths.map(rel).join(', ') : '(none)'}\n`
                + `[krl] $config.dat: ${files.configDatPath ?? '(not found)'}\n`
                + `[krl] ${files.sources.length} further modules/data lists from ${files.robotRoot}\n`,
        });

        const errors = rt.load();
        this.sendEvent('output', {
            category: 'console',
            output: `[krl] robot: ${rt.describeRobot()}\n`
                + `[krl] mode ${rt.describeMode()}, override ${formatOverride(rt.getOverride().value)} %`
                + ` (debug toolbar: - / + to change the override, the mode badge while paused)\n`,
        });
        for (const e of errors) {
            this.sendEvent('output', { category: 'stderr', output: `[krl] ${e}\n` });
        }
        if (errors.length > 0) {
            this.respond(req, undefined, `Failed to load KRL program: ${errors[0]}`);
            this.sendEvent('terminated');
            return;
        }

        this.reportSyntaxErrors([files.mainPath, ...files.submitPaths, ...files.sources]);
        this.runtime = rt;
        // the status bar shows the override of the new session
        this.sendState();
        for (const [source, lines] of this.pendingBreakpoints) { rt.setBreakpoints(source, lines); }
        this.pendingBreakpoints.clear();
        this.respond(req);
        // ready for setBreakpoints / configurationDone
        this.sendEvent('initialized');
    }

    /**
     * The controller would not accept programs with syntax errors; the simulator skips
     * what it cannot run. List the errors in the Debug Console, each one clickable.
     */
    private reportSyntaxErrors(files: string[]): void {
        const MAX = 30;
        let shown = 0;
        let total = 0;
        const withErrors = new Set<string>();
        for (const file of files) {
            let text: string;
            try { text = fs.readFileSync(file, 'latin1'); } catch { continue; }
            for (const issue of parseKrlDocument(file, text).issues) {
                if (issue.severity !== 'error') { continue; }
                total++;
                withErrors.add(file);
                if (shown++ >= MAX) { continue; }
                this.sendEvent('output', {
                    category: 'stderr',
                    output: `[krl] syntax error ${path.basename(file)}:${issue.line + 1}: ${issue.message}\n`,
                    source: { name: path.basename(file), path: file },
                    line: issue.line + 1,
                    column: issue.start + 1,
                });
            }
        }
        if (total > 0) {
            this.sendEvent('output', {
                category: 'stderr',
                output: `[krl] ${total} syntax error${total === 1 ? '' : 's'} in ${withErrors.size} file${withErrors.size === 1 ? '' : 's'}`
                    + `${total > MAX ? ` (first ${MAX} listed)` : ''}; the controller would not accept them (see Problems)\n`,
            });
        }
    }

    private async onConfigurationDone(req: DapRequest): Promise<void> {
        this.respond(req);
        if (!this.runtime) { return; }

        if (this.stopOnEntry) {
            const threads = this.runtime.getThreads();
            this.sendEvent('stopped', {
                reason: 'entry',
                threadId: threads[0]?.id ?? 0,
                allThreadsStopped: true,
            });
        } else {
            await this.runAndNotify('continue');
        }
    }

    private onSetBreakpoints(req: DapRequest, args: any): void {
        const sourcePath: string = args.source?.path ?? '';
        const clientBps: { line: number }[] = args.breakpoints ?? [];
        const lines = clientBps.map(bp => bp.line);

        if (!sourcePath) {
            this.respond(req, { breakpoints: lines.map(line => ({ verified: false, line })) });
            return;
        }
        if (!this.runtime) {
            this.pendingBreakpoints.set(sourcePath, lines);
            this.respond(req, { breakpoints: lines.map(line => ({ verified: false, line })) });
            return;
        }
        const result = this.runtime.setBreakpoints(sourcePath, lines);
        this.respond(req, { breakpoints: result });
    }

    private async onContinue(req: DapRequest): Promise<void> {
        this.respond(req, { allThreadsContinued: true });
        await this.runAndNotify('continue');
    }

    private async onStep(req: DapRequest, mode: RunMode, threadId?: number): Promise<void> {
        this.respond(req);
        await this.runAndNotify(mode, threadId);
    }

    private onPause(req: DapRequest): void {
        this.runtime?.pause();
        this.respond(req);
    }

    private onThreads(req: DapRequest): void {
        const all = this.runtime?.getThreads() ?? [];
        const alive = all.filter(t => !t.finished);
        this.respond(req, {
            threads: (alive.length > 0 ? alive : all).map(t => ({ id: t.id, name: t.name })),
        });
    }

    private onStackTrace(req: DapRequest, args: any): void {
        const frames = this.runtime?.getStackTrace(args.threadId ?? 0) ?? [];
        this.respond(req, {
            stackFrames: frames.map(f => ({
                id: f.frameId,
                name: f.name,
                source: { name: path.basename(f.file), path: f.file },
                line: f.line + 1,   // runtime uses 0-based; DAP expects 1-based
                column: 1,
            })),
            totalFrames: frames.length,
        });
    }

    private onScopes(req: DapRequest, args: any): void {
        const scopes = this.runtime?.getScopes(args.frameId) ?? [];
        this.respond(req, {
            scopes: scopes.map(s => ({
                name: s.name,
                variablesReference: s.ref,
                expensive: false,
            })),
        });
    }

    private onVariables(req: DapRequest, args: any): void {
        const vars = this.runtime?.getVariables(args.variablesReference, args.start, args.count) ?? [];
        this.respond(req, {
            variables: vars.map(v => ({
                name: v.name,
                value: v.value,
                type: v.type,
                variablesReference: v.reference,
                indexedVariables: v.indexedVariables,
                evaluateName: v.evaluateName,
            })),
        });
    }

    private onSetVariable(req: DapRequest, args: any): void {
        const result = this.runtime?.setVariable(args.variablesReference, args.name ?? '', args.value ?? '');
        if (!result || typeof result === 'string') {
            this.respond(req, undefined, result ?? 'not running');
            return;
        }
        this.respond(req, {
            value: result.value,
            type: result.type,
            variablesReference: result.reference,
            indexedVariables: result.indexedVariables,
        });
    }

    private onEvaluate(req: DapRequest, args: any): void {
        // in the debug console `NAME = value` assigns, e.g. `$IN[5] = TRUE`
        const allowAssign = args.context === 'repl';
        const result = this.runtime?.evaluateForDebugger(args.expression ?? '', args.frameId, allowAssign);
        if (result) {
            this.respond(req, {
                result: result.value,
                type: result.type,
                variablesReference: result.reference,
                indexedVariables: result.indexedVariables,
            });
        } else {
            this.respond(req, undefined, `cannot evaluate '${args.expression}'`);
        }
    }

    /** Custom request of the KRL Live Watch view; answered while the program runs, too. */
    private onLiveWatch(req: DapRequest, args: any): void {
        const expressions: string[] = Array.isArray(args.expressions) ? args.expressions : [];
        this.respond(req, {
            values: expressions.map(expression => {
                const v = this.runtime?.peek(String(expression));
                return v ? { expression, value: v.value, type: v.type } : { expression, value: '<not available>', type: '' };
            }),
        });
    }

    /**
     * Custom request: list the interpreters (and the SUB programs not running),
     * stop / start / restart one of them, or start a SUB program (`startFile`).
     */
    private onInterpreter(req: DapRequest, args: any): void {
        const runtime = this.runtime;
        if (!runtime) { this.respond(req, undefined, 'the KRL program is not running'); return; }
        if (args.action !== 'list') {
            let threadId = Number(args.threadId);
            if (args.action === 'startFile') {
                const started = runtime.startSubmitProgram(String(args.file ?? ''));
                if (typeof started === 'string') { this.respond(req, undefined, started); return; }
                threadId = started;
            } else {
                const error = runtime.controlInterpreter(threadId, args.action);
                if (error) { this.respond(req, undefined, error); return; }
            }
            // VS Code fetches the threads again: the name shows "(stopped)", a new or restarted thread appears
            this.sendEvent('thread', { reason: 'started', threadId });
        }
        this.respond(req, { threads: runtime.getThreads(), idleSubmitPrograms: runtime.idleSubmitPrograms() });
    }

    /** Custom request of the KRL Messages view: list, acknowledge, acknowledge all, answer a dialog. */
    private onMessage(req: DapRequest, args: any): void {
        const runtime = this.runtime;
        if (!runtime) { this.respond(req, undefined, 'the KRL program is not running'); return; }
        let error: string | null = null;
        switch (args.action) {
            case 'acknowledge': error = runtime.acknowledgeMessage(Number(args.handle)); break;
            case 'acknowledgeAll': runtime.acknowledgeAllMessages(); break;
            case 'answer': error = runtime.answerDialog(Number(args.handle), Number(args.softkey)); break;
            default: break;
        }
        if (error) { this.respond(req, undefined, error); return; }
        this.respond(req, { messages: runtime.getMessages() });
    }

    /**
     * Custom request of the KRL I/O view: list the inputs / outputs (and pinned
     * expressions), set one to a value or toggle a Boolean one; also while running.
     */
    /** The error the program stopped at (VS Code's exception widget). */
    private onExceptionInfo(req: DapRequest): void {
        const error = this.runtime?.getLastError();
        this.respond(req, {
            exceptionId: error?.kind ?? 'error',
            description: error?.message ?? 'error',
            breakMode: 'always',
            details: error ? { message: error.message, stackTrace: `${path.basename(error.file)}:${error.line + 1}` } : undefined,
        });
    }

    /** Read or change the simulation override (args.value in %, 1 .. 10000). */
    private onOverride(req: DapRequest, args: any): void {
        const rt = this.runtime;
        if (!rt) { this.respond(req, undefined, 'no program loaded'); return; }
        if (typeof args.value === 'number') { rt.setOverride(args.value); }
        this.respond(req, this.state(rt));
    }

    /** Read or change the operating mode (args.mode: T1, T2, AUT, EX); not while the program runs. */
    private onMode(req: DapRequest, args: any): void {
        const rt = this.runtime;
        if (!rt) { this.respond(req, undefined, 'no program loaded'); return; }
        if (typeof args.mode === 'string') {
            const error = rt.setMode(args.mode.toUpperCase() as KrlMode);
            if (error) { this.respond(req, undefined, error); return; }
        }
        this.respond(req, this.state(rt));
    }

    /** Override and operating mode for the debug toolbar, the status bar and the KRL Robot view. */
    private state(rt: KrlRuntime): { value: number; ovPro: number; speed: number | null; mode: KrlMode; modeText: string } {
        return { ...rt.getOverride(), mode: rt.getMode(), modeText: rt.describeMode() };
    }

    private lastState = '';
    private sendState(): void {
        const rt = this.runtime;
        if (!rt || this.disposed) { return; }
        const body = this.state(rt);
        const text = JSON.stringify(body);
        if (text === this.lastState) { return; }
        this.lastState = text;
        this.sendEvent('krlState', body);
    }

    private onIo(req: DapRequest, args: any): void {
        const runtime = this.runtime;
        if (!runtime) { this.respond(req, undefined, 'the KRL program is not running'); return; }
        const expression = String(args.expression ?? '');
        let error: string | null = null;
        switch (args.action) {
            case 'set': error = runtime.setIo(expression, String(args.value ?? '')); break;
            case 'toggle': error = runtime.toggleIo(expression).error ?? null; break;
            default: break;
        }
        if (error) { this.respond(req, undefined, error); return; }
        const extra: string[] = Array.isArray(args.extra) ? args.extra.map(String) : [];
        this.respond(req, { groups: runtime.getIoState(extra) });
    }

    private onDisconnect(req: DapRequest): void {
        this.disposed = true;
        this.runtime?.pause();
        this.runtime = undefined;
        this.respond(req);
        this.sendEvent('terminated');
    }

    // ---- execution driver ---------------------------------------------------

    private async runAndNotify(mode: RunMode, threadId?: number): Promise<void> {
        const runtime = this.runtime;
        if (!runtime) { return; }
        if (runtime.isRunning()) { return; }
        this.sendEvent('continued', { threadId: threadId ?? 0, allThreadsContinued: true });

        const info = await runtime.run(mode, threadId);
        if (this.disposed || this.runtime !== runtime) { return; }

        switch (info.reason) {
            case 'breakpoint':
            case 'step':
            case 'pause':
                this.sendEvent('stopped', {
                    reason: info.reason,
                    threadId: info.threadId ?? threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            case 'halt':
                this.sendEvent('stopped', {
                    reason: 'pause',
                    description: 'Paused on HALT',
                    threadId: info.threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            case 'exception': {
                // the controller would stop the program here: VS Code shows the error at the line
                const error = runtime.getLastError();
                this.sendEvent('output', {
                    category: 'stderr',
                    output: `[krl] ${info.message ?? 'error'}: the program stops here like on the controller. Fix it (or set the value in the Variables view) and continue.
`,
                    ...(error ? { source: { name: path.basename(error.file), path: error.file }, line: error.line + 1, column: 1 } : {}),
                });
                this.sendEvent('stopped', {
                    reason: 'exception',
                    description: 'Paused on error',
                    text: info.message,
                    threadId: info.threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            }
            case 'busy':
                break;
            case 'end':
                this.sendEvent('terminated');
                break;
            case 'error':
            default:
                this.sendEvent('output', {
                    category: 'stderr',
                    output: `[krl] ${info.message ?? 'execution error'}\n`,
                });
                this.sendEvent('terminated');
                break;
        }
    }

    // ---- DAP message helpers ------------------------------------------------

    private respond(req: DapRequest, body?: any, errorMessage?: string): void {
        if (this.disposed && req.command !== 'disconnect' && req.command !== 'terminate') { return; }
        const msg: DapResponse = {
            seq: this.seq++,
            type: 'response',
            request_seq: req.seq,
            success: !errorMessage,
            command: req.command,
        };
        if (errorMessage) { msg.message = errorMessage; }
        if (body !== undefined) { msg.body = body; }
        this._emitter.fire(msg);
    }

    private sendEvent(event: string, body?: any): void {
        const msg: DapEvent = { seq: this.seq++, type: 'event', event };
        if (body !== undefined) { msg.body = body; }
        this._emitter.fire(msg);
    }
}
