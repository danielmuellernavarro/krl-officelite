// krlValueEdit.ts
// Changing values with one click while a KRL debug session is paused:
//   Variables view: BOOL variables toggle (inline button), ENUM variables offer the
//     literals of their type only (the adapter marks them: krlBool / krlEnum).
//   Editor: a CodeLens above the line where the program stopped shows the variables
//     of the line with their values; a click toggles a BOOL, picks a literal of an
//     ENUM or asks for the new value. Change Value... in the editor context menu
//     does the same for the name under the cursor.
// The adapter sets the values (krlSetVariable / krlAssign) and refreshes the views.

import * as path from 'path';
import * as vscode from 'vscode';
import { parseKrlDocument } from '../language/krlSyntax';

/** Argument of the actions of the Variables view */
interface VariableContext {
    sessionId?: string;
    container?: { variablesReference?: number };
    variable?: { name: string; value: string; type?: string };
}

/** Where the program stopped: the top frame of the thread that stopped */
interface StopPosition { sessionId: string; frameId: number; file: string; line: number }

/** Access path of a variable: NAME, $IN[5], XP1.X, ... */
const ACCESS_PATH = /\$?[A-Za-z_][\w$]*(?:\s*\[[^\]]*\])?(?:\.[A-Za-z_]\w*(?:\s*\[[^\]]*\])?)*/;
const MAX_LENSES = 8;

const fileKey = (file: string) => path.resolve(file).toLowerCase();

function krlSession(sessionId?: string): vscode.DebugSession | undefined {
    const s = vscode.debug.activeDebugSession;
    return s && s.type === 'krl' && (!sessionId || s.id === sessionId) ? s : undefined;
}

function showError(err: unknown): void {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
}

async function enumLiterals(session: vscode.DebugSession, type: string | undefined): Promise<string[]> {
    if (!type || type === 'BOOL') { return []; }
    const r = await session.customRequest('krlEnumLiterals', { type }) as { literals?: string[] };
    return r.literals ?? [];
}

/** The new value: the other one of a BOOL, a literal of an ENUM, else what the user types; undefined when cancelled. */
async function askValue(session: vscode.DebugSession, name: string, value: string, type: string | undefined): Promise<string | undefined> {
    if (type === 'BOOL') { return /^TRUE$/i.test(value) ? 'FALSE' : 'TRUE'; }
    const literals = await enumLiterals(session, type);
    if (literals.length > 0) {
        const picked = await vscode.window.showQuickPick(
            literals.map(l => ({ label: l, description: l.toLowerCase() === value.toLowerCase() ? 'current value' : undefined })),
            { placeHolder: `${name} (${type})` });
        return picked?.label;
    }
    return vscode.window.showInputBox({ prompt: `New value of ${name}${type ? ` (${type})` : ''}`, value });
}

export function registerKrlValueEdit(context: vscode.ExtensionContext): void {
    let stop: StopPosition | undefined;
    const lensesChanged = new vscode.EventEmitter<void>();
    const setStop = (next: StopPosition | undefined) => { stop = next; lensesChanged.fire(); };

    context.subscriptions.push(
        lensesChanged,
        // where the program stopped: the stack trace VS Code asks for after a stop
        vscode.debug.registerDebugAdapterTrackerFactory('krl', {
            createDebugAdapterTracker(session) {
                let stoppedThread: number | undefined;
                const pending = new Map<number, number>();
                return {
                    onWillReceiveMessage(m: any) {
                        if (m?.type !== 'request') { return; }
                        if (m.command === 'stackTrace' && !m.arguments?.startFrame) { pending.set(m.seq, m.arguments?.threadId); }
                        if (/^(continue|next|stepIn|stepOut|goto|restart|disconnect|terminate)$/.test(m.command) && stop?.sessionId === session.id) { setStop(undefined); }
                    },
                    onDidSendMessage(m: any) {
                        if (m?.type === 'event' && m.event === 'stopped') { stoppedThread = m.body?.threadId; }
                        if (m?.type === 'event' && /^(continued|terminated|exited)$/.test(m.event) && stop?.sessionId === session.id) { setStop(undefined); }
                        if (m?.type !== 'response' || m.command !== 'stackTrace' || !pending.has(m.request_seq)) { return; }
                        const threadId = pending.get(m.request_seq);
                        pending.delete(m.request_seq);
                        const top = m.body?.stackFrames?.[0];
                        if (m.success && top?.source?.path && (stoppedThread === undefined || threadId === stoppedThread)) {
                            setStop({ sessionId: session.id, frameId: top.id, file: fileKey(top.source.path), line: top.line - 1 });
                        }
                    },
                    onWillStopSession() { if (stop?.sessionId === session.id) { setStop(undefined); } },
                };
            },
        }),

        // the values of the variables of the stopped line, a click changes one
        vscode.languages.registerCodeLensProvider({ language: 'krl', scheme: 'file' }, {
            onDidChangeCodeLenses: lensesChanged.event,
            async provideCodeLenses(document) {
                const at = stop;
                const session = krlSession(at?.sessionId);
                if (!at || !session || fileKey(document.fileName) !== at.file || at.line >= document.lineCount) { return []; }
                const doc = parseKrlDocument(document.fileName, document.getText());
                const names = new Map<string, vscode.Range>();
                for (const ref of doc.refs) {
                    if (ref.line === at.line && (ref.role === 'read' || ref.role === 'write') && !names.has(ref.key)) {
                        names.set(ref.key, new vscode.Range(at.line, ref.start, at.line, ref.end));
                    }
                }
                for (const ref of doc.sysRefs) {
                    if (ref.line !== at.line) { continue; }
                    const expression = Number.isNaN(ref.index) ? ref.name : `${ref.name}[${ref.index}]`;
                    if (!names.has(expression.toLowerCase())) { names.set(expression.toLowerCase(), new vscode.Range(at.line, ref.start, at.line, ref.end)); }
                }
                const lenses: vscode.CodeLens[] = [];
                for (const range of names.values()) {
                    if (lenses.length >= MAX_LENSES) { break; }
                    const text = document.getText(range);
                    const sys = doc.sysRefs.find(r => r.line === at.line && r.start === range.start.character);
                    const expression = sys && !Number.isNaN(sys.index) ? `${sys.name}[${sys.index}]` : text;
                    try {
                        const r = await session.customRequest('evaluate', { expression, frameId: at.frameId, context: 'hover' }) as { result: string; type?: string; variablesReference?: number };
                        // structures and arrays: in the Variables view
                        if (r.variablesReference || /\[/.test(r.type ?? '')) { continue; }
                        const isEnum = r.type !== 'BOOL' && r.result.startsWith('#');
                        const icon = r.type === 'BOOL' ? '$(arrow-swap)' : isEnum ? '$(list-selection)' : '$(edit)';
                        const shown = r.result.length > 30 ? `${r.result.slice(0, 29)}…` : r.result;
                        lenses.push(new vscode.CodeLens(new vscode.Range(at.line, 0, at.line, 0), {
                            title: `${icon} ${expression} = ${shown}`,
                            tooltip: r.type === 'BOOL' ? `Toggle ${expression}` : isEnum ? `Choose a value of ${r.type}` : `Change ${expression}`,
                            command: 'krl.debug.changeValue',
                            arguments: [{ expression, value: r.result, type: r.type }],
                        }));
                    } catch {
                        // not a variable (a routine, a type, ...)
                    }
                }
                return lenses;
            },
        }),

        // CodeLens of the stopped line, or Change Value... in the editor: the access path under the cursor
        vscode.commands.registerCommand('krl.debug.changeValue', async (arg?: { expression: string; value?: string; type?: string }) => {
            const at = stop;
            const session = krlSession(at?.sessionId);
            if (!at || !session) {
                void vscode.window.showInformationMessage('Pause the KRL program to change values.');
                return;
            }
            let expression = arg?.expression;
            if (!expression) {
                const editor = vscode.window.activeTextEditor;
                const range = editor?.document.getWordRangeAtPosition(editor.selection.active, ACCESS_PATH);
                expression = range ? editor!.document.getText(range) : undefined;
                if (!expression) { return; }
            }
            try {
                const current = arg?.value !== undefined ? { result: arg.value, type: arg.type }
                    : await session.customRequest('evaluate', { expression, frameId: at.frameId, context: 'hover' }) as { result: string; type?: string };
                const value = await askValue(session, expression, current.result, current.type);
                if (value === undefined) { return; }
                await session.customRequest('krlAssign', { expression, frameId: at.frameId, value });
                lensesChanged.fire();
            } catch (err) {
                showError(err);
            }
        }),

        // Variables view: toggle a BOOL, pick a literal of an ENUM
        vscode.commands.registerCommand('krl.variables.toggle', (ctx: VariableContext) => setFromView(ctx, /^TRUE$/i.test(ctx?.variable?.value ?? '') ? 'FALSE' : 'TRUE')),
        vscode.commands.registerCommand('krl.variables.setEnum', async (ctx: VariableContext) => {
            const session = krlSession(ctx?.sessionId);
            if (!session || !ctx.variable) { return; }
            try {
                const value = await askValue(session, ctx.variable.name, ctx.variable.value, ctx.variable.type);
                if (value !== undefined) { await setFromView(ctx, value); }
            } catch (err) {
                showError(err);
            }
        }),
    );

    async function setFromView(ctx: VariableContext, value: string): Promise<void> {
        const session = krlSession(ctx?.sessionId);
        const ref = ctx?.container?.variablesReference;
        if (!session || !ctx.variable || ref === undefined) { return; }
        try {
            await session.customRequest('krlSetVariable', { variablesReference: ref, name: ctx.variable.name, value });
            lensesChanged.fire();
        } catch (err) {
            showError(err);
        }
    }
}
