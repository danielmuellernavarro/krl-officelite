// krlRobotView.ts
// "KRL Robot" view in the Run and Debug sidebar: where the simulated robot is
// ($POS_ACT, $AXIS_ACT with units), the active tool and base (TOOL_DATA[n] /
// BASE_DATA[n] with their frame and homogeneous matrix in the tooltip), the
// motion parameters and the two program pointers (main run, advance run), the
// motion the robot executes (velocity, acceleration, progress), the simulation
// override and the robot's characteristics (machine data).
// Refreshes about 4x per second while the programs run.
// Values come from the debug adapter's custom `krlRobot` request.

import * as vscode from 'vscode';
import { matrixMarkdown } from './krlRobotFormat';

const REFRESH_MS = 250;

interface RobotEntry {
    label: string;
    value: string;
    tooltip?: string;
    expression?: string;
    matrix?: number[][];
    contextValue?: string;
    children?: RobotEntry[];
}

class RobotProvider implements vscode.TreeDataProvider<RobotEntry> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    entries: RobotEntry[] = [];
    /** the last state, to redraw only when something changed */
    private snapshot = '';

    set(entries: RobotEntry[]): void {
        const next = JSON.stringify(entries);
        if (next === this.snapshot) { return; }
        this.snapshot = next;
        this.entries = entries;
        this.changed.fire();
    }

    getTreeItem(e: RobotEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(e.label, e.children && e.children.length > 0
            ? (/^(Position|Tool|Base|Program|Motion$)/.test(e.label) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
            : vscode.TreeItemCollapsibleState.None);
        // a stable id keeps the expansion state while the values change
        item.id = `${e.expression ?? ''}|${e.label.replace(/:.*$/, '')}`;
        item.description = e.value;
        const tip = new vscode.MarkdownString(`**${e.label}**${e.expression ? ` \`${e.expression}\`` : ''}\n\n${e.value ? '`' + e.value + '`' : ''}${e.tooltip ? '\n\n' + e.tooltip : ''}`);
        if (e.matrix) { tip.appendMarkdown('\n\nHomogeneous matrix (rotation Rz(A)·Ry(B)·Rx(C), translation in mm):\n\n' + matrixMarkdown(e.matrix)); }
        item.tooltip = tip;
        item.contextValue = e.contextValue ?? (e.expression ? 'krlRobotEntry' : undefined);
        return item;
    }

    getChildren(e?: RobotEntry): RobotEntry[] {
        return e ? e.children ?? [] : this.entries;
    }
}

export function registerKrlRobotView(context: vscode.ExtensionContext): void {
    const provider = new RobotProvider();
    const view = vscode.window.createTreeView('krlRobot', { treeDataProvider: provider });

    let busy = false;
    const refresh = async () => {
        const session = vscode.debug.activeDebugSession;
        if (busy || !view.visible || session?.type !== 'krl') { return; }
        busy = true;
        try {
            const body = await session.customRequest('krlRobot');
            provider.set(Array.isArray(body?.entries) ? body.entries : []);
        } catch {
            // the session ended between two refreshes
        } finally {
            busy = false;
        }
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

    context.subscriptions.push(
        view,
        { dispose: () => { if (timer) { clearInterval(timer); } } },
        vscode.debug.onDidStartDebugSession(updateTimer),
        vscode.debug.onDidTerminateDebugSession(updateTimer),
        vscode.debug.onDidChangeActiveDebugSession(updateTimer),
        vscode.commands.registerCommand('krl.robot.addToLiveWatch', (e: RobotEntry) => {
            if (e?.expression) { void vscode.commands.executeCommand('krl.liveWatch.addVariable', { variable: { name: e.expression, evaluateName: e.expression } }); }
        }),
    );
    updateTimer();
}
