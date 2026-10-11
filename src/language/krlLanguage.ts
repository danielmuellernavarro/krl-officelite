// krlLanguage.ts
// Registers the KRL language features with VS Code: completion, signature
// help, inlay hints, hovers, go to definition, references, outline, folding,
// diagnostics with quick fixes, ;FOLD commands, the collapsing of inline form
// folds, and the expression the debugger evaluates for a hover. The logic
// lives in the pure modules next to this one; this file adapts it.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KrlProject, ProjectHost, findKrlFiles } from './krlProject';
import { KrlDocument, KrlIssue, routineAt, isInstruction } from './krlSyntax';
import { computeDiagnostics, DiagnosticSettings, DEFAULT_DIAGNOSTIC_SETTINGS, inferDeclarationType, defaultInitialValue } from './krlDiagnostics';
import { computeCompletions, CompletionKind } from './krlCompletion';
import { KEYWORDS, systemReference } from './krlCatalog';
import {
    computeSignatureHelp, computeInlayHints, computeHover, findDefinition, findReferences, documentSymbols, foldingRanges, SymbolNode, referenceAt,
} from './krlFeatures';

const SELECTOR: vscode.DocumentSelector = { language: 'krl', scheme: 'file' };
/** the read-only reference of what the controller provides (.src: shown as KRL) */
const REFERENCE_SCHEME = 'krl-system';
const REFERENCE_URI = vscode.Uri.parse(`${REFERENCE_SCHEME}:/KRL System Variables and Functions.src`);
const reference = systemReference();
const CONFIG = 'krl-officelite';
/** an access path: nCount, $OUT[3], XP1.X, WZ_GREIFER[1].SENSOR.ZU */
const EXPRESSION = /\$?[A-Za-z_][\w$]*(\s*\[[^\]]*\])*(\s*\.\s*[A-Za-z_][\w$]*(\s*\[[^\]]*\])*)*/g;

/** Text of open editors, else the files on disk; versions change with every edit or file change. */
class EditorHost implements ProjectHost {
    private open = new Map<string, vscode.TextDocument>();
    private disk = new Map<string, number>();

    track(doc: vscode.TextDocument): void {
        if (doc.uri.scheme === 'file') { this.open.set(doc.uri.fsPath.toLowerCase(), doc); }
    }

    untrack(doc: vscode.TextDocument): void {
        this.open.delete(doc.uri.fsPath.toLowerCase());
    }

    fileChanged(filePath: string): void {
        const key = path.resolve(filePath).toLowerCase();
        this.disk.set(key, (this.disk.get(key) ?? 0) + 1);
    }

    readFile(filePath: string): string | undefined {
        const doc = this.open.get(path.resolve(filePath).toLowerCase());
        if (doc) { return doc.getText(); }
        try { return fs.readFileSync(filePath, 'latin1'); } catch { return undefined; }
    }

    version(filePath: string): string {
        const key = path.resolve(filePath).toLowerCase();
        const doc = this.open.get(key);
        return doc ? `e${doc.version}` : `d${this.disk.get(key) ?? 0}`;
    }

    workspaceFolders(): string[] {
        return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    }
}

function settings(): DiagnosticSettings {
    const cfg = vscode.workspace.getConfiguration(CONFIG);
    return {
        maxCartesianVelocity: cfg.get<number>('safety.maxCartesianVelocity', DEFAULT_DIAGNOSTIC_SETTINGS.maxCartesianVelocity),
        ioCount: cfg.get<number>('io.count', DEFAULT_DIAGNOSTIC_SETTINGS.ioCount),
        undeclared: cfg.get<boolean>('diagnostics.undeclared', true),
        unused: cfg.get<boolean>('diagnostics.unused', true),
    };
}

const SEVERITY: Record<KrlIssue['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};

const COMPLETION_KIND: Record<CompletionKind, vscode.CompletionItemKind> = {
    variable: vscode.CompletionItemKind.Variable,
    constant: vscode.CompletionItemKind.Constant,
    signal: vscode.CompletionItemKind.Event,
    parameter: vscode.CompletionItemKind.Variable,
    field: vscode.CompletionItemKind.Field,
    enumMember: vscode.CompletionItemKind.EnumMember,
    function: vscode.CompletionItemKind.Function,
    procedure: vscode.CompletionItemKind.Method,
    keyword: vscode.CompletionItemKind.Keyword,
    snippet: vscode.CompletionItemKind.Snippet,
    type: vscode.CompletionItemKind.Struct,
    label: vscode.CompletionItemKind.Reference,
    value: vscode.CompletionItemKind.Value,
    system: vscode.CompletionItemKind.Variable,
};

const SYMBOL_KIND: Record<SymbolNode['kind'], vscode.SymbolKind> = {
    function: vscode.SymbolKind.Function,
    method: vscode.SymbolKind.Method,
    module: vscode.SymbolKind.Module,
    variable: vscode.SymbolKind.Variable,
    constant: vscode.SymbolKind.Constant,
    struct: vscode.SymbolKind.Struct,
    enum: vscode.SymbolKind.Enum,
    event: vscode.SymbolKind.Event,
    namespace: vscode.SymbolKind.Namespace,
    parameter: vscode.SymbolKind.TypeParameter,
};

export function registerKrlLanguage(context: vscode.ExtensionContext): void {
    const host = new EditorHost();
    const project = new KrlProject(host);
    const diagnostics = vscode.languages.createDiagnosticCollection('krl');
    const lastIssues = new Map<string, KrlIssue[]>();
    const hintsChanged = new vscode.EventEmitter<void>();
    const isKrl = (doc: vscode.TextDocument) => doc.languageId === 'krl' && doc.uri.scheme === 'file';
    const cfg = () => vscode.workspace.getConfiguration(CONFIG);

    // ---- diagnostics -------------------------------------------------------------

    // Problems are kept per file path; the URI is the open document's, else the one the workspace search found
    const keyOf = (filePath: string) => filePath.toLowerCase();
    const uris = new Map<string, vscode.Uri>();
    /** KRL files of the workspace (not machine data), checked even when they are not open */
    const workspaceFiles = new Set<string>();
    const openFiles = new Set<string>();
    const isWorkspaceFile = (uri: vscode.Uri) => uri.scheme === 'file' && /\.(src|sub|dat)$/i.test(uri.fsPath) && !/[\\/](mada|node_modules|\.git|out)[\\/]/i.test(uri.fsPath);
    const allFiles = () => cfg().get<boolean>('diagnostics.allFiles', true);

    const useUri = (uri: vscode.Uri) => {
        const key = keyOf(uri.fsPath);
        const old = uris.get(key);
        if (old && old.toString() !== uri.toString()) { diagnostics.delete(old); }
        uris.set(key, uri);
    };

    const diagnosePath = (filePath: string) => {
        const key = keyOf(filePath);
        const uri = uris.get(key) ?? vscode.Uri.file(filePath);
        if (!cfg().get<boolean>('diagnostics.enabled', true) || (!openFiles.has(key) && !allFiles())) {
            diagnostics.delete(uri);
            lastIssues.delete(key);
            return;
        }
        try {
            const issues = computeDiagnostics(project, filePath, settings());
            lastIssues.set(key, issues);
            diagnostics.set(uri, issues.map(i => {
                const d = new vscode.Diagnostic(new vscode.Range(i.line, i.start, i.line, Math.max(i.end, i.start + 1)), i.message, SEVERITY[i.severity]);
                d.source = 'krl';
                d.code = i.code;
                if (i.unnecessary) { d.tags = [vscode.DiagnosticTag.Unnecessary]; }
                return d;
            }));
        } catch (err) {
            console.error('[krl] diagnostics failed', err);
        }
    };
    const diagnose = (doc: vscode.TextDocument) => { if (isKrl(doc)) { diagnosePath(doc.uri.fsPath); } };

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (doc: vscode.TextDocument, delay = 300) => {
        const key = doc.uri.toString();
        const pending = timers.get(key);
        if (pending) { clearTimeout(pending); }
        timers.set(key, setTimeout(() => { timers.delete(key); diagnose(doc); }, delay));
    };

    /** Check every KRL file of the workspace, a few at a time; a newer pass cancels an older one. */
    let pass = 0;
    const checkWorkspace = async () => {
        const mine = ++pass;
        let slice = Date.now();
        /** projects parsed in this pass: each one once, not once per file */
        const warm = new Set<string>();
        for (const key of [...workspaceFiles]) {
            if (mine !== pass) { return; }
            if (openFiles.has(key)) { continue; }
            const uri = uris.get(key);
            if (!uri) { continue; }
            const root = project.projectInfo(uri.fsPath).root.toLowerCase();
            if (allFiles() && !warm.has(root)) {
                warm.add(root);
                await project.warmUp(uri.fsPath);
                if (mine !== pass) { return; }
            }
            diagnosePath(uri.fsPath);
            if (Date.now() - slice > 15) {
                await new Promise<void>(r => setImmediate(r));
                slice = Date.now();
            }
        }
    };

    /** a change can affect the module's other file (.src <-> .dat) and, for data lists, everything */
    let allTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAll = (delay = 500) => {
        if (allTimer) { clearTimeout(allTimer); }
        allTimer = setTimeout(() => {
            allTimer = undefined;
            for (const doc of vscode.workspace.textDocuments) { diagnose(doc); }
            hintsChanged.fire();
            void checkWorkspace();
        }, delay);
    };

    const opened = (doc: vscode.TextDocument) => {
        if (!isKrl(doc)) { return; }
        host.track(doc);
        useUri(doc.uri);
        openFiles.add(keyOf(doc.uri.fsPath));
        // parse the project in the background, then check the file with all globals known
        void project.warmUp(doc.uri.fsPath).then(() => schedule(doc, 0));
    };
    vscode.workspace.textDocuments.forEach(opened);

    // all KRL files of the workspace folders, so that their errors show in Problems without opening them
    const discover = () => {
        workspaceFiles.clear();
        for (const folder of host.workspaceFolders()) {
            for (const file of findKrlFiles(folder)) {
                const uri = vscode.Uri.file(file);
                if (!isWorkspaceFile(uri)) { continue; }
                const key = keyOf(file);
                workspaceFiles.add(key);
                if (!uris.has(key)) { uris.set(key, uri); }
            }
        }
        void checkWorkspace();
    };
    setTimeout(discover, 0);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{src,SRC,dat,DAT,sub,SUB}');
    const onDisk = (uri: vscode.Uri, change: 'changed' | 'created' | 'deleted') => {
        host.fileChanged(uri.fsPath);
        const key = keyOf(uri.fsPath);
        if (change === 'changed') { project.forget(uri.fsPath); } else { project.filesChanged(); }
        if (change === 'created' && isWorkspaceFile(uri)) {
            workspaceFiles.add(key);
            if (!uris.has(key)) { uris.set(key, uri); }
        }
        if (change === 'deleted') {
            workspaceFiles.delete(key);
            diagnostics.delete(uris.get(key) ?? uri);
            lastIssues.delete(key);
            uris.delete(key);
        }
        scheduleAll(800);
    };

    context.subscriptions.push(
        diagnostics, hintsChanged, watcher,
        { dispose: () => { timers.forEach(t => clearTimeout(t)); if (allTimer) { clearTimeout(allTimer); } pass++; } },
        vscode.workspace.onDidOpenTextDocument(opened),
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (!isKrl(doc)) { return; }
            host.untrack(doc);
            const key = keyOf(doc.uri.fsPath);
            openFiles.delete(key);
            // a file of the workspace keeps its problems (of the saved text); others lose them
            if (workspaceFiles.has(key) && allFiles()) {
                diagnosePath(doc.uri.fsPath);
            } else {
                diagnostics.delete(doc.uri);
                lastIssues.delete(key);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (!isKrl(e.document) || e.contentChanges.length === 0) { return; }
            schedule(e.document);
            // a changed data list (or routine signature) changes what other files see
            if (/\.dat$/i.test(e.document.uri.fsPath)) { scheduleAll(); }
        }),
        vscode.workspace.onDidSaveTextDocument(doc => { if (isKrl(doc)) { scheduleAll(); } }),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CONFIG)) { scheduleAll(0); } }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { project.filesChanged(); discover(); }),
        watcher.onDidChange(uri => onDisk(uri, 'changed')),
        watcher.onDidCreate(uri => onDisk(uri, 'created')),
        watcher.onDidDelete(uri => onDisk(uri, 'deleted')),
    );

    // ---- providers ---------------------------------------------------------------

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(SELECTOR, {
            provideCompletionItems(doc, position, _token, ctx) {
                const result = computeCompletions(project, doc.uri.fsPath, position.line, position.character, ctx.triggerCharacter);
                if (!result) { return undefined; }
                const range = new vscode.Range(position.line, result.replaceStart, position.line, position.character);
                return result.items.map(c => {
                    // the group (runtime, data list, global, system) right-aligned next to the name
                    const item = new vscode.CompletionItem(c.description ? { label: c.label, description: c.description } : c.label, COMPLETION_KIND[c.kind]);
                    item.range = range;
                    item.detail = c.detail;
                    if (c.documentation) { item.documentation = new vscode.MarkdownString(c.documentation); }
                    if (c.insertText !== undefined) { item.insertText = c.snippet ? new vscode.SnippetString(c.insertText) : c.insertText; }
                    if (c.sortText) { item.sortText = c.sortText; }
                    if (c.preselect) { item.preselect = true; }
                    if (c.filterText) { item.filterText = c.filterText; }
                    if (c.createPoint) {
                        item.command = { command: 'krl.dat.declare', title: 'Declare point', arguments: [c.createPoint.datPath, c.createPoint.name, 'E6POS'] };
                    } else if (c.signatureHelp) {
                        item.command = { command: 'editor.action.triggerParameterHints', title: 'Parameter hints' };
                    }
                    return item;
                });
            },
        }, '$', '#', '.', ' '),

        vscode.languages.registerSignatureHelpProvider(SELECTOR, {
            provideSignatureHelp(doc, position) {
                const r = computeSignatureHelp(project, doc.uri.fsPath, position.line, position.character);
                if (!r) { return undefined; }
                const sig = new vscode.SignatureInformation(r.signature.label, r.signature.documentation ? new vscode.MarkdownString(r.signature.documentation) : undefined);
                sig.parameters = r.signature.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation ? new vscode.MarkdownString(p.documentation) : undefined));
                const help = new vscode.SignatureHelp();
                help.signatures = [sig];
                help.activeSignature = 0;
                help.activeParameter = r.activeParameter;
                return help;
            },
        }, { triggerCharacters: ['(', ',', ' '], retriggerCharacters: [',', ' ', '='] }),

        vscode.languages.registerInlayHintsProvider(SELECTOR, {
            onDidChangeInlayHints: hintsChanged.event,
            provideInlayHints(doc, range) {
                const options = {
                    motionParameters: cfg().get<boolean>('inlayHints.motionParameters', true),
                    parameterNames: cfg().get<boolean>('inlayHints.parameterNames', true),
                };
                if (!options.motionParameters && !options.parameterNames) { return []; }
                return computeInlayHints(project, doc.uri.fsPath, range.start.line, range.end.line, options).map(h => {
                    const hint = new vscode.InlayHint(new vscode.Position(h.line, h.character), h.label,
                        h.kind === 'parameter' ? vscode.InlayHintKind.Parameter : vscode.InlayHintKind.Type);
                    if (h.tooltip) { hint.tooltip = h.tooltip; }
                    if (h.kind === 'parameter') { hint.paddingRight = true; } else { hint.paddingLeft = true; }
                    return hint;
                });
            },
        }),

        vscode.languages.registerHoverProvider(SELECTOR, {
            provideHover(doc, position) {
                const h = computeHover(project, doc.uri.fsPath, position.line, position.character);
                return h ? new vscode.Hover(new vscode.MarkdownString(h.markdown), new vscode.Range(h.range.line, h.range.start, h.range.line, h.range.end)) : undefined;
            },
        }),

        // the reference of system variables, standard functions and predefined types: a read-only KRL document
        vscode.workspace.registerTextDocumentContentProvider(REFERENCE_SCHEME, { provideTextDocumentContent: () => reference.text }),

        vscode.languages.registerDefinitionProvider(SELECTOR, {
            provideDefinition(doc, position) {
                const loc = findDefinition(project, doc.uri.fsPath, position.line, position.character);
                if (loc) { return new vscode.Location(vscode.Uri.file(loc.path), new vscode.Range(loc.line, loc.start, loc.line, loc.end)); }
                // what no program declares: its entry in the reference
                const key = referenceAt(project, doc.uri.fsPath, position.line, position.character);
                const line = key !== null ? reference.lineOf.get(key) : undefined;
                if (line !== undefined) {
                    const text = reference.text.split('\n')[line];
                    const name = key!.replace(/^\w+:#?/, '');
                    const m = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'i').exec(text);
                    const at = m ? m.index : 0;
                    return new vscode.Location(REFERENCE_URI, new vscode.Range(line, at, line, at + name.length));
                }
                // without $config.dat the globals of the robot are unknown: say so instead of just "no definition"
                const word = doc.getWordRangeAtPosition(position);
                if (word && !project.projectInfo(doc.uri.fsPath).configDat) {
                    vscode.window.setStatusBarMessage(`KRL: ${doc.getText(word)} is not declared in the project. It may be a global of $config.dat, `
                        + 'which was not found (expected in KRC/R1/System).', 8000);
                }
                return undefined;
            },
        }),

        vscode.languages.registerReferenceProvider(SELECTOR, {
            provideReferences(doc, position, ctx) {
                return findReferences(project, doc.uri.fsPath, position.line, position.character, ctx.includeDeclaration)
                    .map(l => new vscode.Location(vscode.Uri.file(l.path), new vscode.Range(l.line, l.start, l.line, l.end)));
            },
        }),

        vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
            provideDocumentSymbols(doc) {
                const krlDoc = project.document(doc.uri.fsPath);
                if (!krlDoc) { return []; }
                const convert = (n: SymbolNode): vscode.DocumentSymbol => {
                    const endLine = Math.min(n.endLine, doc.lineCount - 1);
                    const full = new vscode.Range(n.line, 0, endLine, doc.lineAt(endLine).text.length);
                    const sel = new vscode.Range(n.selection.line, n.selection.start, n.selection.line, n.selection.end);
                    const s = new vscode.DocumentSymbol(n.name, n.detail, SYMBOL_KIND[n.kind], full, full.contains(sel) ? sel : full);
                    s.children = n.children.map(convert);
                    return s;
                };
                return documentSymbols(krlDoc).map(convert);
            },
        }),

        vscode.languages.registerFoldingRangeProvider(SELECTOR, {
            provideFoldingRanges(doc) {
                const krlDoc = project.document(doc.uri.fsPath);
                return krlDoc ? foldingRanges(krlDoc).map(r => new vscode.FoldingRange(r.start, r.end, r.kind === 'region' ? vscode.FoldingRangeKind.Region : undefined)) : [];
            },
        }),

        vscode.languages.registerCodeActionsProvider(SELECTOR, {
            provideCodeActions(doc, range) {
                const issues = (lastIssues.get(keyOf(doc.uri.fsPath)) ?? []).filter(i =>
                    i.line >= range.start.line && i.line <= range.end.line);
                return issues.flatMap(i => quickFixes(project, doc, i));
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),

        // the debugger evaluates the whole access path under the mouse: $POS_ACT, XP1.X, $IN[5]
        vscode.languages.registerEvaluatableExpressionProvider(SELECTOR, {
            provideEvaluatableExpression(doc, position) {
                const line = doc.lineAt(position.line).text;
                for (const m of line.matchAll(EXPRESSION)) {
                    const start = m.index ?? 0;
                    const end = start + m[0].length;
                    if (position.character < start || position.character > end) { continue; }
                    // up to the end of the member under the mouse (and its index)
                    const rest = line.slice(position.character, end);
                    const cut = /^[\w$]*(\s*\[[^\]]*\])*/.exec(rest)![0].length;
                    const exprEnd = position.character + cut;
                    const text = line.slice(start, exprEnd).trim();
                    if (!text || KEYWORDS.has(text.toLowerCase())) { return undefined; }
                    return new vscode.EvaluatableExpression(new vscode.Range(position.line, start, position.line, exprEnd), text);
                }
                return undefined;
            },
        }),
    );

    // ---- commands ----------------------------------------------------------------

    context.subscriptions.push(
        // declare a variable or point in a data list (created if missing)
        vscode.commands.registerCommand('krl.dat.declare', async (datPath: string, name: string, type: string) => {
            const edit = new vscode.WorkspaceEdit();
            addDatDeclaration(project, edit, datPath, name, type);
            await vscode.workspace.applyEdit(edit);
        }),
        vscode.commands.registerCommand('krl.fold.wrapSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'krl') { return; }
            const name = await vscode.window.showInputBox({ prompt: 'Name of the fold', value: 'name' });
            if (name === undefined) { return; }
            const doc = editor.document;
            const sel = editor.selection;
            const first = sel.start.line;
            // a selection ending at the start of a line does not include that line
            const last = sel.end.character === 0 && sel.end.line > first ? sel.end.line - 1 : sel.end.line;
            const indent = /^\s*/.exec(doc.lineAt(first).text)![0];
            await editor.edit(b => {
                if (last === doc.lineCount - 1) {
                    b.insert(doc.lineAt(last).range.end, `\n${indent};ENDFOLD`);
                } else {
                    b.insert(new vscode.Position(last + 1, 0), `${indent};ENDFOLD\n`);
                }
                b.insert(new vscode.Position(first, 0), `${indent};FOLD ${name}\n`);
            });
        }),
        vscode.commands.registerCommand('krl.fold.collapseInlineForms', () => collapseFolds(project, vscode.window.activeTextEditor, 'inlineForms')),
        vscode.commands.registerCommand('krl.fold.collapseAll', () => collapseFolds(project, vscode.window.activeTextEditor, 'all')),
    );

    // ---- inline forms: collapsed on first view, their parameters dimmed ----------

    const collapsedOnce = new Set<string>();
    const autoCollapse = (editor: vscode.TextEditor | undefined) => {
        if (!editor || !isKrl(editor.document)) { return; }
        const key = editor.document.uri.toString();
        if (collapsedOnce.has(key)) { return; }
        collapsedOnce.add(key);
        const mode = cfg().get<string>('folding.autoCollapse', 'inlineForms');
        if (mode === 'inlineForms' || mode === 'all') { void collapseFolds(project, editor, mode); }
    };
    const dimmed = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });
    const dim = (editor: vscode.TextEditor) => {
        if (!isKrl(editor.document)) { return; }
        const krlDoc = cfg().get<boolean>('folding.dimInlineFormParameters', true) ? project.document(editor.document.uri.fsPath) : undefined;
        const ranges = (krlDoc?.folds ?? []).filter(f => f.inlineForm && f.metaStart >= 0)
            .map(f => new vscode.Range(f.line, f.metaStart, f.line, krlDoc!.lines[f.line].text.length));
        editor.setDecorations(dimmed, ranges);
    };
    vscode.window.visibleTextEditors.forEach(dim);
    autoCollapse(vscode.window.activeTextEditor);
    context.subscriptions.push(
        dimmed,
        vscode.window.onDidChangeActiveTextEditor(autoCollapse),
        vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(dim)),
        vscode.workspace.onDidChangeTextDocument(e => {
            vscode.window.visibleTextEditors.filter(ed => ed.document === e.document).forEach(dim);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => collapsedOnce.delete(doc.uri.toString())),
    );
}

/** Fold the ;FOLD regions of an editor: the inline forms only, or all. */
async function collapseFolds(project: KrlProject, editor: vscode.TextEditor | undefined, which: 'inlineForms' | 'all'): Promise<void> {
    if (!editor || editor.document.languageId !== 'krl') { return; }
    const krlDoc = project.document(editor.document.uri.fsPath);
    const lines = (krlDoc?.folds ?? []).filter(f => f.endLine > f.line && (which === 'all' || f.inlineForm)).map(f => f.line);
    if (lines.length === 0) { return; }
    if (vscode.window.activeTextEditor !== editor) { await vscode.window.showTextDocument(editor.document, editor.viewColumn); }
    // innermost first, so nested folds are collapsed, too
    await vscode.commands.executeCommand('editor.fold', { selectionLines: lines.reverse(), levels: 1 });
}

// ---------------------------------------------------------------------------
// quick fixes

function quickFixes(project: KrlProject, doc: vscode.TextDocument, issue: KrlIssue): vscode.CodeAction[] {
    const filePath = doc.uri.fsPath;
    const krlDoc = project.document(filePath);
    if (!krlDoc) { return []; }
    const actions: vscode.CodeAction[] = [];
    const action = (title: string, edit: vscode.WorkspaceEdit, preferred = false) => {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.edit = edit;
        a.isPreferred = preferred;
        a.diagnostics = [];
        actions.push(a);
    };
    const data = issue.data ?? {};
    switch (issue.code) {
        case 'undeclaredPoint': case 'undeclared': {
            const name = String(data.name);
            const datPath = project.companionDatPath(filePath);
            const datName = path.basename(datPath);
            const types = issue.code === 'undeclaredPoint'
                ? (data.type === 'E6AXIS' ? ['E6AXIS', 'E6POS'] : /^\s*S?PTP\b/i.test(krlDoc.lines[issue.line].code) ? ['E6POS', 'E6AXIS'] : ['E6POS'])
                : [inferDeclarationType(project, filePath, issue.line, name)];
            types.forEach((type, i) => {
                if (!/\.dat$/i.test(filePath) || datPath.toLowerCase() === filePath.toLowerCase()) {
                    const edit = new vscode.WorkspaceEdit();
                    addDatDeclaration(project, edit, datPath, name, type);
                    action(`Declare ${type} ${name} in ${datName}`, edit, i === 0);
                }
            });
            const routine = routineAt(krlDoc, issue.line);
            if (routine && issue.code === 'undeclared' && !/\.dat$/i.test(filePath)) {
                const edit = new vscode.WorkspaceEdit();
                const { line, indent } = localDeclarationPlace(krlDoc, routine.line);
                edit.insert(doc.uri, new vscode.Position(line, 0), `${indent}DECL ${types[0]} ${name}${types[0] === 'CHAR' ? '[80]' : ''}\n`);
                action(`Declare ${types[0]} ${name} in ${routine.name}`, edit);
            }
            break;
        }
        case 'unclosedBlock': case 'unclosedRoutine': case 'unclosedFold': {
            const insertLine = Math.min(Number(data.beforeLine), doc.lineCount);
            const opener = krlDoc.lines[issue.line].text;
            const indent = /^\s*/.exec(opener)![0];
            const edit = new vscode.WorkspaceEdit();
            const text = `${indent}${data.insert}`;
            if (insertLine >= doc.lineCount) {
                edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, `\n${text}`);
            } else {
                edit.insert(doc.uri, new vscode.Position(insertLine, 0), `${text}\n`);
            }
            action(`Insert ${data.insert}`, edit, true);
            break;
        }
        case 'missingThen': {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(issue.line, Number(data.insertAt)), String(data.insert));
            action('Insert THEN', edit, true);
            break;
        }
        // '=' to compare, '!=', a comparison as statement, a misspelled keyword: replace the token
        case 'compareAssign': case 'notEqual': case 'compareStatement': case 'unknownStatement': {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(issue.line, issue.start, issue.line, issue.end), String(data.replace));
            action(`Replace with ${data.replace}`, edit, true);
            break;
        }
        // a missing closing bracket or quote goes to the end of the statement
        case 'missingClose': case 'unterminatedString': {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(issue.line, krlDoc.lines[issue.line].code.trimEnd().length), String(data.insert));
            action(`Insert ${data.insert}`, edit, true);
            break;
        }
        case 'missingCallParens': {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(doc.uri, new vscode.Position(issue.line, issue.end), '()');
            action('Call it: insert ()', edit, true);
            break;
        }
        case 'unused': {
            // only a declaration of a single name can be removed as a whole line
            const decls = krlDoc.decls.filter(d => d.line === issue.line);
            if (decls.length === 1) {
                const edit = new vscode.WorkspaceEdit();
                edit.delete(doc.uri, doc.lineAt(issue.line).rangeIncludingLineBreak);
                action(`Remove the declaration of ${data.name}`, edit);
            }
            break;
        }
        case 'moduleName': {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(issue.line, issue.start, issue.line, issue.end), String(data.name));
            action(`Rename to ${data.name}`, edit, true);
            break;
        }
        default: break;
    }
    return actions;
}

/** Where a new local declaration goes: after the declarations of the routine, before its first instruction. */
function localDeclarationPlace(doc: KrlDocument, routineLine: number): { line: number; indent: string } {
    let line = routineLine + 1;
    let indent = '';
    for (let l = routineLine + 1; l < doc.lines.length; l++) {
        const L = doc.lines[l];
        if (L.kind === 'blank') { continue; }
        if (isInstruction(L.kind) || L.kind === 'end' || L.kind === 'endfct') {
            if (!indent) { indent = /^\s*/.exec(L.text)![0]; }
            break;
        }
        line = l + 1;
        indent = /^\s*/.exec(L.text)![0];
    }
    return { line, indent };
}

/** Add `DECL <type> <name>=<value>` before ENDDAT of a data list; create the data list when missing. */
function addDatDeclaration(project: KrlProject, edit: vscode.WorkspaceEdit, datPath: string, name: string, type: string): void {
    const init = defaultInitialValue(type);
    const declaration = `DECL ${type} ${name}${type === 'CHAR' ? '[80]' : ''}${init ? '=' + init : ''}`;
    const uri = vscode.Uri.file(datPath);
    const dat = fs.existsSync(datPath) ? project.document(datPath) : undefined;
    if (!dat) {
        const module = path.basename(datPath).replace(/\.[^.]+$/, '');
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), `DEFDAT ${module} PUBLIC\n${declaration}\nENDDAT\n`);
        return;
    }
    const endLine = dat.defdat && dat.defdat.endLine >= 0 ? dat.defdat.endLine : dat.lines.length;
    edit.insert(uri, new vscode.Position(endLine, 0), `${declaration}\n`);
}
