// krlFileAssociation.ts
// Other extensions register .src and .dat, too (RoboDK's Industrial Robots as
// "KUKA", ...), and VS Code gives a file extension to the language registered
// last. KRL files then open in a language without this extension's features:
// F5 reports that no debugger is installed, Format Document that there is no
// formatter. When a KRL file is shown in such a language, this offers to open
// .src, .dat and .sub files as KRL (files.associations in the user settings).

import * as path from 'path';
import * as vscode from 'vscode';

const KRL_FILE = /\.(src|dat|sub)$/i;
/** The header or the first routine of a KRL file, so that other .src / .dat files are left alone */
const KRL_START = /^\s*(&ACCESS|&REL|&PARAM|(GLOBAL\s+)?DEF(FCT|DAT)?\s)/im;
const DONT_ASK = 'krl.fileAssociation.dontAsk';

/** The extension that contributes the language, e.g. "Industrial Robots" for "KUKA" */
function languageOwner(languageId: string): string | undefined {
    const owner = vscode.extensions.all.find(ext =>
        (ext.packageJSON?.contributes?.languages ?? []).some((l: { id?: string }) => l.id === languageId));
    const name: unknown = owner?.packageJSON?.displayName;
    // a localized name is a %placeholder%
    return typeof name === 'string' && !name.startsWith('%') ? name : owner?.id;
}

export function registerKrlFileAssociation(context: vscode.ExtensionContext): void {
    let asked = false;  // once per window

    const check = async (editor: vscode.TextEditor | undefined) => {
        const doc = editor?.document;
        if (!doc || asked || doc.languageId === 'krl' || doc.uri.scheme !== 'file' || !KRL_FILE.test(doc.fileName)) { return; }
        if (context.globalState.get<boolean>(DONT_ASK, false)) { return; }
        // the user chose the language of these files
        const files = vscode.workspace.getConfiguration('files');
        if (Object.keys(files.get<Record<string, string>>('associations', {})).some(pattern => KRL_FILE.test(pattern))) { return; }
        if (!KRL_START.test(doc.getText(new vscode.Range(0, 0, 50, 0)))) { return; }
        asked = true;

        const owner = languageOwner(doc.languageId);
        const openAsKrl = 'Open as KRL';
        const dontAsk = "Don't Ask Again";
        const choice = await vscode.window.showInformationMessage(
            `${path.basename(doc.fileName)} is opened as '${doc.languageId}'${owner ? ` (language of ${owner})` : ''}: `
            + 'the KRL debugger (F5), formatter and checks do not work in it. Open .src, .dat and .sub files as KRL (files.associations)?',
            openAsKrl, dontAsk);
        if (choice === openAsKrl) {
            try {
                const user = files.inspect<Record<string, string>>('associations')?.globalValue ?? {};
                await files.update('associations', { ...user, '*.src': 'krl', '*.dat': 'krl', '*.sub': 'krl' }, vscode.ConfigurationTarget.Global);
                // the association applies to the files opened from now on; switch this one now
                if (!doc.isClosed) { await vscode.languages.setTextDocumentLanguage(doc, 'krl'); }
            } catch (err) {
                void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
            }
        } else if (choice === dontAsk) {
            await context.globalState.update(DONT_ASK, true);
        }
    };

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => void check(editor)));
    void check(vscode.window.activeTextEditor);
}
