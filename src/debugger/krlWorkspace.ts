// krlWorkspace.ts
// Locates the files that make up a KRL robot project, starting from the main
// program: $config.dat, the submit programs (SPS.SUB, ...) and the other
// modules whose routines the programs call (BAS, P00, ...).
// A controller backup keeps them in a tree like
//   KRC/R1/cell.src, KRC/R1/Program/..., KRC/R1/System/$config.dat, KRC/R1/System/sps.sub
// Pure logic (no vscode imports).

import * as fs from 'fs';
import * as path from 'path';

export interface KrlLaunchFiles {
    mainPath: string;
    submitPaths: string[];
    configDatPath: string | null;
    /** other modules (.src) and data lists (.dat) of the robot */
    sources: string[];
    /** folder treated as the robot root (R1); modules below it are loaded */
    robotRoot: string;
    /** the robot's machine data (Mada/$machine.dat), null when not found */
    machineDataPath: string | null;
}

export interface KrlLaunchRequest {
    program: string;
    submitPrograms?: unknown;
    configDat?: unknown;
    sources?: unknown;
    machineData?: unknown;
}

const MAX_FILES = 3000;
const MAX_DEPTH = 8;
/** machine data and tooling folders that contain no robot programs */
const SKIP_DIRS = /^(mada|node_modules|\.git|\.vscode|\.vs|out)$/i;

function listDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

/** Case-insensitive lookup of a file or folder inside `dir`. */
function findEntry(dir: string, name: RegExp, wantDir: boolean): string | null {
    const hit = listDir(dir).find(e => name.test(e.name) && (wantDir ? e.isDirectory() : e.isFile()));
    return hit ? path.join(dir, hit.name) : null;
}

/**
 * Walk up from the program looking for $config.dat, either next to a folder
 * or in its System subfolder (KRC/R1/System/$config.dat).
 */
export function findConfigDat(startPath: string): string | null {
    let dir = path.dirname(path.resolve(startPath));
    for (;;) {
        const direct = findEntry(dir, /^\$config\.dat$/i, false);
        if (direct) { return direct; }
        const system = findEntry(dir, /^system$/i, true);
        const inSystem = system ? findEntry(system, /^\$config\.dat$/i, false) : null;
        if (inSystem) { return inSystem; }
        const parent = path.dirname(dir);
        if (parent === dir) { return null; }
        dir = parent;
    }
}

/** R1 for KRC/R1/System/$config.dat, otherwise the folder of $config.dat or the program. */
export function robotRootFor(mainPath: string, configDatPath: string | null): string {
    if (!configDatPath) { return path.dirname(path.resolve(mainPath)); }
    const dir = path.dirname(path.resolve(configDatPath));
    return /^system$/i.test(path.basename(dir)) ? path.dirname(dir) : dir;
}

/**
 * The robot's machine data: Mada/$machine.dat in the robot root (KRC/R1/Mada)
 * or in a folder above the program.
 */
export function findMachineData(mainPath: string, configDatPath: string | null): string | null {
    const dirs: string[] = [];
    if (configDatPath) { dirs.push(robotRootFor(mainPath, configDatPath)); }
    let dir = path.dirname(path.resolve(mainPath));
    for (;;) {
        dirs.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    for (const d of dirs) {
        const mada = findEntry(d, /^mada$/i, true);
        const file = mada ? findEntry(mada, /^\$machine\.dat$/i, false) : null;
        if (file) { return file; }
    }
    return null;
}

/** Recursively collect files below `root` whose name matches `pattern`. */
export function collectFiles(root: string, pattern: RegExp, recursive: boolean): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
        const entries = listDir(dir).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            if (out.length >= MAX_FILES) { return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (recursive && depth < MAX_DEPTH && !SKIP_DIRS.test(e.name)) { walk(full, depth + 1); }
            } else if (e.isFile() && pattern.test(e.name)) {
                out.push(full);
            }
        }
    };
    walk(root, 0);
    return out;
}

function samePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * The controller starts SPS.SUB in its submit interpreter (KSS 8.3 manual, 12.1);
 * other SUB programs are subprograms of it. So SPS.SUB runs when it is found next
 * to the main program or (for a robot project with $config.dat) anywhere below the
 * robot root, e.g. R1/System/sps.sub. Without SPS.SUB, the .sub files next to the
 * main program (else below the robot root) run.
 */
export function discoverSubmitPrograms(mainPath: string, robotRoot: string, searchRobotRoot: boolean): string[] {
    const isSub = /\.sub$/i;
    const isSps = (f: string) => path.basename(f).toLowerCase() === 'sps.sub';
    const near = collectFiles(path.dirname(path.resolve(mainPath)), isSub, false).filter(f => !samePath(f, mainPath));
    const below = searchRobotRoot
        ? collectFiles(robotRoot, isSub, true).filter(f => !samePath(f, mainPath))
        : [];
    const sps = near.find(isSps) ?? below.find(isSps);
    if (sps) { return [sps]; }
    return (near.length > 0 ? near : below)
        .sort((a, b) => path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase()));
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
}

/**
 * Resolve every file the debugger loads for a launch request. Explicit
 * `submitPrograms` / `configDat` / `sources` win over auto-discovery.
 */
export function resolveLaunchFiles(req: KrlLaunchRequest): KrlLaunchFiles {
    const mainPath = req.program;
    const configDatPath = typeof req.configDat === 'string' && req.configDat.trim()
        ? req.configDat
        : findConfigDat(mainPath);
    const robotRoot = robotRootFor(mainPath, configDatPath);

    // a .sub selected as the program is the submit interpreter itself: nothing else is discovered
    const configuredSubmits = stringList(req.submitPrograms);
    const submitPaths = configuredSubmits.length > 0 || /\.sub$/i.test(mainPath)
        ? configuredSubmits
        : discoverSubmitPrograms(mainPath, robotRoot, configDatPath !== null);

    let sources = stringList(req.sources);
    if (sources.length === 0) {
        // without $config.dat we cannot tell where the robot project ends: stay in the program folder
        const recursive = configDatPath !== null;
        // SUB programs that are not started can still be called as subprograms
        sources = collectFiles(robotRoot, /\.(src|sub|dat)$/i, recursive)
            // system data lists ($machine.dat, $robcor.dat, $config.dat) are handled separately
            .filter(f => !path.basename(f).startsWith('$'));
    }
    const taken = [mainPath, ...submitPaths];
    sources = sources.filter(f => !taken.some(t => samePath(t, f)));
    const machineDataPath = typeof req.machineData === 'string' && req.machineData.trim()
        ? req.machineData
        : findMachineData(mainPath, configDatPath);
    return { mainPath, submitPaths, configDatPath, sources, robotRoot, machineDataPath };
}
