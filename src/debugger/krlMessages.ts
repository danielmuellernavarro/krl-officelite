// krlMessages.ts
// "KRL Messages" view, like the message window of the smartPAD: the messages
// the programs set with SET_KRLMSG and the dialogs of SET_KRLDLG. Acknowledgement
// messages and dialogs also pop up. A program waiting in EXISTS_KRLMSG /
// EXISTS_KRLDLG continues once its message is acknowledged or its dialog answered.
// The list comes with the debug adapter's custom `krlMessages` event; actions use
// its `krlMessage` request.

import * as vscode from 'vscode';

interface KrlMessage {
    handle: number;
    type: 'notify' | 'state' | 'quit' | 'waiting' | 'dialog';
    module: string;
    nr: number;
    text: string;
    softkeys: { nr: number; label: string }[];
    thread: string;
}

const ICONS: Record<KrlMessage['type'], string> = {
    quit: 'warning', notify: 'info', state: 'pulse', waiting: 'watch', dialog: 'question',
};
const TYPE_NAMES: Record<KrlMessage['type'], string> = {
    quit: 'Acknowledgement message', notify: 'Notification message', state: 'Status message',
    waiting: 'Wait message', dialog: 'Dialog',
};

class MessagesProvider implements vscode.TreeDataProvider<KrlMessage> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    messages: KrlMessage[] = [];

    set(messages: KrlMessage[]): void {
        this.messages = messages;
        this.changed.fire();
    }

    getTreeItem(m: KrlMessage): vscode.TreeItem {
        const item = new vscode.TreeItem(m.text || '(no text)');
        item.description = `${m.module} ${m.nr}`.trim();
        item.tooltip = `${TYPE_NAMES[m.type]} from ${m.thread}: ${m.text}`
            + (m.softkeys.length > 0 ? `\nSoftkeys: ${m.softkeys.map(k => k.label).join(', ')}` : '');
        item.iconPath = new vscode.ThemeIcon(ICONS[m.type]);
        // drives the inline buttons: Acknowledge (quit, notify, waiting) or Answer (dialog)
        item.contextValue = `krlMessage.${m.type}`;
        if (m.type === 'dialog') {
            item.command = { command: 'krl.messages.answer', title: 'Answer', arguments: [m] };
        }
        return item;
    }

    getChildren(element?: KrlMessage): KrlMessage[] {
        return element ? [] : this.messages;
    }
}

export function registerKrlMessages(context: vscode.ExtensionContext): void {
    const provider = new MessagesProvider();
    const view = vscode.window.createTreeView('krlMessages', { treeDataProvider: provider });
    /** handles that already popped up */
    const shown = new Set<number>();

    const send = async (args: object): Promise<void> => {
        const session = vscode.debug.activeDebugSession;
        if (session?.type !== 'krl') { return; }
        try {
            const body = await session.customRequest('krlMessage', args);
            if (Array.isArray(body?.messages)) { provider.set(body.messages); }
        } catch (err) {
            void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
        }
    };
    const acknowledge = (m: KrlMessage | undefined) => m && send({ action: 'acknowledge', handle: m.handle });
    const answer = async (m: KrlMessage | undefined) => {
        if (!m || m.type !== 'dialog') { return; }
        const picked = await vscode.window.showQuickPick(
            m.softkeys.map(k => ({ label: k.label, description: `softkey ${k.nr}`, nr: k.nr })),
            { placeHolder: m.text },
        );
        if (picked) { await send({ action: 'answer', handle: m.handle, softkey: picked.nr }); }
    };

    /** acknowledgement messages and dialogs stop the program: pop them up */
    const popUp = (m: KrlMessage) => {
        const head = `${m.module} ${m.nr}`.trim();
        const text = head ? `${head}: ${m.text}` : m.text;
        if (m.type === 'quit') {
            void vscode.window.showWarningMessage(text, 'Acknowledge').then(choice => {
                if (choice && provider.messages.some(x => x.handle === m.handle)) { void acknowledge(m); }
            });
        } else if (m.type === 'dialog') {
            const items = m.softkeys.map(k => ({ title: k.label, nr: k.nr }));
            void vscode.window.showInformationMessage(text, ...items).then(choice => {
                if (choice && provider.messages.some(x => x.handle === m.handle)) {
                    void send({ action: 'answer', handle: m.handle, softkey: choice.nr });
                }
            });
        }
    };

    context.subscriptions.push(
        view,
        vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
            if (e.session.type !== 'krl' || e.event !== 'krlMessages') { return; }
            const messages: KrlMessage[] = Array.isArray(e.body?.messages) ? e.body.messages : [];
            provider.set(messages);
            for (const m of messages) {
                if (!shown.has(m.handle)) { shown.add(m.handle); popUp(m); }
            }
        }),
        vscode.debug.onDidTerminateDebugSession(s => {
            if (s.type === 'krl') { provider.set([]); shown.clear(); }
        }),
        vscode.commands.registerCommand('krl.messages.acknowledge', (m: KrlMessage) => acknowledge(m)),
        vscode.commands.registerCommand('krl.messages.answer', (m: KrlMessage) => answer(m)),
        vscode.commands.registerCommand('krl.messages.acknowledgeAll', () => send({ action: 'acknowledgeAll' })),
    );
}
