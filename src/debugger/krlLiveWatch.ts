// krlLiveWatch.ts
// "KRL Live Watch" view in the Run and Debug sidebar. Shows watched
// expressions and refreshes them while the robot and submit programs keep
// running; the built-in Watch view only updates while the program is paused.
// Values come from the debug adapter's custom `krlLiveWatch` request.

import * as vscode from 'vscode';

const STATE_KEY = 'krl.liveWatch.expressions';
const REFRESH_MS = 250;
/** a name with optional indices and members: nCount, $OUT[3], WZ_GREIFER[1].SENSOR.ZU */
const KRL_EXPRESSION = /\$?[A-Za-z_][\w$]*(\s*\[[^\]]*\])?(\.[A-Za-z_][\w$]*(\s*\[[^\]]*\])?)*/;

interface WatchValue { expression: string; value: string; type: string; }

class LiveWatchProvider implements vscode.TreeDataProvider<string> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private values = new Map<string, WatchValue>();
    expressions: string[];

    constructor(private readonly state: vscode.Memento) {
        this.expressions = state.get<string[]>(STATE_KEY, []);
    }

    getTreeItem(expression: string): vscode.TreeItem {
        const item = new vscode.TreeItem(expression);
        const v = this.values.get(expression);
        item.description = v?.value ?? '';
        item.tooltip = v ? `${expression} = ${v.value}${v.type ? `  (${v.type})` : ''}` : expression;
        item.contextValue = 'krlLiveWatchExpression';
        return item;
    }

    getChildren(element?: string): string[] {
        return element ? [] : this.expressions;
    }

    add(expression: string): void {
        const text = expression.trim();
        if (!text || this.expressions.some(e => e.toLowerCase() === text.toLowerCase())) { return; }
        this.expressions = [...this.expressions, text];
        this.save();
    }

    remove(expression: string): void {
        this.expressions = this.expressions.filter(e => e !== expression);
        this.values.delete(expression);
        this.save();
    }

    removeAll(): void {
        this.expressions = [];
        this.values.clear();
        this.save();
    }

    /** Store new values; redraws only when one of them changed. */
    setValues(values: WatchValue[]): void {
        let dirty = false;
        for (const v of values) {
            const old = this.values.get(v.expression);
            if (!old || old.value !== v.value || old.type !== v.type) {
                this.values.set(v.expression, v);
                dirty = true;
            }
        }
        if (dirty) { this.changed.fire(); }
    }

    clearValues(): void {
        if (this.values.size === 0) { return; }
        this.values.clear();
        this.changed.fire();
    }

    private save(): void {
        void this.state.update(STATE_KEY, this.expressions);
        this.changed.fire();
    }
}

export function registerKrlLiveWatch(context: vscode.ExtensionContext): void {
    const provider = new LiveWatchProvider(context.workspaceState);
    const view = vscode.window.createTreeView('krlLiveWatch', { treeDataProvider: provider });

    let busy = false;
    const refresh = async () => {
        const session = vscode.debug.activeDebugSession;
        if (busy || !view.visible || provider.expressions.length === 0 || session?.type !== 'krl') { return; }
        busy = true;
        try {
            const body = await session.customRequest('krlLiveWatch', { expressions: provider.expressions });
            provider.setValues(Array.isArray(body?.values) ? body.values : []);
        } catch {
            // the session ended between two refreshes
        } finally {
            busy = false;
        }
    };

    // poll only while a KRL debug session is active
    let timer: ReturnType<typeof setInterval> | undefined;
    const updateTimer = () => {
        const active = vscode.debug.activeDebugSession?.type === 'krl';
        if (active && !timer) {
            timer = setInterval(() => { void refresh(); }, REFRESH_MS);
        } else if (!active && timer) {
            clearInterval(timer);
            timer = undefined;
            provider.clearValues();
        }
    };

    const addAndRefresh = (expression: string | undefined) => {
        if (!expression) { return; }
        provider.add(expression);
        void refresh();
    };

    context.subscriptions.push(
        view,
        { dispose: () => { if (timer) { clearInterval(timer); } } },
        vscode.debug.onDidStartDebugSession(updateTimer),
        vscode.debug.onDidTerminateDebugSession(updateTimer),
        vscode.debug.onDidChangeActiveDebugSession(updateTimer),

        vscode.commands.registerCommand('krl.liveWatch.add', async () => {
            addAndRefresh(await vscode.window.showInputBox({
                prompt: 'Expression to watch while the program runs',
                placeHolder: 'nCount, $OUT[3], WZ_GREIFER[1].SENSOR.ZU',
            }));
        }),
        // right-click in the Variables view
        vscode.commands.registerCommand('krl.liveWatch.addVariable', (arg: any) => {
            addAndRefresh(arg?.variable?.evaluateName ?? arg?.variable?.name);
        }),
        // right-click in a KRL editor: the selection, else the name under the cursor
        vscode.commands.registerCommand('krl.liveWatch.addSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            let text = editor.document.getText(editor.selection).trim();
            if (!text) {
                const range = editor.document.getWordRangeAtPosition(editor.selection.active, KRL_EXPRESSION);
                text = range ? editor.document.getText(range) : '';
            }
            addAndRefresh(text);
        }),
        vscode.commands.registerCommand('krl.liveWatch.remove', (expression: string) => provider.remove(expression)),
        vscode.commands.registerCommand('krl.liveWatch.removeAll', () => provider.removeAll()),
    );
    updateTimer();
}
