"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
import * as vscode from "vscode";
import cp = require("child_process");
import stream = require('stream');
import os = require("os");
import { encode } from "querystring";
import { stdin } from "process";

var channel = null;
const fullRange = (doc: { validateRange: (arg0: vscode.Range) => any; }) => doc.validateRange(new vscode.Range(0, 0, Number.MAX_VALUE, Number.MAX_VALUE));
const MODE: vscode.DocumentFilter = { language: 'krl', scheme: 'file' };


class KrlFormatter {
    machine_os: NodeJS.Platform;
    formatter: string;
    py: string;
    constructor() {
        this.machine_os = os.platform();
        this.py = vscode.workspace.getConfiguration('krl-formatter')['pythonPath'];
        if (typeof this.py === 'undefined' && this.machine_os == 'win32') {
            this.py = 'python';
        }
        this.formatter = vscode.workspace.getConfiguration('krl-formatter')['formatterPath'];
        if (typeof this.formatter === 'undefined') {
            this.formatter = '"' + __dirname + '/formatter/main.py"';
            this.formatter = this.formatter.replace('out/', '');
        }
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
            let filename = "--filename=" + "\"" + document.fileName + "\""

            let indentwidth = vscode.workspace.getConfiguration('krl-formatter')['indentwidth'];
            indentwidth === undefined ? indentwidth = "4" : "";
            indentwidth = "--indentWidth=" + indentwidth;

            let separateBlocks = vscode.workspace.getConfiguration('krl-formatter')['separateBlocks'];
            separateBlocks === undefined ? separateBlocks = true : "";
            separateBlocks = "--separateBlocks=" + separateBlocks;

            let start = "--startLine=" + (range.start.line + 1);
            let end = "--endLine=" + (range.end.line + 1);

            let command = this.py + " " + this.formatter + " " + filename + " " +
                indentwidth + " " + separateBlocks + " " + start + " " + end
            cp.exec(command, (_err: any, stdout: string, stderr: string) => {
                if (stdout != '') {
                    let toreplace = document.validateRange(new vscode.Range(range.start.line, 0, range.end.line + 1, 0));
                    var edit = [vscode.TextEdit.replace(toreplace, stdout)];
                    if (stderr != '') {
                        vscode.window.showWarningMessage('formatting warning:\n' + stderr);
                    }
                    return resolve(edit);
                }
                vscode.window.showErrorMessage('formatting failed:\n' + stderr);
                return resolve([]);
            });
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.languages.setLanguageConfiguration("krl", {
        indentationRules: {
            decreaseIndentPattern: new RegExp(
                /^\s*(ENDFOR|ELSE|ENDIF|ENDLOOP|UNTIL.*|ENDWHILE|ENDSWITCH|CASE.*|DEFAULT.*)\s*(;.*)?$/, "i"),
            increaseIndentPattern: new RegExp(
                /^\s*(FOR.*|IF.*|ELSE|LOOP|REPEAT|WHILE.*|SWITCH.*|CASE.*|DEFAULT.*)\s*(;.*)?$/, "i"),
        },
    });

    const formatter = new KrlDocumentRangeFormatter();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(MODE, formatter));
    context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(MODE, formatter));
}

class KrlDocumentRangeFormatter implements vscode.DocumentFormattingEditProvider {
    formatter: KrlFormatter = new KrlFormatter;
    contructor() {
        this.formatter = new KrlFormatter();
    }
    provideDocumentFormattingEdits(document: vscode.TextDocument, _options: vscode.FormattingOptions, _token: vscode.CancellationToken) {
        return this.formatter.formatDocument(document, fullRange(document));
    }
    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, _range: vscode.Range, _options: vscode.FormattingOptions, _token: vscode.CancellationToken) {
        const firstLine = document.lineAt(0);
        if (firstLine.text !== '42') {
            return [vscode.TextEdit.insert(firstLine.range.start, '42\n')];
        }
    }
}

