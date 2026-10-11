// krlIoView.ts
// "KRL I/O" view in the Run and Debug sidebar: the digital and analog inputs
// and outputs, flags, timers and signals the programs use (and the ones that
// are set), plus system signals like $OV_PRO, $STOPMESS and $PRO_STATE0, live
// while the programs run. Click a Boolean one to toggle it, or set a value:
// inputs can be forced like on OfficeLite. In the editor, "Toggle Input /
// Output" toggles the $IN[n] / $OUT[n] / signal under the cursor.
// Uses the debug adapter's custom `krlIo` request.

import * as vscode from 'vscode';

const STATE_KEY = 'krl.io.pinned';
const REFRESH_MS = 250;
/** `$IN[5]`, `$OUT[12]`, `$FLAG[3]`, or a signal name */
const IO_AT_CURSOR = /\$(IN|OUT|OUT_C|FLAG|CYCFLAG|ANIN|ANOUT|TIMER_STOP)\s*\[\s*\d+\s*\]|\$?[A-Za-z_][\w$]*/;

interface IoEntry { expression: string; value: string; kind: 'bool' | 'number' | 'other'; names: string[]; }
interface IoGroup { name: string; entries: IoEntry[]; }
type Node = { group: IoGroup } | { entry: IoEntry };

class IoProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    groups: IoGroup[] = [];
    private snapshot = '';

    set(groups: IoGroup[]): void {
        const next = JSON.stringify(groups);
        if (next === this.snapshot) { return; }
        this.snapshot = next;
        this.groups = groups;
        this.changed.fire();
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if ('group' in node) {
            const item = new vscode.TreeItem(node.group.name, /^(Digital|Signals|System)/.test(node.group.name)
                ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
            item.id = `group:${node.group.name}`;
            item.description = `${node.group.entries.length}`;
            return item;
        }
        const e = node.entry;
        const item = new vscode.TreeItem(e.expression, vscode.TreeItemCollapsibleState.None);
        item.id = `io:${e.expression}`;
        item.description = `${e.value}${e.names.length > 0 ? `  ${e.names.join(', ')}` : ''}`;
        const on = e.kind === 'bool' && e.value === 'TRUE';
        item.iconPath = e.kind === 'bool'
            ? new vscode.ThemeIcon(on ? 'circle-filled' : 'circle-outline', on ? new vscode.ThemeColor('charts.green') : undefined)
            : new vscode.ThemeIcon(e.kind === 'number' ? 'symbol-number' : 'symbol-enum');
        item.tooltip = `${e.expression} = ${e.value}${e.names.length > 0 ? `\n${e.names.join(', ')}` : ''}\n${e.kind === 'bool' ? 'Click to toggle.' : 'Use the pencil to set a value.'}`;
        item.contextValue = e.kind === 'bool' ? 'krlIo.bool' : 'krlIo.value';
        if (e.kind === 'bool') { item.command = { command: 'krl.io.toggle', title: 'Toggle', arguments: [node] }; }
        return item;
    }

    getChildren(node?: Node): Node[] {
        if (!node) { return this.groups.filter(g => g.entries.length > 0).map(group => ({ group })); }
        return 'group' in node ? node.group.entries.map(entry => ({ entry })) : [];
    }
}

export function registerKrlIoView(context: vscode.ExtensionContext): void {
    const provider = new IoProvider();
    const view = vscode.window.createTreeView('krlIo', { treeDataProvider: provider });
    let pinned: string[] = context.workspaceState.get<string[]>(STATE_KEY, []);

    /** Send a request of the view; `quiet` for the periodic refresh, which must not show errors. */
    const request = async (args: object, quiet = false): Promise<boolean> => {
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== 'krl') {
            if (!quiet) { void vscode.window.showInformationMessage('Start a KRL debug session to see and force inputs and outputs.'); }
            return false;
        }
        try {
            const body = await session.customRequest('krlIo', { extra: pinned, ...args });
            provider.set(Array.isArray(body?.groups) ? body.groups : []);
            return true;
        } catch (err) {
            if (!quiet) { void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err)); }
            return false;
        }
    };

    let busy = false;
    const refresh = async () => {
        if (busy || !view.visible || vscode.debug.activeDebugSession?.type !== 'krl') { return; }
        busy = true;
        try { await request({ action: 'list' }, true); } finally { busy = false; }
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    const updateTimer = () => {
        const active = vscode.debug.activeDebugSession?.type === 'krl';
        if (active && !timer) {
            timer = setInterval(() => { void refresh(); }, REFRESH_MS);
        } else if (!active && timer) {
            clearInterval(timer);
            timer = undefined;
            provider.set([]);
        }
    };

    const entryOf = (arg: unknown): IoEntry | undefined =>
        arg && typeof arg === 'object' && 'entry' in arg ? (arg as { entry: IoEntry }).entry : undefined;

    context.subscriptions.push(
        view,
        { dispose: () => { if (timer) { clearInterval(timer); } } },
        vscode.debug.onDidStartDebugSession(updateTimer),
        vscode.debug.onDidTerminateDebugSession(updateTimer),
        vscode.debug.onDidChangeActiveDebugSession(updateTimer),

        vscode.commands.registerCommand('krl.io.toggle', async (arg: unknown) => {
            const e = entryOf(arg);
            if (e) { await request({ action: 'toggle', expression: e.expression }); }
        }),
        vscode.commands.registerCommand('krl.io.set', async (arg: unknown) => {
            const e = entryOf(arg);
            if (!e) { return; }
            const value = await vscode.window.showInputBox({ prompt: `New value of ${e.expression}`, value: e.value });
            if (value !== undefined) { await request({ action: 'set', expression: e.expression, value }); }
        }),
        vscode.commands.registerCommand('krl.io.add', async () => {
            const text = await vscode.window.showInputBox({
                prompt: 'Inputs / outputs to show: $IN[17], $OUT[1..16], $FLAG[3]',
                placeHolder: '$IN[1..16]',
            });
            if (!text) { return; }
            for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
                const range = /^\$(\w+)\[(\d+)\s*\.\.\s*(\d+)\]$/i.exec(part);
                const items = range
                    ? Array.from({ length: Math.min(256, Math.max(0, Number(range[3]) - Number(range[2]) + 1)) }, (_, i) => `$${range[1].toUpperCase()}[${Number(range[2]) + i}]`)
                    : [part.toUpperCase()];
                for (const item of items) { if (!pinned.includes(item)) { pinned.push(item); } }
            }
            await context.workspaceState.update(STATE_KEY, pinned);
            await request({ action: 'list' });
        }),
        vscode.commands.registerCommand('krl.io.clearPinned', async () => {
            pinned = [];
            await context.workspaceState.update(STATE_KEY, pinned);
            await request({ action: 'list' });
        }),
        // right-click in a KRL editor while debugging: toggle the input / output / signal under the cursor
        vscode.commands.registerCommand('krl.io.toggleAtCursor', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            let text = editor.document.getText(editor.selection).trim();
            if (!text) {
                const range = editor.document.getWordRangeAtPosition(editor.selection.active, IO_AT_CURSOR);
                text = range ? editor.document.getText(range) : '';
            }
            if (!text) { return; }
            if (await request({ action: 'toggle', expression: text })) {
                vscode.window.setStatusBarMessage(`KRL: ${text} toggled`, 2500);
            }
        }),
    );
    updateTimer();
}
