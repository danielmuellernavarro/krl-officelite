"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
import * as vscode from "vscode";
import cp = require("child_process");
import os = require("os");


var channel = null;
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
            let filename = "--filename=" + "\"" + document.fileName + "\""

            let py = vscode.workspace.getConfiguration('krl-officelite')['pythonPath'];
            if (typeof py === 'undefined' && this.machine_os == 'win32') {
                py = 'python';
            }

            let formatter = vscode.workspace.getConfiguration('krl-officelite')['formatterPath'];
            if (typeof formatter === 'undefined' || formatter == '') {
                formatter = '"' + __dirname + '/formatter/main.py"';
                formatter = formatter.replace('out/', '');
            }

            let indentwidth = vscode.workspace.getConfiguration('krl-officelite')['indentwidth'];
            indentwidth === undefined ? indentwidth = "2" : "";
            indentwidth = "--indentWidth=" + indentwidth;

            let separateBeforeBlocks = vscode.workspace.getConfiguration('krl-officelite')['separateBeforeBlocks'];
            separateBeforeBlocks === undefined ? separateBeforeBlocks = false : "";
            separateBeforeBlocks = "--separateBeforeBlocks=" + separateBeforeBlocks;

            let separateAfterBlocks = vscode.workspace.getConfiguration('krl-officelite')['separateAfterBlocks'];
            separateAfterBlocks === undefined ? separateAfterBlocks = false : "";
            separateAfterBlocks = "--separateAfterBlocks=" + separateAfterBlocks;

            let indentAfterFunction = vscode.workspace.getConfiguration('krl-officelite')['indentAfterFunction'];
            indentAfterFunction === undefined ? indentAfterFunction = true : "";
            indentAfterFunction = "--indentAfterFunction=" + indentAfterFunction;
            
            let indentAfterMainFunction = vscode.workspace.getConfiguration('krl-officelite')['indentAfterMainFunction'];
            indentAfterMainFunction === undefined ? indentAfterMainFunction = false : "";
            indentAfterMainFunction = "--indentAfterMainFunction=" + indentAfterMainFunction;            

            let startLine = "--startLine=" + (range.start.line + 1);
            let endLine = "--endLine=" + (range.end.line + 1);

            let command = py + " " + formatter + " " + filename + " " +
                indentwidth + " " + separateBeforeBlocks + " " + separateAfterBlocks + " " +
                indentAfterFunction + " " + indentAfterMainFunction + " " + 
                startLine + " " + endLine
            
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
            decreaseIndentPattern: new RegExp(/^\s*(ENDFOR|ELSE|ENDIF|ENDLOOP|UNTIL.*|ENDWHILE|ENDSWITCH|DEFAULT.*)\s*(;.*)?$/, "i"),
            increaseIndentPattern: new RegExp(/^\s*(FOR.*|IF.*|ELSE|LOOP|REPEAT|WHILE.*|SWITCH.*|CASE.*|DEFAULT.*)\s*(;.*)?$/, "i"),
        },
    });

    const formatter = new KrlDocumentRangeFormatter();
    context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(MODE, formatter));
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

