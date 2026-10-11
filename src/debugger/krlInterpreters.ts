// krlInterpreters.ts
// Stop, start or restart one interpreter (the robot program or a submit
// program) while the others keep running, or start another SUB program in a
// further submit interpreter: from the context menu of a thread in the Call
// Stack view, or from the Command Palette (then a picker asks which one).
// Uses the debug adapter's custom `krlInterpreter` request.

import * as path from 'path';
import * as vscode from 'vscode';

type Action = 'stop' | 'start' | 'restart';

interface InterpreterInfo { id: number; name: string; finished: boolean; stopped: boolean; }

interface InterpreterItem extends vscode.QuickPickItem { id: number; }

/** Thread id from the Call Stack context menu argument: a number, `{ threadId }` or "thread:<session>:<id>". */
function threadIdOf(arg: unknown): number | undefined {
    const raw = typeof arg === 'object' && arg !== null ? (arg as { threadId?: unknown }).threadId : arg;
    if (typeof raw === 'number') { return raw; }
    const m = typeof raw === 'string' ? /(\d+)$/.exec(raw) : null;
    return m ? Number(m[1]) : undefined;
}

function stateOf(t: InterpreterInfo): string {
    return t.finished ? 'ended' : t.stopped ? 'stopped' : 'running';
}

async function pickInterpreter(session: vscode.DebugSession, action: Action): Promise<number | undefined> {
    const body = await session.customRequest('krlInterpreter', { action: 'list' });
    const all: InterpreterInfo[] = Array.isArray(body?.threads) ? body.threads : [];
    const candidates = all.filter(t => action === 'restart' || (action === 'stop' ? !t.stopped && !t.finished : t.stopped));
    if (candidates.length === 0) {
        void vscode.window.showInformationMessage(`No interpreter to ${action}.`);
        return undefined;
    }
    const picked = await vscode.window.showQuickPick<InterpreterItem>(
        candidates.map(t => ({ label: t.name.replace(/ \((stopped|ended)\)$/, ''), description: stateOf(t), id: t.id })),
        { placeHolder: `Interpreter to ${action}` },
    );
    return picked?.id;
}

async function control(action: Action, arg: unknown): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== 'krl') {
        void vscode.window.showInformationMessage('Start a KRL debug session first.');
        return;
    }
    try {
        const threadId = threadIdOf(arg) ?? await pickInterpreter(session, action);
        if (threadId === undefined) { return; }
        await session.customRequest('krlInterpreter', { action, threadId });
    } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
}

/** Run another SUB program in its own submit interpreter: one that is loaded but idle, or any .sub file. */
async function startSubmitProgram(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== 'krl') {
        void vscode.window.showInformationMessage('Start a KRL debug session first.');
        return;
    }
    try {
        const body = await session.customRequest('krlInterpreter', { action: 'list' });
        const idle: string[] = Array.isArray(body?.idleSubmitPrograms) ? body.idleSubmitPrograms : [];
        const browse = 'Browse...';
        const picked = await vscode.window.showQuickPick(
            [...idle.map(f => ({ label: path.basename(f), description: path.dirname(f), file: f })), { label: browse, description: 'choose a .sub file', file: '' }],
            { placeHolder: 'SUB program to start in a further submit interpreter' },
        );
        if (!picked) { return; }
        let file = picked.file;
        if (!file) {
            const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'KRL submit program': ['sub', 'SUB'] } });
            if (!uris || uris.length === 0) { return; }
            file = uris[0].fsPath;
        }
        await session.customRequest('krlInterpreter', { action: 'startFile', file });
    } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
}

export function registerKrlInterpreters(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('krl.interpreter.startSubmit', startSubmitProgram),
        vscode.commands.registerCommand('krl.interpreter.stop', (arg: unknown) => control('stop', arg)),
        vscode.commands.registerCommand('krl.interpreter.start', (arg: unknown) => control('start', arg)),
        vscode.commands.registerCommand('krl.interpreter.restart', (arg: unknown) => control('restart', arg)),
    );
}
