"use strict";

import * as vscode from "vscode";
import { registerKrlDebugAdapter } from "./debugger/krlDebug";
import { registerKrlLiveWatch } from "./debugger/krlLiveWatch";
import { registerKrlVariableSearch } from "./debugger/krlVariableSearch";
import { registerKrlInterpreters } from "./debugger/krlInterpreters";
import { registerKrlMainRun } from "./debugger/krlMainRun";
import { registerKrlMessages } from "./debugger/krlMessages";
import { registerKrlRobotView } from "./debugger/krlRobotView";
import { registerKrlIoView } from "./debugger/krlIoView";
import { registerKrlOverride } from "./debugger/krlOverride";
import { registerKrlValueEdit } from "./debugger/krlValueEdit";
import { registerKrlLanguage } from "./language/krlLanguage";
import { registerKrlFileAssociation } from "./language/krlFileAssociation";
import { formatKrlLines, FormatOptions, lineEdits } from "./formatter/krlFormatter";
import { parseKrlDocument } from "./language/krlSyntax";


const MODE: vscode.DocumentFilter = { language: 'krl', scheme: 'file' };

function formatOptions(document: vscode.TextDocument): Partial<FormatOptions> {
    const cfg = vscode.workspace.getConfiguration('krl-officelite', document);
    return {
        indentWidth: cfg.get<number>('indentwidth', 2),
        separateBeforeBlocks: cfg.get<boolean>('separateBeforeBlocks', false),
        separateAfterBlocks: cfg.get<boolean>('separateAfterBlocks', false),
        indentAfterFunction: cfg.get<boolean>('indentAfterFunction', true),
        indentAfterMainFunction: cfg.get<boolean>('indentAfterMainFunction', false),
        isDatFile: /\.dat$/i.test(document.fileName),
    };
}

/** Format whole lines `first` ... `last`; the result replaces them including the last line break. */
function formatLines(document: vscode.TextDocument, first: number, last: number): vscode.TextEdit[] {
    const lines: string[] = [];
    for (let l = first; l <= last; l++) { lines.push(document.lineAt(l).text); }
    const result = formatKrlLines(lines, formatOptions(document));
    if (result.warnings.length > 0) {
        void vscode.window.showWarningMessage(`formatting warning:\n${[...new Set(result.warnings)].join('\n')}`);
    }
    const range = document.validateRange(new vscode.Range(first, 0, last + 1, 0));
    return [vscode.TextEdit.replace(range, result.lines.join('\n') + '\n')];
}

/** Errors in the block structure: formatting would indent the rest of the file wrongly. */
const STRUCTURE_ERRORS = new Set(['unclosedBlock', 'unmatchedClose', 'misplacedBranch', 'unclosedRoutine', 'unmatchedEnd', 'wrongEnd']);

/**
 * Edits of format on save: only the lines that change, so that the cursor and
 * the scroll position stay. A file whose blocks do not match (e.g. while an IF
 * is typed without its ENDIF) is saved as it is.
 */
function formatOnSaveEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const text = document.getText();
    if (parseKrlDocument(document.fileName, text).issues.some(i => STRUCTURE_ERRORS.has(i.code))) {
        vscode.window.setStatusBarMessage('KRL: not formatted on save, the blocks do not match (see Problems)', 5000);
        return [];
    }
    const old = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
    const result = formatKrlLines(old, formatOptions(document));
    if (result.warnings.length > 0) {
        vscode.window.setStatusBarMessage(`KRL: not formatted on save: ${result.warnings[0]}`, 5000);
        return [];
    }
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const last = document.lineCount;
    // the formatted text ends with a line break: its last line is empty
    return lineEdits(old, [...result.lines, '']).map(edit => {
        if (edit.end < last) {
            return vscode.TextEdit.replace(new vscode.Range(edit.start, 0, edit.end, 0), edit.lines.map(l => l + eol).join(''));
        }
        // up to the end of the file: replace from the line break before the first changed line
        const from = edit.start > 0 ? document.lineAt(edit.start - 1).range.end : new vscode.Position(0, 0);
        const to = document.lineAt(last - 1).range.end;
        const lines = edit.start > 0 ? edit.lines.map(l => eol + l).join('') : edit.lines.join(eol);
        return vscode.TextEdit.replace(new vscode.Range(from, to), lines);
    });
}

export function activate(context: vscode.ExtensionContext) {
    vscode.languages.setLanguageConfiguration("krl", {
        indentationRules: {
            decreaseIndentPattern: new RegExp(/^\s*(ENDFOR|ELSE|ENDIF|ENDLOOP|UNTIL.*|ENDWHILE|ENDSWITCH|DEFAULT.*|ENDFCT|END)\s*(;.*)?$/, "i"),
            increaseIndentPattern: new RegExp(/^\s*(FOR.*|IF.*|ELSE|LOOP|REPEAT|WHILE.*|SWITCH.*|CASE.*|DEFAULT.*|DEFFCT.*)\s*(;.*)?$/, "i"),
        },
    });

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(MODE, {
            provideDocumentFormattingEdits: document => formatLines(document, 0, document.lineCount - 1),
        }),
        vscode.languages.registerDocumentRangeFormattingEditProvider(MODE, {
            provideDocumentRangeFormattingEdits: (document, range) =>
                formatLines(document, range.start.line, range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line),
        }),
        // format on save (krl-officelite.formatOnSave): not for auto save after a delay, like VS Code's own
        vscode.workspace.onWillSaveTextDocument(e => {
            const doc = e.document;
            if (doc.languageId !== 'krl' || doc.uri.scheme !== 'file' || e.reason === vscode.TextDocumentSaveReason.AfterDelay) { return; }
            if (!vscode.workspace.getConfiguration('krl-officelite', doc).get<boolean>('formatOnSave', false)) { return; }
            // with editor.formatOnSave VS Code formats the file itself
            if (vscode.workspace.getConfiguration('editor', doc).get<boolean>('formatOnSave', false)) { return; }
            e.waitUntil(Promise.resolve(formatOnSaveEdits(doc)));
        }),
    );

    registerKrlLanguage(context);
    registerKrlFileAssociation(context);
    registerKrlDebugAdapter(context);
    registerKrlLiveWatch(context);
    registerKrlVariableSearch(context);
    registerKrlInterpreters(context);
    registerKrlMainRun(context);
    registerKrlMessages(context);
    registerKrlRobotView(context);
    registerKrlIoView(context);
    registerKrlOverride(context);
    registerKrlValueEdit(context);
}
