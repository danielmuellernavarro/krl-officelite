// krlVariableSearch.ts
// "Search Variables" window: a quick pick over every variable of the running
// KRL program (all scopes, structure members, elements of small arrays) with
// its value, filtered while typing. The chosen one goes to the KRL Live Watch.
// Values come from the debug adapter's custom `krlVariables` request; while
// typing it searches all variables with the text, so that none is missing
// behind the many members of large data lists.

import * as vscode from 'vscode';

interface SearchEntry { expression: string; value: string; type: string; scope: string; }

interface SearchItem extends vscode.QuickPickItem { expression: string; }

async function searchVariables(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== 'krl') {
        void vscode.window.showInformationMessage('Start a KRL debug session to search its variables.');
        return;
    }
    const pick = vscode.window.createQuickPick<SearchItem>();
    pick.title = 'Search KRL Variables';
    pick.placeholder = 'Type a name or a value; Enter adds the variable to the KRL Live Watch';
    pick.matchOnDescription = true;
    pick.busy = true;
    pick.onDidHide(() => pick.dispose());
    pick.onDidAccept(() => {
        const item = pick.selectedItems[0];
        pick.hide();
        if (item) {
            void vscode.commands.executeCommand('krl.liveWatch.addVariable', { variable: { name: item.expression, evaluateName: item.expression } });
        }
    });
    // the latest request wins: a slower older answer must not replace a newer one
    let requested = 0;
    const load = async (filter: string) => {
        const mine = ++requested;
        pick.busy = true;
        try {
            const body = await session.customRequest('krlVariables', { filter });
            if (mine !== requested) { return; }
            const entries: SearchEntry[] = Array.isArray(body?.variables) ? body.variables : [];
            pick.items = entries.map(e => ({
                label: e.expression,
                description: e.value,
                detail: `${e.scope} · ${e.type}`,
                expression: e.expression,
            }));
        } catch (err) {
            if (mine === requested) { pick.placeholder = `Variables are not available: ${err}`; }
        } finally {
            if (mine === requested) { pick.busy = false; }
        }
    };
    let typing: ReturnType<typeof setTimeout> | undefined;
    pick.onDidChangeValue(value => {
        if (typing) { clearTimeout(typing); }
        typing = setTimeout(() => void load(value), 200);
    });
    pick.onDidHide(() => { if (typing) { clearTimeout(typing); } });
    pick.show();
    await load('');
}

export function registerKrlVariableSearch(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('krl.searchVariables', searchVariables));
}
