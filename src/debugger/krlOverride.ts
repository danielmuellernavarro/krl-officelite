// krlOverride.ts
// Override and operating mode of the simulated controller, like on the smartPAD:
//   override  0 .. 100 % is the program override $OV_PRO; above it (up to 10000 %)
//             the whole simulation runs faster than real time
//   mode      T1, T2, AUT or EX ($MODE_OP); changed only while the program is paused
// Shown in the debug toolbar next to play / pause / stop (- / value / + and a mode
// badge: icons per value, picked by the context keys krl.overrideIcon / krl.mode),
// in the status bar and in the KRL Robot view. Values come from and go to the
// debug adapter's custom requests `krlOverride` / `krlMode`; its `krlState` event
// reports changes (also $OV_PRO written by the program).

import * as vscode from 'vscode';
import { formatOverride, MIN_OVERRIDE, MAX_SIMULATION_OVERRIDE } from './krlRuntime';
import { KrlMode, KRL_MODES } from './krlMotion';

/** steps of the + / - buttons: like the override keys of the smartPAD up to 100 %, then on to 10000 % */
export const OVERRIDE_STEPS = [0, 1, 3, 5, 10, 20, 30, 50, 75, 100, 200, 500, 1000, 2000, 5000, 10000];

/** The next step up (+1) or down (-1) from `current`. */
export function nextOverride(current: number, direction: 1 | -1): number {
    if (direction > 0) { return OVERRIDE_STEPS.find(s => s > current + 1e-9) ?? OVERRIDE_STEPS[OVERRIDE_STEPS.length - 1]; }
    return [...OVERRIDE_STEPS].reverse().find(s => s < current - 1e-9) ?? OVERRIDE_STEPS[0];
}

/** An override typed by the user ("250", "250 %", "2,5"), null when it is not a number in range. */
export function parseOverride(text: string): number | null {
    const n = Number(text.trim().replace(/\s*%$/, '').replace(',', '.'));
    return text.trim() !== '' && Number.isFinite(n) && n >= MIN_OVERRIDE && n <= MAX_SIMULATION_OVERRIDE ? n : null;
}

function describeOverride(pct: number): string {
    if (pct === 0) { return 'the robot stands'; }
    if (pct < 100) { return '$OV_PRO: the motions are slower, like on the robot'; }
    if (pct === 100) { return 'like the robot'; }
    return `the simulation runs ${Number((pct / 100).toFixed(1))}× faster than the robot`;
}

const MODE_TEXT: Record<KrlMode, string> = {
    T1: 'Manual reduced velocity',
    T2: 'Manual high velocity (programmed velocity)',
    AUT: 'Automatic',
    EX: 'Automatic external (started by the PLC)',
};

interface KrlState {
    value: number;
    ovPro: number;
    speed: number | null;
    mode: KrlMode;
    modeText: string;
}

export function registerKrlOverride(context: vscode.ExtensionContext): void {
    const overrideItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 41);
    overrideItem.command = 'krl.simulation.setOverride';
    const modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    modeItem.command = 'krl.simulation.setMode';
    let state: KrlState | null = null;

    const krlSession = () => {
        const session = vscode.debug.activeDebugSession;
        return session?.type === 'krl' ? session : undefined;
    };
    const show = () => {
        const active = !!krlSession() && state !== null;
        // the debug toolbar shows the icon of the value (an exact step, else the generic one)
        void vscode.commands.executeCommand('setContext', 'krl.overrideIcon',
            active && state ? (OVERRIDE_STEPS.includes(state.value) ? String(state.value) : 'other') : '');
        void vscode.commands.executeCommand('setContext', 'krl.mode', active && state ? state.mode : '');
        if (!active || !state) {
            overrideItem.hide();
            modeItem.hide();
            return;
        }
        overrideItem.text = `$(dashboard) ${formatOverride(state.value)} %`;
        overrideItem.tooltip = `KRL override ${formatOverride(state.value)} %: ${describeOverride(state.value)}. Click to change (also - / + in the debug toolbar).`;
        modeItem.text = `$(key) ${state.mode === 'EX' ? 'EXT' : state.mode}`;
        modeItem.tooltip = `KRL operating mode ${state.modeText}. Click to change it (while the program is paused).`;
        overrideItem.show();
        modeItem.show();
    };
    const query = async () => {
        const session = krlSession();
        state = null;
        if (session) {
            try {
                state = await session.customRequest('krlOverride');
            } catch {
                // not launched yet: the adapter sends a krlState event once the program is loaded
            }
        }
        show();
    };
    const request = async (command: string, args: object): Promise<string | null> => {
        const session = krlSession();
        if (!session) {
            void vscode.window.showInformationMessage(
                'Override and operating mode apply to a running KRL debug session. New sessions start with the settings "krl-officelite.simulation.override" and "krl-officelite.simulation.mode".');
            return 'no session';
        }
        try {
            state = await session.customRequest(command, args);
            show();
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    };
    const setOverride = async (value: number) => {
        const error = await request('krlOverride', { value });
        if (error && error !== 'no session') { void vscode.window.showWarningMessage(`Cannot change the override: ${error}`); }
    };
    const pickOverride = async () => {
        const now = state?.value ?? 100;
        const presets = [10000, 5000, 1000, 500, 200, 100, 75, 50, 30, 10, 5, 1, 0];
        const picks: (vscode.QuickPickItem & { value: number })[] = presets.map(v => ({
            label: `${v} %`, description: `${describeOverride(v)}${v === now ? '  (current)' : ''}`, value: v,
        }));
        picks.push({ label: 'Other value...', description: `${MIN_OVERRIDE} .. ${MAX_SIMULATION_OVERRIDE} %`, value: -1 });
        const pick = await vscode.window.showQuickPick(picks, {
            placeHolder: `Override, now ${formatOverride(now)} %: up to 100 % like on the robot ($OV_PRO), above it the simulation runs faster`,
        });
        if (!pick) { return; }
        let value = pick.value;
        if (value < 0) {
            const text = await vscode.window.showInputBox({
                prompt: `Override in % (${MIN_OVERRIDE} .. ${MAX_SIMULATION_OVERRIDE}; 100 = like the robot)`,
                value: formatOverride(now),
                validateInput: t => (parseOverride(t) === null ? `Enter a number from ${MIN_OVERRIDE} to ${MAX_SIMULATION_OVERRIDE}` : undefined),
            });
            const parsed = text === undefined ? null : parseOverride(text);
            if (parsed === null) { return; }
            value = parsed;
        }
        await setOverride(value);
    };
    const setMode = async (mode: KrlMode) => {
        let error = await request('krlMode', { mode });
        if (!error || error === 'no session') { return; }
        // like on the robot: the key switch only works with the program stopped
        const choice = await vscode.window.showWarningMessage(
            `The operating mode can only be changed while the program is stopped, like on the robot. Pause it and switch to ${mode}?`, 'Pause and Switch');
        if (choice !== 'Pause and Switch') { return; }
        await vscode.commands.executeCommand('workbench.action.debug.pause');
        for (let i = 0; i < 20 && error; i++) {
            await new Promise(r => setTimeout(r, 100));
            error = await request('krlMode', { mode });
        }
        if (error) { void vscode.window.showWarningMessage(`Cannot change the operating mode: ${error}`); }
    };
    const pickMode = async (preset?: unknown) => {
        if (typeof preset === 'string' && KRL_MODES.includes(preset.toUpperCase() as KrlMode)) {
            return setMode(preset.toUpperCase() as KrlMode);
        }
        const now = state?.mode;
        const pick = await vscode.window.showQuickPick(KRL_MODES.map(m => ({
            label: m === 'EX' ? 'EXT' : m, description: `${MODE_TEXT[m]}${m === now ? '  (current)' : ''}`, mode: m,
        })), { placeHolder: `Operating mode ($MODE_OP), now ${now ?? '?'}: changes while the program is paused, like the key switch of the smartPAD` });
        if (pick) { await setMode(pick.mode); }
    };

    context.subscriptions.push(
        overrideItem,
        modeItem,
        vscode.commands.registerCommand('krl.simulation.setOverride', async (arg?: unknown) => {
            if (typeof arg === 'number') { return setOverride(arg); }
            return pickOverride();
        }),
        vscode.commands.registerCommand('krl.simulation.increaseOverride', () => setOverride(nextOverride(state?.value ?? 100, 1))),
        vscode.commands.registerCommand('krl.simulation.decreaseOverride', () => setOverride(nextOverride(state?.value ?? 100, -1))),
        vscode.commands.registerCommand('krl.simulation.setMode', (arg?: unknown) => pickMode(arg)),
        // the value and the badge in the debug toolbar: one command per icon, all open the pickers
        ...[...OVERRIDE_STEPS.map(String), 'other'].map(step =>
            vscode.commands.registerCommand(`krl.simulation.override.${step}`, () => pickOverride())),
        ...KRL_MODES.map(m => vscode.commands.registerCommand(`krl.simulation.mode.${m}`, () => pickMode())),
        vscode.debug.onDidChangeActiveDebugSession(() => { void query(); }),
        vscode.debug.onDidTerminateDebugSession(() => { void query(); }),
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
            if (e.event === 'krlState' && e.session === vscode.debug.activeDebugSession && typeof e.body?.value === 'number') {
                state = e.body as KrlState;
                show();
            }
        }),
    );
    void query();
}
