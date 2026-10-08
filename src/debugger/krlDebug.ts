// krlDebug.ts
// Inline VS Code debug adapter for KRL. Bridges the VS Code debug UI to the
// KrlRuntime simulator via the Debug Adapter Protocol (DAP).
// Registered by extension.ts via registerKrlDebugAdapter().

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KrlRuntime } from './krlRuntime';

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
            case 'continue':                 await this.onContinue(req, args); break;
            case 'next':                     await this.onStep(req, 'stepOver', args.threadId); break;
            case 'stepIn':                   await this.onStep(req, 'stepIn', args.threadId); break;
            case 'stepOut':                  await this.onStep(req, 'stepOut', args.threadId); break;
            case 'pause':                    this.onPause(req); break;
            case 'threads':                  this.onThreads(req); break;
            case 'stackTrace':               this.onStackTrace(req, args); break;
            case 'scopes':                   this.onScopes(req, args); break;
            case 'variables':                this.onVariables(req, args); break;
            case 'evaluate':                 this.onEvaluate(req, args); break;
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
            supportsTerminateRequest: true,
        });
        // Tell VS Code we are ready to receive breakpoint configuration
        this.sendEvent('initialized');
    }

    private async onLaunch(req: DapRequest, args: any): Promise<void> {
        this.stopOnEntry = args.stopOnEntry !== false;
        const submitPaths = this.resolveSubmitPrograms(args.program ?? '', args.submitPrograms);

        const rt = new KrlRuntime({
            mainPath: args.program ?? '',
            submitPaths,
            configDatPath: args.configDat,
            stopOnEntry: this.stopOnEntry,
            onOutput: (text) =>
                this.sendEvent('output', { category: 'stdout', output: text + '\n' }),
        });

        if (submitPaths.length > 0) {
            this.sendEvent('output', {
                category: 'stdout',
                output: `[krl] submit programs: ${submitPaths.join(', ')}\n`,
            });
        }

        const errors = rt.load();
        for (const e of errors) {
            this.sendEvent('output', { category: 'stderr', output: `[krl] ${e}\n` });
        }
        if (errors.length > 0) {
            this.respond(req, undefined, `Failed to load KRL program: ${errors[0]}`);
            this.sendEvent('terminated');
            return;
        }

        this.runtime = rt;
        this.respond(req);
    }

    private resolveSubmitPrograms(programPath: string, configured: unknown): string[] {
        if (Array.isArray(configured) && configured.length > 0) {
            return configured.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        }
        if (!programPath) { return []; }
        const dir = path.dirname(programPath);
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        const files = names
            .filter(name => /\.sub$/i.test(name))
            .map(name => path.join(dir, name))
            .filter(full => path.resolve(full).toLowerCase() !== path.resolve(programPath).toLowerCase());
        files.sort((a, b) => {
            const an = path.basename(a).toLowerCase();
            const bn = path.basename(b).toLowerCase();
            if (an === 'sps.sub' && bn !== 'sps.sub') { return -1; }
            if (bn === 'sps.sub' && an !== 'sps.sub') { return 1; }
            return an.localeCompare(bn);
        });
        return files;
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

        if (!sourcePath || !this.runtime) {
            this.respond(req, { breakpoints: clientBps.map(() => ({ verified: false })) });
            return;
        }

        this.runtime.clearBreakpoints(sourcePath);
        const lines = clientBps.map(bp => bp.line);
        const verified = this.runtime.setBreakpoints(sourcePath, lines);
        this.respond(req, {
            breakpoints: lines.map((line, i) => ({ verified: verified[i], line })),
        });
    }

    private async onContinue(req: DapRequest, _args: any): Promise<void> {
        this.respond(req, { allThreadsContinued: true });
        await this.runAndNotify('continue');
    }

    private async onStep(
        req: DapRequest,
        mode: 'stepIn' | 'stepOver' | 'stepOut',
        threadId?: number
    ): Promise<void> {
        this.respond(req);
        await this.runAndNotify(mode, threadId);
    }

    private onPause(req: DapRequest): void {
        this.runtime?.pause();
        this.respond(req);
    }

    private onThreads(req: DapRequest): void {
        const threads = this.runtime?.getThreads() ?? [];
        this.respond(req, {
            threads: threads.map(t => ({ id: t.id, name: t.name })),
        });
    }

    private onStackTrace(req: DapRequest, args: any): void {
        const frames = this.runtime?.getStackTrace(args.threadId ?? 0) ?? [];
        this.respond(req, {
            stackFrames: frames.map(f => ({
                id: f.frameId,
                name: f.name,
                source: { name: f.file.split(/[\\/]/).pop(), path: f.file },
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
        const vars = this.runtime?.getVariables(args.variablesReference) ?? [];
        this.respond(req, {
            variables: vars.map(v => ({
                name: v.name,
                value: v.value,
                type: v.type,
                variablesReference: v.reference,
            })),
        });
    }

    private onEvaluate(req: DapRequest, args: any): void {
        const result = this.runtime?.evaluate(args.expression ?? '', args.frameId ?? -1);
        if (result) {
            this.respond(req, { result, variablesReference: 0 });
        } else {
            this.respond(req, undefined, `cannot evaluate '${args.expression}'`);
        }
    }

    private onDisconnect(req: DapRequest): void {
        this.runtime?.pause();
        this.runtime = undefined;
        this.respond(req);
        this.sendEvent('terminated');
    }

    // ---- execution driver ---------------------------------------------------

    private async runAndNotify(
        mode: 'continue' | 'stepIn' | 'stepOver' | 'stepOut',
        threadId?: number
    ): Promise<void> {
        if (!this.runtime) { return; }
        this.sendEvent('continued', { allThreadsContinued: mode === 'continue' });

        const info = await this.runtime.run(mode, threadId);

        switch (info.reason) {
            case 'breakpoint':
                this.sendEvent('stopped', {
                    reason: 'breakpoint',
                    threadId: info.threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            case 'step':
                this.sendEvent('stopped', {
                    reason: 'step',
                    threadId: info.threadId ?? threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            case 'pause':
                this.sendEvent('stopped', {
                    reason: 'pause',
                    threadId: threadId ?? 0,
                    allThreadsStopped: true,
                });
                break;
            case 'end':
                this.sendEvent('terminated');
                break;
            case 'error':
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
