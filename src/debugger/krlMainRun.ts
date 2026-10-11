// krlMainRun.ts
// Marks both program pointers of the robot interpreter in the editor, like the
// block pointers of the smartPAD: the motion the robot executes (main run,
// with the motions planned after it) and the statement the interpreter
// executes next (advance run), which runs up to $ADVANCE motions ahead. Both
// get a gutter icon; while the session is paused, VS Code's own arrow marks the
// advance run, so only its label is shown then.
// Positions come from the debug adapter's custom `krlMainRun` request.

import * as vscode from 'vscode';

const REFRESH_MS = 250;

interface MainRun { threadId: number; file: string; line: number; text: string; planned: number; motions?: { file: string; line: number }[]; }
interface AdvanceRun { threadId: number; file: string; line: number; ahead: number; }

export function registerKrlMainRun(context: vscode.ExtensionContext): void {
    const icon = (name: string) => context.asAbsolutePath ? vscode.Uri.file(context.asAbsolutePath(`images/${name}`)) : undefined;
    const mainRunDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        gutterIconPath: icon('mainrun.svg'),
        gutterIconSize: 'contain',
        after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    });
    // isWholeLine puts the labels after the end of the line
    const plannedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        gutterIconPath: icon('planned.svg'),
        gutterIconSize: 'contain',
        after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    });
    const advanceDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        gutterIconPath: icon('advancerun.svg'),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    });
    // while paused the advance run has VS Code's arrow: a label without gutter icon
    const advanceLabelDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    });
    let mainRun: MainRun[] = [];
    let advanceRun: AdvanceRun[] = [];
    let paused = false;

    const render = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            const file = editor.document.uri.fsPath.toLowerCase();
            const here = <T extends { file: string }>(items: T[]) => items.filter(m => m.file.toLowerCase() === file);
            editor.setDecorations(mainRunDecoration, here(mainRun).map(m => ({
                range: new vscode.Range(m.line, 0, m.line, 0),
                hoverMessage: `Main run: the robot executes \`${m.text}\`. The advance run (the interpreter) is up to $ADVANCE motions ahead.`,
                renderOptions: { after: { contentText: `◀ robot (main run)${m.planned > 0 ? `, ${m.planned} more planned` : ''}` } },
            })));
            // the advance run's own marker wins on the motion it waits at
            const advanceLines = new Set(here(advanceRun).map(a => a.line));
            const planned = mainRun.flatMap(m => (m.motions ?? []).map((p, i) => ({ ...p, n: i + 1 })));
            editor.setDecorations(plannedDecoration, here(planned).filter(p => !advanceLines.has(p.line)).map(p => ({
                range: new vscode.Range(p.line, 0, p.line, 0),
                hoverMessage: `Planned by the advance run: the robot executes this motion after ${p.n} more.`,
                renderOptions: { after: { contentText: `◇ planned (${p.n})` } },
            })));
            const advance = here(advanceRun).map(a => ({
                range: new vscode.Range(a.line, 0, a.line, 0),
                hoverMessage: 'Advance run: the robot interpreter executes this statement next'
                    + (a.ahead > 0 ? `, ${a.ahead} motion(s) ahead of the robot.` : '.'),
                renderOptions: { after: { contentText: `◀ advance run${a.ahead > 0 ? `, ${a.ahead} motion${a.ahead === 1 ? '' : 's'} ahead` : ''}` } },
            }));
            editor.setDecorations(advanceDecoration, paused ? [] : advance);
            editor.setDecorations(advanceLabelDecoration, paused ? advance : []);
        }
    };

    let busy = false;
    const refresh = async () => {
        const session = vscode.debug.activeDebugSession;
        if (busy || session?.type !== 'krl') { return; }
        busy = true;
        try {
            const body = await session.customRequest('krlMainRun');
            const nextMain: MainRun[] = Array.isArray(body?.mainRun) ? body.mainRun : [];
            const nextAdvance: AdvanceRun[] = Array.isArray(body?.advanceRun) ? body.advanceRun : [];
            if (JSON.stringify(nextMain) !== JSON.stringify(mainRun) || JSON.stringify(nextAdvance) !== JSON.stringify(advanceRun)) {
                mainRun = nextMain;
                advanceRun = nextAdvance;
                render();
            }
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
            mainRun = [];
            advanceRun = [];
            paused = false;
            render();
        }
    };

    context.subscriptions.push(
        mainRunDecoration, plannedDecoration, advanceDecoration, advanceLabelDecoration,
        { dispose: () => { if (timer) { clearInterval(timer); } } },
        vscode.window.onDidChangeVisibleTextEditors(render),
        vscode.debug.onDidStartDebugSession(updateTimer),
        vscode.debug.onDidTerminateDebugSession(updateTimer),
        vscode.debug.onDidChangeActiveDebugSession(updateTimer),
    );
    // paused or running: from the events the adapter sends
    if (vscode.debug.registerDebugAdapterTrackerFactory) {
        context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('krl', {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (m: { type?: string; event?: string }) => {
                    if (m.type !== 'event') { return; }
                    if (m.event === 'stopped' || m.event === 'continued') {
                        paused = m.event === 'stopped';
                        render();
                    }
                },
            }),
        }));
    }
    updateTimer();
}
