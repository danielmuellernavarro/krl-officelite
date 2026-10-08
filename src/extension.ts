"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
import * as vscode from "vscode";
import cp = require("child_process");
import os = require("os");
import path = require("path");
import { registerKrlDebugAdapter } from "./debugger/krlDebug";


const fullRange = (doc: { validateRange: (arg0: vscode.Range) => any; }) => doc.validateRange(new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE));
const MODE: vscode.DocumentFilter = { language: 'krl', scheme: 'file' };


class KrlFormatter {
    machine_os: NodeJS.Platform;
    constructor() {
        this.machine_os = os.platform();
    }

    formatDocument(document: vscode.TextDocument, range: vscode.Range): Thenable<vscode.TextEdit[]> {
        return new Promise((resolve, reject) => {
            this.format(document, range).then((res) => {
                return resolve(res);
            });
        });
    }

    format(document: vscode.TextDocument, range: { start: { line: number; }; end: { line: number; }; }): Thenable<vscode.TextEdit[]> {
        return new Promise((resolve, reject) => {
            const cfg = vscode.workspace.getConfiguration('krl-officelite');

            // python executable (explicitly configurable)
            let python: string = cfg.get<string>('pythonPath') || '';
            if (!python) {
                python = this.machine_os === 'win32' ? 'python' : 'python3';
            }

            // location of the python formatter
            let formatter: string = cfg.get<string>('formatterPath') || '';
            if (!formatter) {
                formatter = path.join(__dirname, 'formatter', 'main.py').replace(/[\\/]out[\\/]/, path.sep);
            }

            // build argv (no shell quoting headache for paths with spaces)
            const args: string[] = [
                formatter,
                `--filename=${document.fileName}`,
                `--indentWidth=${cfg.get<number>('indentwidth', 2)}`,
                `--separateBeforeBlocks=${cfg.get<boolean>('separateBeforeBlocks', false)}`,
                `--separateAfterBlocks=${cfg.get<boolean>('separateAfterBlocks', false)}`,
                `--indentAfterFunction=${cfg.get<boolean>('indentAfterFunction', true)}`,
                `--indentAfterMainFunction=${cfg.get<boolean>('indentAfterMainFunction', false)}`,
                `--startLine=${range.start.line + 1}`,
                `--endLine=${range.end.line + 1}`,
            ];

            cp.execFile(python, args, { encoding: 'utf8', timeout: 30000 }, (err: any, stdout: string, stderr: string) => {
                if (stdout !== '') {
                    const toreplace = document.validateRange(new vscode.Range(range.start.line, 0, range.end.line + 1, 0));
                    const edit = [vscode.TextEdit.replace(toreplace, stdout)];
                    if (stderr !== '') {
                        vscode.window.showWarningMessage('formatting warning:\n' + stderr);
                    }
                    return resolve(edit);
                }
                vscode.window.showErrorMessage('formatting failed:\n' + (stderr || String(err)));
                return resolve([]);
            });
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.languages.setLanguageConfiguration("krl", {
        indentationRules: {
            decreaseIndentPattern: new RegExp(/^\s*(ENDFOR|ELSE|ENDIF|ENDLOOP|UNTIL.*|ENDWHILE|ENDSWITCH|DEFAULT.*|ENDFCT|END)\s*(;.*)?$/, "i"),
            increaseIndentPattern: new RegExp(/^\s*(FOR.*|IF.*|ELSE|LOOP|REPEAT|WHILE.*|SWITCH.*|CASE.*|DEFAULT.*|DEFFCT.*)\s*(;.*)?$/, "i"),
        },
    });

    const formatter = new KrlDocumentRangeFormatter();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(MODE, formatter));

    registerKrlDebugAdapter(context);
}

class KrlDocumentRangeFormatter implements vscode.DocumentFormattingEditProvider {
    formatter: KrlFormatter = new KrlFormatter;
    contructor() {
        this.formatter = new KrlFormatter();
    }
    provideDocumentFormattingEdits(document: vscode.TextDocument, _options: vscode.FormattingOptions, _token: vscode.CancellationToken) {
        return this.formatter.formatDocument(document, fullRange(document));
    }
}

