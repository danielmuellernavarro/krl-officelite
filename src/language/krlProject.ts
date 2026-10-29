// krlProject.ts
// The KRL files of a robot project and what each file can see. A project is
// the robot root (the folder holding System/$config.dat, e.g. KRC/R1, like
// the debugger uses), else an R1 folder, else the workspace folder. Names are
// resolved like on the controller: the routine's parameters and local
// declarations, the module's data list (.dat with the name of the .src),
// $CONFIG.DAT and the GLOBAL declarations of PUBLIC data lists; routines: the
// routines of the file, the module routines (first DEF of a file) and GLOBAL
// routines of the other files.
// Pure logic (no vscode imports): file access goes through a ProjectHost.

import * as fs from 'fs';
import * as path from 'path';
import {
    KrlDocument, KrlDecl, KrlRoutine, KrlTypeDef, KrlParamDecl, KrlLabel, parseKrlDocument, routineAt,
} from './krlSyntax';
import { catalogStructMembers, systemVariable, systemEnumValues, POSITION_TYPES } from './krlCatalog';
import { StructMember } from '../debugger/krlValue';
import { readKrlFile } from '../debugger/krlWorkspace';

export interface ProjectHost {
    /** text of a file: the open editor's, else the file on disk; undefined if it cannot be read */
    readFile(filePath: string): string | undefined;
    /** changes whenever the text changes (editor version or file time) */
    version(filePath: string): string;
    /** workspace folders: a project never reaches beyond the folder holding the file */
    workspaceFolders(): string[];
}

/** Reads files from disk (KRL files are Latin-1 / Windows-1252). */
export const diskHost: ProjectHost = {
    readFile(filePath) {
        try { return readKrlFile(filePath); } catch { return undefined; }
    },
    version(filePath) {
        try { return String(fs.statSync(filePath).mtimeMs); } catch { return 'missing'; }
    },
    workspaceFolders() { return []; },
};

export type KrlSymbol =
    | { kind: 'decl'; doc: KrlDocument; decl: KrlDecl }
    | { kind: 'param'; doc: KrlDocument; routine: KrlRoutine; param: KrlParamDecl }
    | { kind: 'routine'; doc: KrlDocument; routine: KrlRoutine }
    | { kind: 'type'; doc: KrlDocument; type: KrlTypeDef }
    | { kind: 'label'; doc: KrlDocument; label: KrlLabel };

export interface ProjectInfo {
    root: string;
    /** null when the project has no $config.dat: global names may then be missing */
    configDat: string | null;
}

interface ProjectIndex extends ProjectInfo {
    files: string[];
    /** derived maps, rebuilt when a document changed */
    stale: boolean;
    globals: Map<string, KrlSymbol>;
    routines: Map<string, KrlSymbol>;
    types: Map<string, KrlSymbol>;
    /** every variable, constant and signal declared in the project (data lists and routines), the first per name */
    declarations: Map<string, KrlSymbol>;
    /** every name referenced anywhere in the project */
    referenced: Set<string>;
}

const MAX_FILES = 3000;
const MAX_DEPTH = 8;
const SKIP_DIRS = /^(mada|node_modules|\.git|\.vscode|\.vs|out)$/i;
const KRL_FILE = /\.(src|sub|dat)$/i;

const keyOfPath = (p: string): string => path.resolve(p).toLowerCase();

function isInside(file: string, folder: string): boolean {
    const rel = path.relative(path.resolve(folder), path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listDir(dir: string): fs.Dirent[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function findEntry(dir: string, name: RegExp, wantDir: boolean): string | null {
    const hit = listDir(dir).find(e => name.test(e.name) && (wantDir ? e.isDirectory() : e.isFile()));
    return hit ? path.join(dir, hit.name) : null;
}

/**
 * The project of a file: walk up (not beyond its workspace folder) to the folder
 * holding $config.dat or System/$config.dat; else the nearest R1 / R2 folder;
 * else the workspace folder; else the folder of the file.
 */
export function projectFor(filePath: string, workspaceFolders: string[]): ProjectInfo {
    const file = path.resolve(filePath);
    const folder = workspaceFolders.filter(w => isInside(file, w)).sort((a, b) => b.length - a.length)[0];
    let dir = path.dirname(file);
    let robotFolder: string | null = null;
    for (let depth = 0; depth < 12; depth++) {
        const direct = findEntry(dir, /^\$config\.dat$/i, false);
        if (direct) {
            return { root: /^system$/i.test(path.basename(dir)) ? path.dirname(dir) : dir, configDat: direct };
        }
        const system = findEntry(dir, /^system$/i, true);
        const inSystem = system ? findEntry(system, /^\$config\.dat$/i, false) : null;
        if (inSystem) { return { root: dir, configDat: inSystem }; }
        if (!robotFolder && /^R\d+$/i.test(path.basename(dir))) { robotFolder = dir; }
        const parent = path.dirname(dir);
        if (parent === dir || (folder && path.resolve(dir) === path.resolve(folder))) { break; }
        dir = parent;
    }
    return { root: robotFolder ?? folder ?? path.dirname(file), configDat: null };
}

/** The KRL files below a folder (without machine data, at most 3000). */
export function findKrlFiles(root: string): string[] {
    return collectKrlFiles(root);
}

function collectKrlFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
        for (const e of listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= MAX_FILES) { return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < MAX_DEPTH && !SKIP_DIRS.test(e.name)) { walk(full, depth + 1); }
            } else if (e.isFile() && KRL_FILE.test(e.name)) {
                out.push(full);
            }
        }
    };
    walk(root, 0);
    return out;
}

export class KrlProject {
    private docs = new Map<string, { doc: KrlDocument; version: string }>();
    private projects = new Map<string, ProjectIndex>();
    /** file key -> project root key */
    private rootOfFile = new Map<string, string>();
    /** file names per folder, for finding the .dat / .src of a module */
    private dirCache = new Map<string, string[]>();

    constructor(private readonly host: ProjectHost = diskHost) { }

    // ---------------------------------------------------------------------------
    // documents and projects

    /** The parsed file, re-parsed when its text changed. */
    document(filePath: string): KrlDocument | undefined {
        const key = keyOfPath(filePath);
        const version = this.host.version(filePath);
        const cached = this.docs.get(key);
        if (cached && cached.version === version) { return cached.doc; }
        const text = this.host.readFile(filePath);
        if (text === undefined) {
            this.docs.delete(key);
            return undefined;
        }
        const doc = parseKrlDocument(path.resolve(filePath), text);
        this.docs.set(key, { doc, version });
        const project = this.projects.get(this.rootOfFile.get(key) ?? '');
        if (project) { project.stale = true; }
        return doc;
    }

    /** Forget a file (deleted, or closed so the disk version counts again). */
    forget(filePath: string): void {
        const key = keyOfPath(filePath);
        this.docs.delete(key);
        const project = this.projects.get(this.rootOfFile.get(key) ?? '');
        if (project) { project.stale = true; }
    }

    /** Files were created or deleted below a folder: list them again. */
    filesChanged(): void {
        this.projects.clear();
        this.rootOfFile.clear();
        this.dirCache.clear();
    }

    projectInfo(filePath: string): ProjectInfo {
        const p = this.index(filePath);
        return { root: p.root, configDat: p.configDat };
    }

    /** All KRL files of the project of a file. */
    projectFiles(filePath: string): string[] {
        return this.index(filePath).files;
    }

    private index(filePath: string): ProjectIndex {
        const fileKey = keyOfPath(filePath);
        const known = this.projects.get(this.rootOfFile.get(fileKey) ?? '');
        if (known) { return known; }
        const info = projectFor(filePath, this.host.workspaceFolders());
        const rootKey = keyOfPath(info.root);
        let project = this.projects.get(rootKey);
        if (!project) {
            const files = collectKrlFiles(info.root);
            // $config.dat may be outside of the robot root (and is skipped by the Mada filter otherwise)
            if (info.configDat && !files.some(f => keyOfPath(f) === keyOfPath(info.configDat!))) { files.push(info.configDat); }
            project = {
                ...info, files, stale: true,
                globals: new Map(), routines: new Map(), types: new Map(), declarations: new Map(), referenced: new Set(),
            };
            this.projects.set(rootKey, project);
            for (const f of files) { this.rootOfFile.set(keyOfPath(f), rootKey); }
        }
        if (!project.files.some(f => keyOfPath(f) === fileKey)) {
            project.files.push(path.resolve(filePath));
            project.stale = true;
        }
        this.rootOfFile.set(fileKey, rootKey);
        return project;
    }

    /** Parse every file of the project, yielding now and then so the editor stays responsive. */
    async warmUp(filePath: string, yieldEvery = 15): Promise<void> {
        const project = this.index(filePath);
        let start = Date.now();
        for (const f of project.files) {
            this.document(f);
            if (Date.now() - start > yieldEvery) {
                await new Promise<void>(r => setImmediate(r));
                start = Date.now();
            }
        }
    }

    /**
     * The project-wide maps. They are rebuilt when a file of the project was parsed
     * again: `document()` of a changed editor text or `forget()` of a changed file.
     */
    private build(filePath: string): ProjectIndex {
        const project = this.index(filePath);
        if (!project.stale) { return project; }
        const docs = project.files.map(f => this.document(f)).filter((d): d is KrlDocument => !!d);
        project.globals.clear();
        project.routines.clear();
        project.types.clear();
        project.declarations.clear();
        project.referenced.clear();
        const configKey = project.configDat ? keyOfPath(project.configDat) : '';
        // $config.dat first: its declarations win
        docs.sort((a, b) => (keyOfPath(a.path) === configKey ? -1 : 0) - (keyOfPath(b.path) === configKey ? -1 : 0));
        for (const doc of docs) {
            const isConfig = keyOfPath(doc.path) === configKey || /^\$/.test(path.basename(doc.path));
            const exports = isConfig || (!!doc.defdat?.isPublic);
            for (const d of doc.decls) {
                if ((d.kind === 'var' || d.kind === 'const' || d.kind === 'signal') && !project.declarations.has(d.key)) {
                    project.declarations.set(d.key, { kind: 'decl', doc, decl: d });
                }
                if (d.routine) { continue; }
                if ((isConfig || (exports && d.isGlobal)) && !project.globals.has(d.key)) {
                    project.globals.set(d.key, { kind: 'decl', doc, decl: d });
                }
            }
            for (const t of doc.types) {
                if ((isConfig || (exports && t.isGlobal)) && !project.types.has(t.key)) {
                    project.types.set(t.key, { kind: 'type', doc, type: t });
                }
            }
            for (const r of doc.routines) {
                if ((r.isModuleRoutine || r.isGlobal) && !project.routines.has(r.key)) {
                    project.routines.set(r.key, { kind: 'routine', doc, routine: r });
                }
            }
            for (const ref of doc.refs) { project.referenced.add(ref.key); }
        }
        project.stale = false;
        return project;
    }

    // ---------------------------------------------------------------------------
    // modules

    /** The data list of a module: the .dat next to a .src / .sub with the same name. */
    companionDat(filePath: string): KrlDocument | undefined {
        if (/\.dat$/i.test(filePath)) { return this.document(filePath); }
        const sibling = this.sibling(filePath, /\.dat$/i);
        return sibling ? this.document(sibling) : undefined;
    }

    /** The program of a data list: the .src (or .sub) next to it with the same name. */
    companionSource(datPath: string): KrlDocument | undefined {
        const sibling = this.sibling(datPath, /\.(src|sub)$/i);
        return sibling ? this.document(sibling) : undefined;
    }

    /** Path of the data list a module's points belong in (it may not exist yet). */
    companionDatPath(filePath: string): string {
        return this.sibling(filePath, /\.dat$/i) ?? filePath.replace(/\.[^.\\/]+$/, '.dat');
    }

    private sibling(filePath: string, ext: RegExp): string | null {
        const dir = path.dirname(path.resolve(filePath));
        const dirKey = dir.toLowerCase();
        let names = this.dirCache.get(dirKey);
        if (!names) {
            names = listDir(dir).filter(e => e.isFile()).map(e => e.name);
            this.dirCache.set(dirKey, names);
        }
        const base = path.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
        const hit = names.find(n => ext.test(n) && n.replace(/\.[^.]+$/, '').toLowerCase() === base);
        return hit ? path.join(dir, hit) : null;
    }

    // ---------------------------------------------------------------------------
    // name resolution

    /** A variable, constant, signal or parameter visible at a line of a file. */
    resolveVariable(filePath: string, line: number, name: string): KrlSymbol | undefined {
        const doc = this.document(filePath);
        if (!doc) { return undefined; }
        const key = name.toLowerCase();
        const routine = routineAt(doc, line);
        if (routine) {
            const local = doc.decls.find(d => d.routine === routine && d.key === key && d.kind !== 'struc' && d.kind !== 'enum');
            if (local) { return { kind: 'decl', doc, decl: local }; }
            const param = routine.params.find(p => p.key === key);
            if (param) { return { kind: 'param', doc, routine, param }; }
        }
        // the module's data list (or the data list itself)
        const dat = this.companionDat(filePath);
        const own = dat?.decls.find(d => !d.routine && d.key === key && d.kind !== 'struc' && d.kind !== 'enum' && d.kind !== 'ext');
        if (dat && own) { return { kind: 'decl', doc: dat, decl: own }; }
        // module level declarations in the file itself (IMPORT, data list initializations)
        const moduleLevel = doc.decls.find(d => !d.routine && d.key === key && d.kind !== 'struc' && d.kind !== 'enum' && d.kind !== 'ext');
        if (moduleLevel) { return { kind: 'decl', doc, decl: moduleLevel }; }
        const global = this.build(filePath).globals.get(key);
        return global && global.kind === 'decl' && global.decl.kind !== 'struc' && global.decl.kind !== 'enum' ? global : undefined;
    }

    /**
     * A variable declared somewhere in the project, also where the file cannot see it: in the
     * data list of another module (without GLOBAL in a PUBLIC data list) or in another routine.
     */
    declarationAnywhere(filePath: string, name: string): KrlSymbol | undefined {
        return this.build(filePath).declarations.get(name.toLowerCase());
    }

    /** A routine callable from a file: its own, EXT declarations, module routines and GLOBAL routines. */
    resolveRoutine(filePath: string, name: string): KrlSymbol | undefined {
        const doc = this.document(filePath);
        if (!doc) { return undefined; }
        const key = name.toLowerCase();
        const own = doc.routines.find(r => r.key === key);
        if (own) { return { kind: 'routine', doc, routine: own }; }
        const project = this.build(filePath);
        const global = project.routines.get(key);
        if (global) { return global; }
        return this.extDeclarations(filePath).find(s => s.kind === 'decl' && s.decl.key === key);
    }

    /**
     * EXT declarations a file sees: its own, those of the module's data list and the global ones
     * ($config.dat, GLOBAL in a PUBLIC data list). They declare routines of modules that may not
     * be in the workspace, like H50 or USERSPOT of the technology packages.
     */
    private extDeclarations(filePath: string): KrlSymbol[] {
        const doc = this.document(filePath);
        if (!doc) { return []; }
        const out: KrlSymbol[] = doc.decls.filter(d => d.kind === 'ext').map(d => ({ kind: 'decl', doc, decl: d }));
        const dat = this.companionDat(filePath);
        if (dat && dat !== doc) { for (const d of dat.decls) { if (d.kind === 'ext' && !d.routine) { out.push({ kind: 'decl', doc: dat, decl: d }); } } }
        for (const sym of this.build(filePath).globals.values()) {
            if (sym.kind === 'decl' && sym.decl.kind === 'ext') { out.push(sym); }
        }
        return out;
    }

    /** A STRUC or ENUM type visible in a file. */
    resolveType(filePath: string, name: string): KrlSymbol | undefined {
        const key = name.toLowerCase();
        const doc = this.document(filePath);
        const own = doc?.types.find(t => t.key === key);
        if (doc && own) { return { kind: 'type', doc, type: own }; }
        const dat = this.companionDat(filePath);
        const fromDat = dat?.types.find(t => t.key === key);
        if (dat && fromDat) { return { kind: 'type', doc: dat, type: fromDat }; }
        return this.build(filePath).types.get(key);
    }

    /** A label of the routine containing a line. */
    resolveLabel(filePath: string, line: number, name: string): KrlSymbol | undefined {
        const doc = this.document(filePath);
        if (!doc) { return undefined; }
        const routine = routineAt(doc, line);
        const label = doc.labels.find(l => l.routine === routine && l.key === name.toLowerCase());
        return label ? { kind: 'label', doc, label } : undefined;
    }

    /** Whether any file of the project refers to a name. */
    isReferenced(filePath: string, key: string): boolean {
        return this.build(filePath).referenced.has(key);
    }

    /** Variables visible at a line: locals and parameters first, then the data list, then globals. */
    visibleVariables(filePath: string, line: number): { symbol: KrlSymbol; scope: 'local' | 'param' | 'module' | 'global' }[] {
        const doc = this.document(filePath);
        if (!doc) { return []; }
        const out: { symbol: KrlSymbol; scope: 'local' | 'param' | 'module' | 'global' }[] = [];
        const seen = new Set<string>();
        const add = (key: string, symbol: KrlSymbol, scope: 'local' | 'param' | 'module' | 'global') => {
            if (seen.has(key)) { return; }
            seen.add(key);
            out.push({ symbol, scope });
        };
        const isVariable = (d: KrlDecl) => d.kind === 'var' || d.kind === 'const' || d.kind === 'signal' || d.kind === 'import';
        const routine = routineAt(doc, line);
        if (routine) {
            for (const d of doc.decls) { if (d.routine === routine && isVariable(d)) { add(d.key, { kind: 'decl', doc, decl: d }, 'local'); } }
            for (const p of routine.params) { add(p.key, { kind: 'param', doc, routine, param: p }, 'param'); }
        }
        const dat = this.companionDat(filePath);
        for (const d of dat?.decls ?? []) { if (!d.routine && isVariable(d)) { add(d.key, { kind: 'decl', doc: dat!, decl: d }, 'module'); } }
        for (const d of doc.decls) { if (!d.routine && isVariable(d)) { add(d.key, { kind: 'decl', doc, decl: d }, 'module'); } }
        for (const [key, sym] of this.build(filePath).globals) {
            if (sym.kind === 'decl' && isVariable(sym.decl)) { add(key, sym, 'global'); }
        }
        return out;
    }

    /** Routines callable from a file. */
    visibleRoutines(filePath: string): KrlSymbol[] {
        const doc = this.document(filePath);
        if (!doc) { return []; }
        const out = new Map<string, KrlSymbol>();
        for (const r of doc.routines) { out.set(r.key, { kind: 'routine', doc, routine: r }); }
        for (const [key, sym] of this.build(filePath).routines) { if (!out.has(key)) { out.set(key, sym); } }
        for (const sym of this.extDeclarations(filePath)) {
            if (sym.kind === 'decl' && !out.has(sym.decl.key)) { out.set(sym.decl.key, sym); }
        }
        return [...out.values()];
    }

    /** STRUC / ENUM types visible in a file. */
    visibleTypes(filePath: string): KrlSymbol[] {
        const out = new Map<string, KrlSymbol>();
        const doc = this.document(filePath);
        for (const t of doc?.types ?? []) { out.set(t.key, { kind: 'type', doc: doc!, type: t }); }
        const dat = this.companionDat(filePath);
        for (const t of dat?.types ?? []) { if (!out.has(t.key)) { out.set(t.key, { kind: 'type', doc: dat!, type: t }); } }
        for (const [key, sym] of this.build(filePath).types) { if (!out.has(key)) { out.set(key, sym); } }
        return [...out.values()];
    }

    // ---------------------------------------------------------------------------
    // types

    /** Members of a structure type: user STRUC, predefined, system or inline form type. */
    structMembers(filePath: string, typeName: string): StructMember[] | undefined {
        const sym = this.resolveType(filePath, typeName);
        if (sym?.kind === 'type' && sym.type.kind === 'struc') {
            return sym.type.members.map(m => ({
                name: m.name, type: m.type,
                dims: m.dims ? m.dims.replace(/[[\]]/g, '').split(',').map(d => parseInt(d, 10) || 0) : [],
            }));
        }
        return catalogStructMembers(typeName);
    }

    /** Literals of an ENUM type (without #). */
    enumValues(filePath: string, typeName: string): string[] | undefined {
        const sym = this.resolveType(filePath, typeName);
        if (sym?.kind === 'type' && sym.type.kind === 'enum') { return sym.type.values; }
        return systemEnumValues(typeName);
    }

    /** Declared type of a variable visible at a line ('' when unknown). */
    typeOfName(filePath: string, line: number, name: string): { type: string; isArray: boolean } {
        if (name.startsWith('$')) {
            const sys = systemVariable(name);
            if (!sys) { return { type: '', isArray: false }; }
            const isArray = sys.type.endsWith('[]');
            return { type: sys.struct ?? sys.enumType ?? sys.type.replace(/\[\]$/, ''), isArray };
        }
        const sym = this.resolveVariable(filePath, line, name);
        if (!sym) { return { type: '', isArray: false }; }
        if (sym.kind === 'param') { return { type: sym.param.type, isArray: !!sym.param.dims }; }
        if (sym.kind === 'decl') {
            if (sym.decl.kind === 'signal') { return { type: /\bTO\b/i.test(sym.decl.type) ? 'INT' : 'BOOL', isArray: false }; }
            return { type: sym.decl.type, isArray: !!sym.decl.dims };
        }
        return { type: '', isArray: false };
    }

    /**
     * Type of an access path like `WZ_PS[i].SENSOR` or `$VEL`: the declared type of
     * the base, the element type for an index, the member type for each member.
     */
    typeOfPath(filePath: string, line: number, pathText: string): string {
        const m = /^\s*(\$?[A-Za-z_][\w$]*)/.exec(pathText);
        if (!m) { return ''; }
        const base = this.typeOfName(filePath, line, m[1]);
        let type = base.type;
        let rest = pathText.slice(m[0].length);
        while (rest.length > 0 && type) {
            rest = rest.trimStart();
            if (rest.startsWith('[')) {
                let depth = 0;
                let i = 0;
                for (; i < rest.length; i++) {
                    if (rest[i] === '[') { depth++; }
                    if (rest[i] === ']' && --depth === 0) { break; }
                }
                rest = rest.slice(i + 1);
                continue;
            }
            const mm = /^\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
            if (!mm) { break; }
            const member = this.structMembers(filePath, type)?.find(x => x.name.toLowerCase() === mm[1].toLowerCase());
            type = member ? member.type.toUpperCase() : '';
            rest = rest.slice(mm[0].length);
        }
        return type.toUpperCase();
    }

    /** Whether a type holds a robot position (FRAME, POS, E6POS, AXIS, E6AXIS). */
    static isPositionType(type: string): boolean {
        return POSITION_TYPES.has(type.toUpperCase());
    }
}
