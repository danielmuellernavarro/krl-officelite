// krlRuntime.ts
// A source-level simulator for KRL programs. The robot program and the submit
// programs run as separate threads that the scheduler interleaves one
// statement at a time, like the robot and submit interpreters of the
// controller. Endless LOOPs keep running until a breakpoint, HALT or pause.
// Implements breakpoints, stepping and variable inspection for the DAP session.
// Pure logic (no vscode imports).

import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import {
    KrlProgram, KrlFunctionInfo, KrlStmt, parseKrlProgram, splitTopLevel, findClosing,
} from './krlProgram';
import {
    KrlValue, EvalContext, StructMember, defaultValue, displayValue, typeLabel, krlNumber, krlBool,
    valuesEqual, cloneValue, assignmentValue, storeValue, makeArray, isCharArray, charArrayText, isPositionType,
    KRL_INT, KRL_REAL, KRL_BOOL, KRL_STR, KRL_UNDEF, InvalidRead, KrlStopError, unassignedValue, hasNoValue,
} from './krlValue';
import { evaluateExpression } from './krlExpr';
import { findConfigDat, findMachineData } from './krlWorkspace';
import { componentText, normalizeEditedValue, positionSummary, matrixOf, formatReal } from './krlRobotFormat';
import {
    RobotCharacteristics, RobotPose, MotionTiming, MotionKind, MotionRequest, KrlMode, KRL_MODES, Arc, Vec3, PathLimits, STANDARD_ROBOT, DEFAULT_RAISE_TIME_S,
    parseMachineData, planTiming, motionState, circleThrough, arcPoint, armPosition, armAngles, angleDelta, axisName,
} from './krlMotion';

export interface KrlCallFrame {
    /** normalized key of the program file (see keyOf) */
    progKey: string;
    functionName: string;
    /** 'prog' | 'fct' | 'defdat' */
    kind: string;
    /** statement index of the next instruction */
    pc: number;
    startIdx: number;
    endIdx: number;
    params: Map<string, KrlValue>;
    /** parameters passed by value (:IN) */
    inParams: Set<string>;
    locals: Map<string, KrlValue>;
    /** pc to resume at in the caller after this frame returns (-1 = none) */
    returnPc: number;
    callLine: number;
    returnValue: KrlValue | null;
    /** active FOR loops keyed by the statement index of their FOR */
    forLoops: Map<number, { varName: string; end: number; step: number }>;
    /** OUT parameters written back to the caller's variables on return */
    outBindings: { param: string; target: string }[];
}

export type ThreadWait =
    | { kind: 'for'; cond: string }
    | { kind: 'sec'; until: number }
    /** advance run: the motion just planned waits until at most $ADVANCE motions are ahead of the main run */
    | { kind: 'advance' }
    /** advance run stop: the statement waits until the main run has executed every planned motion */
    | { kind: 'mainrun' };

/** A motion planned by the advance run of the robot interpreter and executed later by its main run. */
export interface PlannedMotion {
    progKey: string;
    line: number;
    text: string;
    /** position system variable it moves ($pos_act / $axis_act), null when the target is unknown */
    sysKey: string | null;
    /** components of that variable at the start and at the end of the motion */
    start: Map<string, number>;
    target: Map<string, number>;
    /** simulated ms the motion takes, and until the robot has finished it */
    duration: number;
    remaining: number;
    /** velocity profile; null when the target is unknown */
    timing: MotionTiming | null;
    /** CIRC: the arc the TCP follows */
    arc: Arc | null;
    /** where the robot is at the start and at the end (estimated where there are no kinematics) */
    startPose: RobotPose | null;
    endPose: RobotPose | null;
    /** approximated (C_PTP, C_DIS, C_VEL, C_ORI): the robot does not stop at the end */
    approximated: boolean;
    /** simulated ms of the last update of $POS_ACT / $AXIS_ACT on the way */
    sampledAt: number;
    /** what the timing was planned from (to plan it again when the robot has to stop at the end after all) */
    request?: MotionRequest;
}

export interface KrlThread {
    id: number;
    /** program name, used as log prefix (CELL, SPS, ...) */
    name: string;
    role: 'robot' | 'submit';
    file: string;
    fileKey: string;
    finished: boolean;
    /** stopped by the user (Stop Interpreter): the scheduler skips it until it is started again */
    stopped: boolean;
    stack: KrlCallFrame[];
    /** set while the thread is blocked in WAIT FOR / WAIT SEC or by the advance run */
    wait: ThreadWait | null;
    /** robot interpreter: motions planned by the advance run; the first one is being executed */
    motions: PlannedMotion[];
}

export type StopReason = 'entry' | 'breakpoint' | 'step' | 'pause' | 'halt' | 'end' | 'error' | 'exception' | 'busy';

export interface StopInfo {
    reason: StopReason;
    threadId?: number;
    message?: string;
}

/** Where and why the controller would have stopped the program (reason 'exception'). */
export interface KrlRuntimeErrorInfo {
    threadId: number;
    /** 'undeclared' | 'uninitialized' | 'index' */
    kind: string;
    message: string;
    file: string;
    /** 0-based */
    line: number;
}

export type RunMode = 'continue' | 'stepIn' | 'stepOver' | 'stepOut';

/** A message of SET_KRLMSG (notify, state, quit, waiting) or a dialog of SET_KRLDLG. */
export interface KrlMessage {
    handle: number;
    type: 'notify' | 'state' | 'quit' | 'waiting' | 'dialog';
    module: string;
    nr: number;
    /** text with %1 .. %3 replaced by the parameters */
    text: string;
    /** dialogs: the softkeys that have a label; `nr` is the answer EXISTS_KRLDLG returns */
    softkeys: { nr: number; label: string }[];
    /** interpreter that set it */
    thread: string;
    threadId: number;
}

export interface KrlRuntimeOptions {
    mainPath: string;
    submitPaths?: string[];
    /** further modules (.src) and data lists (.dat) whose routines and globals are visible */
    sources?: string[];
    /** Explicit path to $config.dat. When omitted the runtime walks up the
     *  directory tree from the main program (also checking System folders). */
    configDatPath?: string | null;
    stopOnEntry?: boolean;
    /** optional instruction budget (tests); by default programs run without limit */
    maxSteps?: number;
    onOutput?: (text: string) => void;
    onThreadExit?: (threadId: number) => void;
    /** the message list changed (set by the program, acknowledged, answered or cleared) */
    onMessagesChanged?: (messages: KrlMessage[]) => void;
    /** Explicit path to the robot's $machine.dat (motion timing). When omitted the
     *  runtime looks for Mada/$machine.dat in the robot root and above the program;
     *  null uses the standard robot. */
    machineDataPath?: string | null;
    /** Simulation override [%]: the simulated controller time runs at this rate of
     *  real time (100 = like the robot, up to 10000). Omitted: as fast as possible. */
    simulationOverride?: number;
    /** Override at the start [%] (0 .. 10000, see setOverride). Omitted: $OV_PRO 100. */
    override?: number;
    /** Operating mode at the start. Omitted: T1, like $MODE_OP of the controller. */
    mode?: KrlMode;
    /** the override or the operating mode changed (also when the program writes $OV_PRO) */
    onOverrideOrModeChanged?: () => void;
}

export interface FrameHandle {
    kind: 'frame' | 'runtime' | 'datPrivate' | 'datGlobal' | 'configGlobal' | 'system' | 'value';
    threadId?: number;
    frameIndex?: number;
    value?: KrlValue;
    /** access path of `value` for system variables, whose writes go through the runtime */
    sysPath?: string;
    /** KRL expression addressing `value` (evaluateName of its children) */
    path?: string;
}

/** One line of the variable search: a variable, structure member or array element. */
export interface VariableSearchEntry {
    expression: string;
    value: string;
    type: string;
    /** where it is declared: Runtime (thread routine), DAT module, DAT Global, $CONFIG.DAT, System */
    scope: string;
}

export interface VariableEntry {
    name: string;
    type: string;
    value: string;
    reference: number;
    /** number of array elements (enables paging in the Variables view) */
    indexedVariables?: number;
    /** KRL expression for the variable: enables Add to Watch / Copy as Expression */
    evaluateName?: string;
}

export interface ThreadView {
    id: number;
    name: string;
    file: string;
    finished: boolean;
    stopped: boolean;
    line: number; // 0-based line of current statement (if any)
}

export interface StackFrameView {
    frameId: number;
    threadId: number;
    name: string;
    file: string;
    line: number; // 0-based
}

/** Where a robot interpreter is: the motion the robot executes (main run) and the motions planned after it. */
export interface MainRunView {
    threadId: number;
    file: string;
    line: number;
    text: string;
    planned: number;
    /** every planned motion after the executing one, in order */
    motions: { file: string; line: number }[];
}

/** The statement the robot interpreter executes next (advance run). */
export interface AdvanceRunView {
    threadId: number;
    file: string;
    line: number;
    /** motions planned after the one the robot executes */
    ahead: number;
}

/** One line of the KRL Robot view: a value with optional components. */
export interface RobotViewEntry {
    label: string;
    value: string;
    tooltip?: string;
    /** expression for the live watch / clipboard */
    expression?: string;
    /** 4x4 homogeneous matrix of a frame */
    matrix?: number[][];
    /** context value of the tree item (inline actions) */
    contextValue?: string;
    children?: RobotViewEntry[];
}

/** An input, output, flag, timer, signal or system signal of the KRL I/O view. */
export interface IoEntry {
    expression: string;
    value: string;
    kind: 'bool' | 'number' | 'other';
    /** SIGNAL names declared for it */
    names: string[];
}

export interface IoGroup {
    name: string;
    entries: IoEntry[];
}

interface SignalDef {
    name: string;
    /** '$in' | '$out' | '$anin' | '$anout', or null for SIGNAL x FALSE */
    io: string | null;
    from: number;
    to: number;
    constant: boolean;
    /** 'config' | 'global' | module key of the declaring data list */
    scope: string;
}

/** simulated time per scheduler round (every thread executes one statement) */
const ROUND_MS = 1;
/** simulated time per round while every thread is blocked in WAIT */
const IDLE_TICK_MS = 12;
/** real time to sleep per idle round so waiting programs do not spin a CPU core */
const IDLE_SLEEP_MS = 10;
/** run at most this long before yielding to the event loop */
const SLICE_MS = 15;
const TRACE_LINES_PER_SECOND = 100;
const TIMER_COUNT = 64;
const NESTED_FUNCTION_GUARD = 200000;
/** a motion takes at least one interpolation cycle */
const MIN_MOTION_MS = 12;
/** $POS_ACT / $AXIS_ACT follow a moving robot in steps of this many simulated ms */
const SAMPLE_MS = 4;
/** tolerance for comparing simulated times (WAIT SEC 0.7 is not exactly 700 ms in floating point) */
const CLOCK_EPSILON_MS = 1e-6;
/** components of E6AXIS in the order of the axis arrays ($VEL_AXIS[1] = A1, [7] = E1) */
const AXIS_KEYS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
/** marks the result of a function the simulator does not have (system functions such as MD_CMD) */
const NOT_SIMULATED = '#NOT_SIMULATED';
/** $ERR.NUMBER of a value error suppressed by ON_ERROR_PROCEED (KSS: variable value invalid) */
const ERR_VALUE_INVALID = 1422;
/** statements ON_ERROR_PROCEED can skip when they fail (block statements cannot) */
const SKIPPABLE_ON_ERROR = new Set<string>(['assign', 'call', 'motion', 'wait', 'return', 'other']);
/** simulation override range [%] */
export const MIN_SIMULATION_OVERRIDE = 1;
/** the override as the user sets it: 0 (robot stands) .. 100 ($OV_PRO) .. 10000 (simulation speed) */
export const MIN_OVERRIDE = 0;
export const MAX_SIMULATION_OVERRIDE = 10000;
/** statements and system variables that trigger an advance run stop (expert manual R5.2, table 6; KSS 8.3) */
const ADVANCE_STOP_STATEMENT = /^(?:ANIN|ANOUT|DIGIN)\s+(?:ON|OFF)\b|\b(?:PULSE|CREAD|CWRITE|COPEN|CCLOSE|SREAD|SWRITE|SET_TORQUE_LIMITS|RESET_TORQUE_LIMITS|SET_BRAKE_DELAY|DELETE_BACKWARD_BUFFER|SET_KRLMSG|SET_KRLDLG)\s*\(/i;
const ADVANCE_STOP_VARIABLE = /\$(?:OUT|IN|ANOUT|ANIN|DIGIN[1-6]|AXIS_(?:ACT|BACK|FOR|RET|INC|INT|ACTMOD)|POS_(?:ACT|BACK|FOR|RET|INT|ACT_MES)|TORQUE_AXIS(?:_ACT|_LIMITS)?|HOLDING_TORQUE|BRAKE_SIG|ASYNC_AXIS|ASYNC_EX_AX|ALARM_STOP|INHOME_POS|ON_PATH|EM_STOP|EXTSTARTTYP|REVO_NUM|SAFETY_SW|ACT_TOOL|ACT_BASE|ACT_EX_AX|PAL_MODE|OV_PRO|WORKSPACE|IBUS_ON|IBUS_OFF)\b/i;
/** variable search: members/elements are listed this deep, arrays up to this size, at most this many lines */
const SEARCH_DEPTH = 4;
const SEARCH_ARRAY_LIMIT = 64;
const SEARCH_MAX_ENTRIES = 10000;

/** An override for display: whole numbers without decimals. */
export function formatOverride(pct: number): string {
    return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

/** Whether a motion goes to the point the motion before ends at (same position variable, every component equal). */
function isSamePoint(before: PlannedMotion, motion: PlannedMotion): boolean {
    if (!motion.sysKey || motion.sysKey !== before.sysKey || motion.target.size === 0) { return false; }
    for (const [k, to] of motion.target) {
        const from = motion.start.get(k);
        if (from === undefined || Math.abs(to - from) > 1e-6) { return false; }
    }
    return true;
}

/** The message the controller shows for a read it does not allow. */
function invalidReadMessage(read: InvalidRead): string {
    switch (read.kind) {
        case 'undeclared': return `${read.path} is not declared`;
        case 'index': return `Array index inadmissible: ${read.path} is outside the array`;
        default: return `Variable value invalid: ${read.path} has no value`;
    }
}

function clampOverride(pct: number): number {
    return Number.isFinite(pct) ? Math.max(MIN_SIMULATION_OVERRIDE, Math.min(MAX_SIMULATION_OVERRIDE, pct)) : 100;
}

/** KRL names are case-insensitive: files and identifiers are keyed lowercased. */
function keyOf(filePath: string): string {
    return path.resolve(filePath).toLowerCase();
}

function moduleKeyOf(fileKey: string): string {
    return fileKey.replace(/\.[^.\\/]+$/, '');
}

const boolArray = (n: number) => makeArray([n], () => KRL_BOOL(false));
const realArray = (n: number) => makeArray([n], () => KRL_REAL(0));

/** Simulated system variables and their values after controller start-up. */
const SYSTEM_DEFAULTS: Record<string, () => KrlValue> = {
    '$pos_act': () => defaultValue('E6POS'),
    '$axis_act': () => defaultValue('E6AXIS'),
    '$tool': () => defaultValue('FRAME'),
    '$base': () => defaultValue('FRAME'),
    '$robroot': () => defaultValue('FRAME'),
    '$nullframe': () => defaultValue('FRAME'),
    '$h_pos': () => defaultValue('E6AXIS'),
    '$vel': () => defaultValue('VEL'),
    '$acc': () => defaultValue('ACC'),
    '$apo': () => defaultValue('APO'),
    '$vel_axis': () => realArray(12),
    '$acc_axis': () => realArray(12),
    '$load': () => defaultValue('LOAD'),
    '$ov_pro': () => KRL_INT(100),
    '$mode_op': () => ({ t: 'enum', v: '#T1' }),
    '$t1': () => KRL_BOOL(true),
    '$t2': () => KRL_BOOL(false),
    '$aut': () => KRL_BOOL(false),
    '$ext': () => KRL_BOOL(false),
    '$in': () => boolArray(4096),
    '$out': () => boolArray(4096),
    '$anin': () => realArray(32),
    '$anout': () => realArray(32),
    '$flag': () => boolArray(1024),
    '$cycflag': () => boolArray(256),
    '$move_enable': () => KRL_BOOL(true),
    '$peri_rdy': () => KRL_BOOL(true),
    '$drives_on': () => KRL_BOOL(true),
    '$drives_off': () => KRL_BOOL(false),
    '$em_stop': () => KRL_BOOL(false),
    '$brake': () => KRL_BOOL(false),
    '$power_fail': () => KRL_BOOL(false),
    '$stopmess': () => KRL_BOOL(false),
    '$i_o_actconf': () => KRL_BOOL(true),
    '$ext_start': () => KRL_BOOL(false),
    '$inposition': () => KRL_INT(0),
    '$pro_state0': () => ({ t: 'enum', v: '#P_ACTIVE' }),
    '$pro_state1': () => ({ t: 'enum', v: '#P_ACTIVE' }),
    '$err': () => defaultValue('ERR'),
    '$cycle': () => KRL_INT(0),
    // motion blocks the advance run may plan ahead of the main run (KSS 8.3 manual 8.3: default 3, max 5)
    '$advance': () => KRL_INT(3),
};

/** Shown (in this order) in the System Variables scope; written ones follow. */
const SYSTEM_SCOPE_VARIABLES = [
    // actual robot position and axis angles, home position
    '$POS_ACT', '$AXIS_ACT', '$H_POS',
    // active tool / base / robot root frame
    '$TOOL', '$BASE', '$ROBROOT',
    // velocity, acceleration, approximate positioning (expandable structs)
    '$VEL', '$ACC', '$APO', '$ADVANCE',
    // program override and operating mode
    '$OV_PRO', '$MODE_OP', '$T1', '$T2', '$AUT', '$EXT',
    // digital / analog I/O, flags
    '$IN', '$OUT', '$ANIN', '$ANOUT', '$FLAG', '$CYCFLAG',
    // timers
    '$TIMER', '$TIMER_STOP', '$TIMER_FLAG',
    // machine-state signals
    '$MOVE_ENABLE', '$PERI_RDY', '$DRIVES_ON', '$DRIVES_OFF', '$EM_STOP', '$BRAKE', '$STOPMESS',
    // interpreter state
    '$PRO_STATE0', '$PRO_STATE1', '$ERR',
];

/** Built-in procedures that are accepted without effect in the simulation. */
const NOOP_PROCEDURES = new Set([
    'err_clear', 'err_raise', 'cwrite', 'cread', 'swrite', 'sread', 'pulse', 'wait_for_on',
    'mbx_rec', 'sync', 'get_sig_inf',
]);

export class KrlRuntime {
    /** all loaded files by key, in load order */
    private programs = new Map<string, KrlProgram>();
    /** module routines (first DEF of a file) and GLOBAL routines */
    private globalRoutines = new Map<string, { key: string; func: KrlFunctionInfo }>();
    private threads: KrlThread[] = [];
    /** GLOBAL declarations from regular .dat files */
    private datGlobals = new Map<string, KrlValue>();
    /** Declarations from $config.dat */
    private configGlobals = new Map<string, KrlValue>();
    /** Non-GLOBAL declarations from regular .dat files, keyed by module key */
    private datPrivatesByModule = new Map<string, Map<string, KrlValue>>();
    private structTypes = new Map<string, StructMember[]>();
    private enumTypes = new Map<string, string[]>();
    private signals = new Map<string, SignalDef>();
    /** spelling of identifiers as declared, for display */
    private displayNames = new Map<string, string>();
    private systemVars = new Map<string, KrlValue>();
    private timerValue = new Array<number>(TIMER_COUNT).fill(0);
    private timerBase = new Array<number>(TIMER_COUNT).fill(0);
    private timerStopped = new Array<boolean>(TIMER_COUNT).fill(true);
    private timerArmed = new Array<boolean>(TIMER_COUNT).fill(false);
    private breakpoints = new Map<string, Set<number>>();
    /** simulated controller time in ms */
    private clockMs = 0;
    private stepsExecuted = 0;
    private stopRequested = false;
    private handles = new Map<number, FrameHandle>();
    private nextHandle = 1;
    private rrIndex = 0;
    private roundProgress = false;
    private nestedDepth = 0;
    private running = false;
    private started = false;
    private maxSteps: number;
    private onOutput: (text: string) => void;
    private warned = new Set<string>();
    private traceWindowStart = 0;
    private traceCount = 0;
    private traceSuppressed = 0;
    private lastTrace = '';
    private traceRepeats = 0;
    private krlMsgHandle = 0;
    /** messages and dialogs waiting in the message window */
    private messages: KrlMessage[] = [];
    /** answered dialogs: handle -> softkey, returned by the next EXISTS_KRLDLG */
    private dialogAnswers = new Map<number, number>();
    /** per statement: does it trigger an advance run stop (see needsAdvanceRunStop) */
    private advanceStopCache = new WeakMap<KrlStmt, boolean>();
    /** the error that stopped the programs last */
    private lastError: KrlRuntimeErrorInfo | null = null;
    configDatPath: string | null = null;
    /** characteristics of the simulated robot (motion timing) */
    robot: RobotCharacteristics = STANDARD_ROBOT;
    /** where the robot was after the last finished motion; 'axes': $AXIS_ACT is exact, 'cartesian': $POS_ACT is */
    private pose: { exact: 'axes' | 'cartesian'; estimate: RobotPose } | null = null;
    /** $OV_PRO the planned motions were last timed with */
    private appliedOverride = 100;
    /** simulation override [%], null: simulated time runs as fast as possible */
    private simOverride: number | null;
    /** pacing anchor: simulated time `paceClock` at real time `paceWall` */
    private paceWall = 0;
    private paceClock = 0;

    constructor(private opts: KrlRuntimeOptions) {
        this.maxSteps = opts.maxSteps ?? 0;
        this.onOutput = opts.onOutput ?? (() => { });
        this.simOverride = opts.simulationOverride === undefined ? null : clampOverride(opts.simulationOverride);
    }

    // ------------------------------------------------------------------
    // loading

    /** Read and parse all source files. Returns human readable errors. */
    load(): string[] {
        const errors: string[] = [];
        this.configDatPath = this.opts.configDatPath === undefined
            ? findConfigDat(this.opts.mainPath)
            : this.opts.configDatPath;
        const configKey = this.configDatPath ? keyOf(this.configDatPath) : null;
        this.loadMachineData();

        // 1. read and parse every file
        const required = [this.opts.mainPath, ...(this.opts.submitPaths ?? [])];
        for (const p of required) { this.readProgram(p, errors); }
        for (const p of this.opts.sources ?? []) { this.readProgram(p, null); }
        // KRL convention: a module keeps its data list in a sibling .dat file
        for (const prog of [...this.programs.values()]) {
            if (/\.dat$/i.test(prog.path)) { continue; }
            const dat = siblingDat(prog.path);
            if (dat) { this.readProgram(dat, errors); }
        }
        if (this.configDatPath) { this.readProgram(this.configDatPath, errors); }

        // 2. routines callable from other files
        for (const [key, prog] of this.programs) {
            if (!/\.dat$/i.test(prog.path)) { this.registerRoutines(key, prog); }
        }

        // 3. STRUC / ENUM definitions, then the data lists ($config.dat first)
        const ordered = [...this.programs.entries()].sort(([a], [b]) =>
            (a === configKey ? -1 : 0) - (b === configKey ? -1 : 0));
        for (const [, prog] of ordered) {
            for (const stmt of prog.stmts) {
                if (stmt.kind === 'struc' || stmt.kind === 'enumdef') { this.registerType(stmt.text); }
            }
        }
        for (const [key, prog] of ordered) {
            if (/\.dat$/i.test(prog.path)) { this.loadDataList(prog, key, key === configKey); }
        }

        // 4. the robot interpreter runs the main program, the submit interpreter each .sub
        //    (a .sub selected as the program starts only the submit interpreter)
        const mainRole = /\.sub$/i.test(this.opts.mainPath) ? 'submit' : 'robot';
        const mainThread = this.createThread(0, mainRole, this.opts.mainPath, errors);
        if (mainThread) { this.threads.push(mainThread); }
        let submitId = 1;
        for (const p of this.opts.submitPaths ?? []) {
            const t = this.createThread(submitId, 'submit', p, errors);
            if (t) { this.threads.push(t); submitId++; }
        }
        if (this.opts.mode) { this.setMode(this.opts.mode); }
        if (this.opts.override !== undefined) { this.setOverride(this.opts.override); }
        return errors;
    }

    /** The robot's characteristics from Mada/$machine.dat, or the standard robot. */
    private loadMachineData(): void {
        const file = this.opts.machineDataPath === undefined
            ? findMachineData(this.opts.mainPath, this.configDatPath)
            : this.opts.machineDataPath;
        this.robot = STANDARD_ROBOT;
        if (!file) { return; }
        try {
            this.robot = parseMachineData(fs.readFileSync(file, 'latin1'), file);
        } catch (e) {
            this.warnOnce(`mada:${file}`, `[krl] cannot read the machine data ${file}: ${String(e)}; motions use a standard robot`);
        }
    }

    /** One line about the robot whose motions are simulated, for the debug console. */
    describeRobot(): string {
        const r = this.robot;
        const axes = r.axisVel.slice(0, Math.min(6, r.numAxes)).map((v, i) => `A${i + 1} ${Math.round(v)}`).join(', ');
        return `${r.source ? `${r.name} from ${r.source}` : `${r.name} (no Mada/$machine.dat found)`}: axes ${axes} °/s, path up to ${formatReal(r.velMa.cp, 2)} m/s`;
    }

    getSimulationOverride(): number | null {
        return this.simOverride;
    }

    /**
     * The override as on the smartPAD, extended for the simulation: up to 100 % it is
     * the program override $OV_PRO (motions slow down, the program sees it, 0 % = the
     * robot stands); above 100 % $OV_PRO is 100 and the whole simulation (motions,
     * WAIT SEC, timers) runs that much faster than real time.
     */
    getOverride(): { value: number; ovPro: number; speed: number | null } {
        const ovPro = Math.max(0, Math.min(100, krlNumber(this.resolveSystemVar('$ov_pro'), 100)));
        const speed = this.simOverride;
        return { value: speed !== null && speed > 100 ? speed : ovPro, ovPro, speed };
    }

    /** Set the override [%] (0 .. 10000, see getOverride); takes effect at once, also on the moving robot. */
    setOverride(pct: number): number {
        const v = Number.isFinite(pct) ? Math.max(MIN_OVERRIDE, Math.min(MAX_SIMULATION_OVERRIDE, pct)) : 100;
        const ov = this.resolveSystemVar('$ov_pro');
        const next = KRL_INT(Math.round(Math.min(v, 100)));
        this.systemVars.set('$ov_pro', ov ? storeValue(ov, next) : next);
        if (this.simOverride !== null) { this.setSimulationOverride(Math.max(v, 100)); }
        this.applyOverride();
        this.opts.onOverrideOrModeChanged?.();
        return this.getOverride().value;
    }

    /**
     * $OV_PRO acts on the moving robot at once: the planned motions keep their progress
     * and take the time of the new override. Returns $OV_PRO (0: the robot stands).
     */
    private applyOverride(): number {
        const ov = Math.max(0, Math.min(100, krlNumber(this.resolveSystemVar('$ov_pro'), 100)));
        if (ov === this.appliedOverride) { return ov; }
        this.appliedOverride = ov;
        if (ov > 0) { this.replanMotions(r => (r.override === ov ? null : { ...r, override: ov })); }
        this.opts.onOverrideOrModeChanged?.();
        return ov;
    }

    /** The operating mode ($MODE_OP). */
    getMode(): KrlMode {
        const v = this.resolveSystemVar('$mode_op');
        const mode = (v?.t === 'enum' ? v.v.replace(/^#/, '') : '').toUpperCase() as KrlMode;
        return KRL_MODES.includes(mode) ? mode : 'T1';
    }

    /**
     * Turn the key switch: T1, T2, AUT or EX. Like on the controller only while the
     * programs do not run; returns why it cannot change, else null. T1 reduces the
     * velocity of the motions (also of the ones already planned).
     */
    setMode(mode: KrlMode): string | null {
        if (!KRL_MODES.includes(mode)) { return `unknown operating mode ${mode}`; }
        if (this.running) { return 'The operating mode can only be changed while the program is stopped: pause it first, like on the robot.'; }
        const set = (key: string, value: KrlValue) => {
            const old = this.resolveSystemVar(key);
            this.systemVars.set(key, old ? storeValue(old, value) : value);
        };
        set('$mode_op', { t: 'enum', v: `#${mode}` });
        set('$t1', KRL_BOOL(mode === 'T1'));
        set('$t2', KRL_BOOL(mode === 'T2'));
        set('$aut', KRL_BOOL(mode === 'AUT'));
        set('$ext', KRL_BOOL(mode === 'EX'));
        this.replanMotions(r => (r.mode === mode ? null : { ...r, mode }));
        this.opts.onOverrideOrModeChanged?.();
        return null;
    }

    /** What the operating mode means for the motions, for the debug console and the KRL Robot view. */
    describeMode(mode = this.getMode()): string {
        switch (mode) {
            case 'T1': return `T1 (manual reduced velocity: path at most ${formatReal(this.robot.velCpT1, 2)} m/s, axes at ${Math.round(this.robot.redT1)} %)`;
            case 'T2': return 'T2 (manual high velocity: programmed velocity)';
            case 'AUT': return 'AUT (automatic)';
            default: return 'EX (automatic external)';
        }
    }

    /**
     * Plan the motions again with changed parameters (override, mode); each keeps the
     * part of its time already done. `update` returns null when a motion stays as it is.
     */
    private replanMotions(update: (r: MotionRequest) => MotionRequest | null): void {
        for (const t of this.threads) {
            for (const m of t.motions) {
                if (!m.request || !m.timing) { continue; }
                const next = update(m.request);
                if (!next) { continue; }
                const done = m.duration > 0 ? Math.max(0, Math.min(1, (m.duration - m.remaining) / m.duration)) : 0;
                m.request = next;
                m.timing = planTiming(next);
                m.duration = Math.max(MIN_MOTION_MS, m.timing.ms);
                m.remaining = Math.max(CLOCK_EPSILON_MS * 10, m.duration * (1 - done));
                m.sampledAt = m.duration - m.remaining;
            }
        }
    }

    /** Change how fast simulated time runs [%] (1 .. 10000); takes effect at once, also during a motion. */
    setSimulationOverride(pct: number): number {
        this.paceClock = this.clockMs;
        this.paceWall = performance.now();
        this.simOverride = clampOverride(pct);
        return this.simOverride;
    }

    private readProgram(filePath: string, errors: string[] | null): void {
        const key = keyOf(filePath);
        if (this.programs.has(key)) { return; }
        let text: string;
        try {
            text = fs.readFileSync(filePath, 'latin1');
        } catch (e) {
            const msg = `cannot read ${filePath}: ${String(e)}`;
            if (errors) { errors.push(msg); } else { this.warnOnce(msg, `[krl] ${msg}`); }
            return;
        }
        this.programs.set(key, parseKrlProgram(filePath, text));
    }

    private registerRoutines(key: string, prog: KrlProgram): void {
        for (const func of prog.funcs.values()) {
            if (func.kind === 'defdat') { continue; }
            if ((func === prog.moduleRoutine || func.isGlobal) && !this.globalRoutines.has(func.name)) {
                this.globalRoutines.set(func.name, { key, func });
            }
        }
    }

    /** Local routines of the calling file win over the module routines of other files. */
    private resolveRoutine(callerKey: string, name: string): { key: string; func: KrlFunctionInfo } | null {
        const low = name.toLowerCase();
        const local = this.programs.get(callerKey)?.funcs.get(low);
        if (local && local.kind !== 'defdat') { return { key: callerKey, func: local }; }
        return this.globalRoutines.get(low) ?? null;
    }

    private loadDataList(prog: KrlProgram, key: string, isConfig: boolean): void {
        const thread = this.dataListThread(prog.path, key);
        for (const stmt of prog.stmts) {
            switch (stmt.kind) {
                case 'decl':
                    this.executeDecl(stmt.text, thread, { datKey: key, isConfig });
                    break;
                case 'assign':
                    // initial values of the data list: loaded as they are
                    this.executeAssign(thread, stmt.text, false);
                    break;
                case 'signal':
                    this.registerSignal(stmt.text, isConfig ? 'config' : (/^\s*GLOBAL\b/i.test(stmt.text) ? 'global' : moduleKeyOf(key)));
                    break;
                default:
                    break;
            }
        }
    }

    private createThread(id: number, role: 'robot' | 'submit', file: string, errors: string[]): KrlThread | null {
        const key = keyOf(file);
        const prog = this.programs.get(key);
        if (!prog) { errors.push(`program file not loaded: ${file}`); return null; }
        const func = prog.moduleRoutine;
        if (func?.kind === 'fct') {
            errors.push(`${path.basename(file)} is a function module (DEFFCT ${func.displayName}) and cannot be started; select the program that calls it`);
            return null;
        }
        if (!func || func.kind !== 'prog') { errors.push(`no top level DEF found in ${file}`); return null; }
        return {
            id, name: func.displayName, role, file, fileKey: key,
            finished: false, stopped: false, stack: [this.makeFrame(key, func, 0, 0)], wait: null, motions: [],
        };
    }

    private dataListThread(file: string, key: string): KrlThread {
        return { id: -1, name: 'DAT', role: 'robot', file, fileKey: key, finished: false, stopped: false, stack: [], wait: null, motions: [] };
    }

    // ------------------------------------------------------------------
    // type, signal and variable declarations

    private registerType(text: string): void {
        const struc = text.match(/^(?:GLOBAL\s+)?STRUC\s+([A-Z_$][\w$]*)\s+(.+)$/i);
        if (struc) {
            const members: StructMember[] = [];
            let type = 'INT';
            for (const piece of splitTopLevel(struc[2], ',')) {
                const toks = piece.trim().split(/\s+/).filter(Boolean);
                if (toks.length === 0) { continue; }
                if (toks.length >= 2) { type = toks[0].toUpperCase(); }
                const decl = (toks.length >= 2 ? toks.slice(1) : toks).join('');
                const nm = decl.match(/^([A-Z_$][\w$]*)(?:\[([^\]]*)\])?$/i);
                if (!nm) { continue; }
                const dims = nm[2] ? nm[2].split(',').map(d => parseInt(d, 10) || 1) : [];
                members.push({ name: nm[1].toUpperCase(), type, dims });
            }
            this.structTypes.set(struc[1].toLowerCase(), members);
            return;
        }
        const en = text.match(/^(?:GLOBAL\s+)?ENUM\s+([A-Z_$][\w$]*)\s+(.+)$/i);
        if (en) {
            this.enumTypes.set(en[1].toLowerCase(), en[2].split(',').map(v => v.trim()).filter(Boolean));
        }
    }

    private defaultFor(type: string): KrlValue {
        return defaultValue(type, name => this.structTypes.get(name.toLowerCase()));
    }

    /** A declared variable before its first assignment (strings start blank). */
    private unassignedFor(type: string): KrlValue {
        return type.toUpperCase() === 'CHAR' ? this.defaultFor(type) : unassignedValue(type, name => this.structTypes.get(name.toLowerCase()));
    }

    private registerSignal(text: string, scope: string): void {
        const m = text.match(/^(?:GLOBAL\s+)?SIGNAL\s+([A-Z_$][\w$]*)\s+(.+)$/i);
        if (!m) { return; }
        const name = m[1].toLowerCase();
        const rest = m[2].trim();
        this.advanceStopCache = new WeakMap();
        const io = rest.match(/^(\$(?:IN|OUT|ANIN|ANOUT))\s*\[\s*(\d+)\s*\](?:\s+TO\s+\$(?:IN|OUT)\s*\[\s*(\d+)\s*\])?$/i);
        this.rememberName(m[1]);
        if (io) {
            const from = parseInt(io[2], 10);
            this.signals.set(name, {
                name, io: io[1].toLowerCase(), from, to: io[3] ? parseInt(io[3], 10) : from, constant: false, scope,
            });
        } else if (/^(TRUE|FALSE)$/i.test(rest)) {
            this.signals.set(name, { name, io: null, from: rest.toUpperCase() === 'TRUE' ? 1 : 0, to: 0, constant: true, scope });
        }
    }

    private readSignal(sig: SignalDef): KrlValue {
        if (sig.constant || !sig.io) { return KRL_BOOL(sig.from === 1); }
        const arr = this.resolveSystemVar(sig.io);
        if (!arr || arr.t !== 'array') { return KRL_UNDEF(); }
        if (sig.io === '$anin' || sig.io === '$anout') { return arr.v[sig.from - 1] ?? KRL_REAL(0); }
        if (sig.from === sig.to) { return arr.v[sig.from - 1] ?? KRL_BOOL(false); }
        let n = 0;
        for (let bit = sig.from, weight = 1; bit <= sig.to; bit++, weight *= 2) {
            if (krlBool(arr.v[bit - 1])) { n += weight; }
        }
        return KRL_INT(n);
    }

    private writeSignal(sig: SignalDef, value: KrlValue): void {
        if (sig.constant || !sig.io) { return; }
        const arr = this.resolveSystemVar(sig.io);
        if (!arr || arr.t !== 'array') { return; }
        if (sig.io === '$anin' || sig.io === '$anout') { arr.v[sig.from - 1] = storeValue(arr.v[sig.from - 1], KRL_REAL(krlNumber(value))); return; }
        if (sig.from === sig.to) { arr.v[sig.from - 1] = storeValue(arr.v[sig.from - 1], KRL_BOOL(krlBool(value))); return; }
        const n = Math.trunc(krlNumber(value));
        for (let bit = sig.from, i = 0; bit <= sig.to; bit++, i++) {
            arr.v[bit - 1] = storeValue(arr.v[bit - 1], KRL_BOOL(((n >> i) & 1) === 1));
        }
    }

    private rememberName(name: string): void {
        const key = name.toLowerCase();
        if (!this.displayNames.has(key)) { this.displayNames.set(key, name); }
    }

    /**
     * Execute a declaration statement.
     * - with a frame: runtime locals (or GLOBAL into DAT globals)
     * - with a data list: $config.dat globals / dat globals / dat privates
     */
    private executeDecl(
        text: string,
        thread: KrlThread,
        scope: { frame?: KrlCallFrame; datKey?: string; isConfig?: boolean },
    ): void {
        const m = text.match(/^(GLOBAL\s+)?(?:DECL\s+)?(GLOBAL\s+)?(?:CONST\s+)?([A-Z_$][\w$]*)\s+(.+)$/i);
        if (!m) { return; }
        const isGlobal = !!(m[1] || m[2]);
        const type = m[3].toUpperCase();
        const ctx = this.ctxFor(thread);

        for (const item of splitTopLevel(m[4], ',')) {
            const part = item.trim();
            if (!part) { continue; }
            const eq = findSingleEq(part);
            const namePart = (eq >= 0 ? part.slice(0, eq) : part).trim();
            const initText = eq >= 0 ? part.slice(eq + 1).trim() : '';
            const nm = namePart.match(/^([A-Za-z_$][\w$]*)\s*(?:\[([^\]]*)\])?$/);
            if (!nm) { continue; }
            const name = nm[1].toLowerCase();
            this.rememberName(nm[1]);

            const frame = scope.frame;
            if (frame && frame.params.has(name)) {
                // declares the type of a parameter: convert values passed by value
                const passed = frame.params.get(name);
                if (passed && frame.inParams.has(name) && nm[2] === undefined && /^(INT|REAL|BOOL|CHAR)$/.test(type)) {
                    frame.params.set(name, assignmentValue(this.defaultFor(type), passed));
                } else if (passed?.t === 'str' && frame.inParams.has(name) && nm[2] !== undefined && type === 'CHAR') {
                    // a string passed for CHAR TEXT[] becomes the CHAR array
                    frame.params.set(name, { t: 'array', v: [...passed.v].map(c => ({ t: 'char', v: c })) });
                }
                continue;
            }

            const dims = nm[2] !== undefined && nm[2].trim() !== ''
                ? splitTopLevel(nm[2], ',').map(d => Math.trunc(krlNumber(evaluateExpression(d, ctx))))
                : [];
            // like on the controller, a variable has no value until it is assigned one
            let value: KrlValue = dims.length > 0
                ? makeArray(dims, () => this.unassignedFor(type))
                : (nm[2] !== undefined ? { t: 'array', v: [] } : unassignedValue(type, n => this.structTypes.get(n.toLowerCase())));
            if (initText) { value = assignmentValue(value, evaluateExpression(initText, ctx)); }

            if (frame) {
                (isGlobal ? this.datGlobals : frame.locals).set(name, value);
            } else if (scope.isConfig) {
                this.configGlobals.set(name, value);
            } else if (isGlobal) {
                this.datGlobals.set(name, value);
            } else if (scope.datKey) {
                this.datPrivate(scope.datKey).set(name, value);
            } else {
                this.datGlobals.set(name, value);
            }
        }
    }

    private datPrivate(fileKey: string): Map<string, KrlValue> {
        const key = moduleKeyOf(fileKey);
        let bucket = this.datPrivatesByModule.get(key);
        if (!bucket) {
            bucket = new Map<string, KrlValue>();
            this.datPrivatesByModule.set(key, bucket);
        }
        return bucket;
    }

    // ------------------------------------------------------------------
    // breakpoints

    /**
     * Set the breakpoints of a file by client (1-based) line numbers, replacing
     * previous ones. Lines without a statement move to the next statement.
     */
    setBreakpoints(sourcePath: string, clientLines: number[]): { verified: boolean; line: number }[] {
        const key = keyOf(sourcePath);
        const set = new Set<number>();
        this.breakpoints.set(key, set);
        const prog = this.programs.get(key);
        return clientLines.map(line => {
            if (!prog) { return { verified: false, line }; }
            for (let l = Math.max(0, line - 1); l < prog.lineToIndex.length && l < line + 50; l++) {
                let idx = prog.lineToIndex[l];
                if (idx < 0) { continue; }
                const kind = prog.stmts[idx].kind;
                if (kind === 'defdat' || kind === 'enddat') { break; }
                // a breakpoint on DEF / ELSE / CASE / DEFAULT stops at the first statement of the block
                if (kind === 'prog' || kind === 'fct' || kind === 'else' || kind === 'case' || kind === 'default') { idx++; }
                const stmt = prog.stmts[idx];
                if (!stmt) { break; }
                set.add(idx);
                return { verified: true, line: stmt.line + 1 };
            }
            return { verified: false, line };
        });
    }

    clearBreakpoints(sourcePath: string): void {
        this.breakpoints.delete(keyOf(sourcePath));
    }

    // ------------------------------------------------------------------
    // execution driver

    pause(): void {
        this.stopRequested = true;
    }

    isRunning(): boolean {
        return this.running;
    }

    isFinished(): boolean {
        return this.threads.every(t => t.finished);
    }

    /**
     * Run until a stop condition is reached. All threads keep running in every
     * mode (the submit interpreter does not stop while the robot program is
     * stepped); for stepping, `threadId` selects the thread whose progress ends
     * the step. Breakpoints and HALT stop any thread that arrives at them.
     */
    async run(mode: RunMode, threadId?: number): Promise<StopInfo> {
        if (this.running) { return { reason: 'busy', message: 'the program is already running' }; }
        this.running = true;
        this.stopRequested = false;
        this.lastError = null;
        this.handles.clear();
        const target = mode === 'continue' ? undefined : (this.threadById(threadId) ?? this.firstAlive());
        const startDepth = target ? target.stack.length : 0;
        let sliceStart = Date.now();
        let sinceYield = 0;
        // simulated time stood still while the program was stopped
        this.paceClock = this.clockMs;
        this.paceWall = performance.now();
        try {
            if (target && (target.stopped || target.finished)) {
                this.onOutput(`[krl] ${target.name} is ${target.stopped ? 'stopped; start it' : 'ended; restart it'} (right-click its thread in the Call Stack) to step it`);
                return { reason: 'step', threadId: target.id };
            }
            if (!this.started) {
                this.started = true;
                if (mode === 'continue' && !this.opts.stopOnEntry) {
                    for (const t of this.threads) {
                        const stop = this.stopAtArrival(t);
                        if (stop) { return stop; }
                    }
                }
            }
            for (;;) {
                if (this.stopRequested) {
                    return { reason: 'pause', threadId: (target && !target.finished ? target : this.firstAlive())?.id };
                }
                if (this.threads.length === 0 || this.isFinished()) { return { reason: 'end' }; }

                const t = this.threads[this.rrIndex];
                this.rrIndex = (this.rrIndex + 1) % this.threads.length;
                let ticked: 'progress' | 'blocked' | null = null;
                if (!t.finished && !t.stopped) {
                    try {
                        ticked = this.tick(t);
                    } catch (e) {
                        if (!(e instanceof KrlStopError)) { throw e; }
                        // the controller stops the program at this statement; it runs again on continue
                        return this.stopOnError(t, e);
                    }
                }
                if (ticked === 'progress') {
                    this.roundProgress = true;
                    this.stepsExecuted++;
                    if (this.maxSteps > 0 && this.stepsExecuted > this.maxSteps) {
                        this.onOutput(`[krl] instruction limit of ${this.maxSteps} reached`);
                        return { reason: 'error', message: 'instruction limit reached' };
                    }
                    if (t.finished) {
                        this.opts.onThreadExit?.(t.id);
                    } else {
                        const stop = this.stopAtArrival(t);
                        if (stop) { return stop; }
                        if (t === target) {
                            const depth = t.stack.length;
                            if (mode === 'stepIn'
                                || (mode === 'stepOver' && depth <= startDepth)
                                || (mode === 'stepOut' && depth < startDepth)) {
                                return { reason: 'step', threadId: t.id };
                            }
                        }
                    }
                }

                if (this.rrIndex === 0) {
                    // a full round: every thread had the chance to execute one statement
                    const idle = !this.roundProgress;
                    this.roundProgress = false;
                    if (this.simOverride !== null) {
                        // paced: simulated time follows real time at the simulation override
                        const pause = this.advancePacedClock(idle);
                        if (pause > 0) {
                            await sleep(pause);
                            sliceStart = Date.now();
                        }
                    } else if (!idle) {
                        this.advanceClock(ROUND_MS);
                    } else if (this.advanceIdleClock()) {
                        // every thread waits for a condition: do not spin, give the UI time
                        await sleep(IDLE_SLEEP_MS);
                        sliceStart = Date.now();
                    }
                }
                if (++sinceYield >= 256) {
                    sinceYield = 0;
                    if (Date.now() - sliceStart >= SLICE_MS) {
                        await new Promise<void>(r => setImmediate(r));
                        sliceStart = Date.now();
                    }
                }
            }
        } finally {
            this.running = false;
            this.flushTrace();
        }
    }

    /**
     * Advance the clock while no thread can run. Returns true when a thread
     * waits for a condition (the caller then sleeps for real), false when the
     * clock could jump straight to the end of a WAIT SEC.
     */
    private advanceIdleClock(): boolean {
        // time until the next thread can continue: a WAIT SEC ends or a robot finishes its motion
        let next = Infinity;
        let conditionWait = false;
        for (const t of this.threads) {
            if (t.finished || t.stopped) { continue; }
            if (t.motions.length > 0) { next = Math.min(next, t.motions[0].remaining); }
            if (!t.wait) { continue; }
            if (t.wait.kind === 'sec') { next = Math.min(next, t.wait.until - this.clockMs); } else if (t.wait.kind === 'for') { conditionWait = true; }
        }
        // a program polling for an acknowledgement or an answer waits for the operator, in real time
        if (this.messages.some(m => m.type === 'quit' || m.type === 'dialog' || m.type === 'waiting')) { conditionWait = true; }
        if (!conditionWait && next < Infinity) {
            this.advanceClock(Math.max(0, next));
            return false;
        }
        this.advanceClock(Math.max(0, Math.min(IDLE_TICK_MS, next)));
        return true;
    }

    /**
     * Paced mode: let simulated time catch up with real time times the simulation
     * override, stopping at the next event (end of a WAIT SEC or motion) so the
     * threads see it in order. Returns how long to sleep [ms] when no thread can
     * run before more real time has passed, else 0.
     */
    private advancePacedClock(idle: boolean): number {
        const rate = (this.simOverride ?? 100) / 100;
        const target = this.paceClock + (performance.now() - this.paceWall) * rate;
        const next = this.nextEventMs();
        const until = Math.min(target, next);
        if (until > this.clockMs) { this.advanceClock(until - this.clockMs); }
        if (!idle || this.clockMs < target - CLOCK_EPSILON_MS) { return 0; }
        // nothing to do until the next event (or until a condition changes): sleep, at most IDLE_SLEEP_MS
        const wait = next === Infinity ? IDLE_SLEEP_MS : (next - this.clockMs) / rate;
        return Math.max(1, Math.min(IDLE_SLEEP_MS, wait));
    }

    /** Simulated time of the next WAIT SEC end or motion end, Infinity when none is pending. */
    private nextEventMs(): number {
        let next = Infinity;
        for (const t of this.threads) {
            if (t.finished || t.stopped) { continue; }
            if (t.motions.length > 0) { next = Math.min(next, this.clockMs + t.motions[0].remaining); }
            if (t.wait?.kind === 'sec' && t.wait.until > this.clockMs + CLOCK_EPSILON_MS) { next = Math.min(next, t.wait.until); }
        }
        return next;
    }

    /** Let simulated time pass: the main run of each robot interpreter executes its planned motions. */
    private advanceClock(ms: number): void {
        this.clockMs += ms;
        // override 0 %: the robot stands (the program logic goes on)
        if (this.applyOverride() <= 0) { return; }
        for (const t of this.threads) {
            // a stopped robot program stops the robot, too
            if (t.stopped) { continue; }
            let budget = ms;
            while (t.motions.length > 0) {
                const head = t.motions[0];
                if (head.remaining > budget + CLOCK_EPSILON_MS) {
                    head.remaining -= budget;
                    // the robot is on its way: $POS_ACT / $AXIS_ACT follow it
                    if (head.duration - head.remaining - head.sampledAt >= SAMPLE_MS) { this.sampleMotion(head); }
                    break;
                }
                budget -= head.remaining;
                this.finishMotion(t.motions.shift()!);
                if (t.motions.length > 0) { this.trace(t, t.motions[0].text); }
            }
        }
    }

    /** $ADVANCE, limited to 0..5 like on the controller. */
    private advanceLimit(): number {
        return Math.max(0, Math.min(5, Math.trunc(krlNumber(this.resolveSystemVar('$advance')))));
    }

    /**
     * Whether the statement at `idx` must wait for the main run (advance run stop):
     * WAIT, HALT, I/O and robot state access, or the end of the robot program,
     * unless a CONTINUE in the line before cancels it.
     */
    private needsAdvanceRunStop(thread: KrlThread, prog: KrlProgram, idx: number, stmt: KrlStmt | undefined): boolean {
        if (thread.role !== 'robot' || thread.motions.length === 0 || this.nestedDepth > 0) { return false; }
        const frame = this.top(thread);
        const programEnd = thread.stack.length === 1
            && (!stmt || stmt.kind === 'end' || stmt.kind === 'return' || (!!frame && frame.endIdx >= 0 && idx > frame.endIdx));
        if (programEnd) { return true; }
        if (!stmt || prog.continued.has(idx)) { return false; }
        if (stmt.kind === 'wait' || stmt.kind === 'halt') { return true; }
        let cached = this.advanceStopCache.get(stmt);
        if (cached === undefined) {
            const code = stmt.text.replace(/"[^"]*"/g, '');
            cached = ADVANCE_STOP_STATEMENT.test(code) || ADVANCE_STOP_VARIABLE.test(code)
                // signals are inputs / outputs, too
                || (code.match(/[A-Za-z_][\w$]*/g) ?? []).some(w => !!this.signals.get(w.toLowerCase())?.io);
            this.advanceStopCache.set(stmt, cached);
        }
        return cached;
    }

    /** Give the thread its turn: finish a pending WAIT or execute one statement. */
    private tick(t: KrlThread): 'progress' | 'blocked' {
        if (t.wait) {
            const wait = t.wait;
            const done = wait.kind === 'sec' ? this.clockMs >= wait.until - CLOCK_EPSILON_MS
                : wait.kind === 'for' ? krlBool(evaluateExpression(wait.cond, this.execCtx(t)))
                    : wait.kind === 'advance' ? t.motions.length <= this.advanceLimit()
                        : t.motions.length === 0;
            if (!done) { return 'blocked'; }
            t.wait = null;
            const frame = this.top(t);
            if (wait.kind !== 'mainrun') {
                if (frame) { frame.pc++; }
                this.settle(t);
                return 'progress';
            }
            // advance run stop over: the statement runs now; a HALT is reported first
            const prog = frame ? this.programs.get(frame.progKey) : undefined;
            if (frame && prog?.stmts[frame.pc]?.kind === 'halt') { return 'progress'; }
        }
        if (this.executeOne(t) === 'blocked') { return 'blocked'; }
        this.settle(t);
        return 'progress';
    }

    /**
     * A block that runs into ELSE / CASE / DEFAULT is finished: continue after
     * its ENDIF / ENDSWITCH right away so the current line never shows a branch
     * that is not taken.
     */
    private settle(t: KrlThread): void {
        const frame = this.top(t);
        const prog = frame ? this.programs.get(frame.progKey) : undefined;
        if (!frame || !prog) { return; }
        for (let guard = 0; guard < 1000; guard++) {
            const kind = prog.stmts[frame.pc]?.kind;
            const end = kind === 'else' ? prog.ifAfter.get(frame.pc)
                : (kind === 'case' || kind === 'default') ? prog.caseEnd.get(frame.pc)
                    : undefined;
            if (end === undefined) { return; }
            frame.pc = end + 1;
        }
    }

    /** Breakpoint or HALT at the statement the thread is about to execute. */
    private stopAtArrival(t: KrlThread): StopInfo | null {
        if (t.finished || t.wait) { return null; }
        const frame = this.top(t);
        if (!frame) { return null; }
        if (this.breakpoints.get(frame.progKey)?.has(frame.pc)) { return { reason: 'breakpoint', threadId: t.id }; }
        const prog = this.programs.get(frame.progKey);
        const stmt = prog?.stmts[frame.pc];
        if (prog && stmt?.kind === 'halt' && !this.needsAdvanceRunStop(t, prog, frame.pc, stmt)) { return { reason: 'halt', threadId: t.id }; }
        return null;
    }

    /**
     * Stop, start (resume where it stopped) or restart (from the beginning) one
     * interpreter while the others keep running, like STOP / START of the robot
     * program and the SUBMIT interpreter menu of the controller. Data lists keep
     * their values. Returns an error message, or null.
     */
    controlInterpreter(threadId: number, action: 'stop' | 'start' | 'restart'): string | null {
        const t = this.threadById(threadId);
        if (!t) { return `no interpreter with id ${threadId}`; }
        switch (action) {
            case 'stop':
                if (t.finished) { return `${t.name} has already ended`; }
                t.stopped = true;
                return null;
            case 'start':
                if (t.finished) { return `${t.name} has ended; restart it to run it again`; }
                t.stopped = false;
                return null;
            case 'restart': {
                const func = this.programs.get(t.fileKey)?.moduleRoutine;
                if (!func) { return `${t.name} cannot be restarted`; }
                t.stack = [this.makeFrame(t.fileKey, func, 0, 0)];
                t.wait = null;
                t.motions = [];
                this.removeMessages(m => m.threadId === t.id);
                t.finished = false;
                t.stopped = false;
                return null;
            }
            default:
                return `unknown action ${String(action)}`;
        }
    }

    /** SUB programs that are loaded (callable as subprograms) but not running in a submit interpreter. */
    idleSubmitPrograms(): string[] {
        const running = new Set(this.threads.filter(t => !t.finished).map(t => t.fileKey));
        return [...this.programs.entries()]
            .filter(([key, prog]) => /\.sub$/i.test(prog.path) && !running.has(key))
            .map(([, prog]) => prog.path);
    }

    /**
     * Run a further SUB program in its own submit interpreter while the others keep
     * running. (KSS 8.3 has one submit interpreter; newer versions can run several.)
     * Returns the id of its thread, or an error message.
     */
    startSubmitProgram(file: string): number | string {
        const key = keyOf(file);
        const existing = this.threads.find(t => t.fileKey === key);
        if (existing && !existing.finished) { return `${path.basename(file)} is already running`; }
        if (existing) { return this.controlInterpreter(existing.id, 'restart') ?? existing.id; }
        const errors: string[] = [];
        if (!this.programs.has(key)) {
            // not loaded yet: read it and its data list like at launch
            const dat = siblingDat(file);
            for (const p of dat ? [file, dat] : [file]) {
                const k = keyOf(p);
                if (this.programs.has(k)) { continue; }
                this.readProgram(p, errors);
                const prog = this.programs.get(k);
                if (!prog) { continue; }
                for (const stmt of prog.stmts) {
                    if (stmt.kind === 'struc' || stmt.kind === 'enumdef') { this.registerType(stmt.text); }
                }
                if (/\.dat$/i.test(p)) { this.loadDataList(prog, k, false); } else { this.registerRoutines(k, prog); }
            }
            if (errors.length > 0) { return errors[0]; }
        }
        const thread = this.createThread(Math.max(-1, ...this.threads.map(t => t.id)) + 1, 'submit', file, errors);
        if (!thread) { return errors[0] ?? `cannot start ${path.basename(file)}`; }
        this.threads.push(thread);
        return thread.id;
    }

    private threadById(id: number | undefined): KrlThread | undefined {
        return id === undefined ? undefined : this.threads.find(t => t.id === id);
    }

    private firstAlive(): KrlThread | undefined {
        return this.threads.find(t => !t.finished) ?? this.threads[0];
    }

    // ------------------------------------------------------------------
    // DAP-facing views

    getThreads(): ThreadView[] {
        return this.threads.map(t => ({
            id: t.id,
            name: `${t.role === 'robot' ? 'Robot' : 'Submit'}: ${t.name}${t.stopped ? ' (stopped)' : t.finished ? ' (ended)' : ''}`,
            file: t.file,
            finished: t.finished,
            stopped: t.stopped,
            line: this.currentLine(t),
        }));
    }

    getStackTrace(threadId: number): StackFrameView[] {
        const t = this.threadById(threadId);
        if (!t) { return []; }
        const out: StackFrameView[] = [];
        for (let i = t.stack.length - 1; i >= 0; i--) {
            const frame = t.stack[i];
            const prog = this.programs.get(frame.progKey);
            const stmt = prog ? prog.stmts[frame.pc] : undefined;
            out.push({
                frameId: this.registerHandle({ kind: 'frame', threadId, frameIndex: i }),
                threadId,
                name: frame.functionName,
                file: prog ? prog.path : frame.progKey,
                line: stmt ? stmt.line : 0,
            });
        }
        return out;
    }

    /** Scopes for a frame handle grouped by KRL storage class; system variables come last. */
    getScopes(frameId: number): { name: string; ref: number }[] {
        const handle = this.handles.get(frameId);
        if (!handle || handle.kind !== 'frame') { return []; }
        const at = { threadId: handle.threadId, frameIndex: handle.frameIndex };
        return [
            { name: 'Runtime Variables',     ref: this.registerHandle({ kind: 'runtime', ...at }) },
            { name: 'DAT Private Variables', ref: this.registerHandle({ kind: 'datPrivate', ...at }) },
            { name: 'DAT Global Variables',  ref: this.registerHandle({ kind: 'datGlobal', ...at }) },
            { name: '$CONFIG.DAT Globals',   ref: this.registerHandle({ kind: 'configGlobal', ...at }) },
            { name: 'System Variables',      ref: this.registerHandle({ kind: 'system', ...at }) },
        ];
    }

    getVariables(ref: number, start?: number, count?: number): VariableEntry[] {
        const handle = this.handles.get(ref);
        if (!handle) { return []; }
        switch (handle.kind) {
            case 'runtime': {
                const frame = this.frameOf(handle);
                if (!frame) { return []; }
                const merged = new Map<string, KrlValue>([...frame.params, ...frame.locals]);
                return this.collectVars(merged);
            }
            case 'datPrivate': {
                const frame = this.frameOf(handle);
                if (!frame) { return []; }
                const key = moduleKeyOf(frame.progKey);
                return this.collectVars(this.datPrivatesByModule.get(key) ?? new Map(), key);
            }
            case 'datGlobal': return this.collectVars(this.datGlobals, 'global');
            case 'configGlobal': return this.collectVars(this.configGlobals, 'config');
            case 'system': return this.collectSystemVars();
            case 'value': return handle.value ? this.collectChildren(handle.value, handle.sysPath, handle.path, start, count) : [];
            default: return [];
        }
    }

    private frameOf(handle: FrameHandle): KrlCallFrame | undefined {
        return this.threadById(handle.threadId)?.stack[handle.frameIndex ?? 0];
    }

    private collectVars(map: Map<string, KrlValue>, signalScope?: string): VariableEntry[] {
        const out: VariableEntry[] = [];
        for (const [k, v] of map) {
            const name = this.displayName(k);
            out.push(this.makeVariable(name, v, undefined, name));
        }
        if (signalScope) {
            for (const sig of this.signals.values()) {
                if (sig.scope === signalScope && !map.has(sig.name)) {
                    const name = this.displayName(sig.name);
                    out.push(this.makeVariable(name, this.readSignal(sig), undefined, name));
                }
            }
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    private collectChildren(value: KrlValue, sysPath: string | undefined, path: string | undefined, start = 0, count?: number): VariableEntry[] {
        const out: VariableEntry[] = [];
        if (value.t === 'struct') {
            for (const [k, v] of value.v) {
                const name = k.toUpperCase();
                // components of positions with their unit, Status and Turn decoded
                out.push(this.makeVariable(name, v,
                    sysPath !== undefined ? `${sysPath}.${name}` : undefined,
                    path !== undefined ? `${path}.${name}` : undefined,
                    componentText(value.v, k, v) ?? undefined));
            }
        } else if (value.t === 'array') {
            const end = Math.min(value.v.length, count !== undefined && count > 0 ? start + count : value.v.length);
            for (let i = Math.max(0, start); i < end; i++) {
                const name = `[${i + 1}]`;
                out.push(this.makeVariable(name, value.v[i],
                    sysPath !== undefined ? `${sysPath}${name}` : undefined,
                    path !== undefined ? elementPath(path, i + 1) : undefined));
            }
        }
        return out;
    }

    private collectSystemVars(): VariableEntry[] {
        const out: VariableEntry[] = [];
        for (const name of SYSTEM_SCOPE_VARIABLES) {
            const value = this.resolveSystemVar(name.toLowerCase());
            if (value) { out.push(this.makeVariable(name, value, name)); }
        }
        const listed = new Set(SYSTEM_SCOPE_VARIABLES.map(n => n.toLowerCase()));
        const extra = [...this.systemVars.keys()].filter(k => !listed.has(k)).sort();
        for (const key of extra) {
            const name = key.toUpperCase();
            out.push(this.makeVariable(name, this.systemVars.get(key)!, name));
        }
        return out;
    }

    private makeVariable(name: string, v: KrlValue, sysPath?: string, path = sysPath, display?: string): VariableEntry {
        const entry: VariableEntry = { name, type: typeLabel(v), value: display ?? displayValue(v), reference: 0 };
        if (path !== undefined) { entry.evaluateName = path; }
        if ((v.t === 'struct' && v.v.size > 0) || (v.t === 'array' && v.v.length > 0 && !isCharArray(v))) {
            entry.reference = this.registerHandle({ kind: 'value', value: v, sysPath, path });
            if (v.t === 'array') { entry.indexedVariables = v.v.length; }
        }
        return entry;
    }

    private displayName(key: string): string {
        return this.displayNames.get(key) ?? key;
    }

    private registerHandle(handle: FrameHandle): number {
        const id = this.nextHandle++;
        this.handles.set(id, handle);
        return id;
    }

    /** The last error that stopped the programs (for the exception widget), null after the next run. */
    getLastError(): KrlRuntimeErrorInfo | null {
        return this.lastError;
    }

    private stopOnError(t: KrlThread, e: KrlStopError): StopInfo {
        const frame = this.top(t);
        const file = frame ? this.programs.get(frame.progKey)?.path ?? frame.progKey : t.file;
        const line = this.currentLine(t);
        const message = e.where ? `${e.message} (in ${e.where})` : e.message;
        this.lastError = { threadId: t.id, kind: e.read?.kind ?? 'error', message, file, line };
        this.onOutput(`[${t.name}] ${path.basename(file)}:${line + 1}: ${message}`);
        return { reason: 'exception', threadId: t.id, message };
    }

    /**
     * Context for the statements the programs execute: reading a name that is not
     * declared, a variable without value or an element outside its array stops the
     * program like on the controller. System variables always have a value there.
     */
    private execCtx(thread: KrlThread, allowUnassigned = false): EvalContext {
        return {
            ...this.ctxFor(thread),
            invalidRead: (read: InvalidRead) => {
                if (read.path.startsWith('$') || (allowUnassigned && read.kind === 'uninitialized')) { return; }
                throw new KrlStopError(invalidReadMessage(read), read);
            },
        };
    }

    private currentLine(t: KrlThread): number {
        const frame = t.stack[t.stack.length - 1];
        if (!frame) { return 0; }
        const stmt = this.programs.get(frame.progKey)?.stmts[frame.pc];
        return stmt ? stmt.line : 0;
    }

    /** Thread as seen from one of its stack frames (for evaluation in that frame). */
    private threadAtFrame(handle: FrameHandle | undefined): KrlThread | undefined {
        const thread = this.threadById(handle?.threadId) ?? this.firstAlive();
        if (!thread) { return undefined; }
        if (handle?.frameIndex === undefined || handle.frameIndex >= thread.stack.length - 1) { return thread; }
        return { ...thread, stack: thread.stack.slice(0, handle.frameIndex + 1) };
    }

    /** Evaluate a KRL expression in the context of the frame identified by a handle.
     *  Returns the display string, or an empty string if evaluation fails. */
    evaluate(expression: string, frameId: number): string {
        const result = this.evaluateForDebugger(expression, frameId, false);
        return result ? result.value : '';
    }

    /**
     * Evaluate for the debug console / hovers. With `allowAssign`, `x = expr`
     * assigns (e.g. `$IN[5] = TRUE` to feed an input to a waiting program).
     */
    evaluateForDebugger(expression: string, frameId: number | undefined, allowAssign: boolean): VariableEntry | null {
        const handle = frameId !== undefined ? this.handles.get(frameId) : undefined;
        const thread = this.threadAtFrame(handle && handle.kind === 'frame' ? handle : undefined);
        if (!thread) { return null; }
        try {
            const eq = allowAssign ? findSingleEq(expression) : -1;
            if (eq > 0) {
                const lhs = expression.slice(0, eq).trim();
                const value = evaluateExpression(expression.slice(eq + 1), this.ctxFor(thread));
                if (value.t === 'undef' || !parseLValue(lhs)) { return null; }
                this.setVariablePath(thread, lhs, value);
                expression = lhs;
            }
            const val = evaluateExpression(expression, this.ctxFor(thread));
            if (val.t === 'undef') { return null; }
            const expr = expression.trim();
            return this.makeVariable(expr, val, expr.startsWith('$') ? expr : undefined, parseLValue(expr) ? expr : undefined);
        } catch {
            return null;
        }
    }

    /**
     * Every variable of every scope with its structure members and the elements
     * of small arrays, for the variable search (also while the program runs).
     * Positions are not split into their components (their value shows them), and
     * module data lists, mostly taught points, come last in case the list is cut.
     */
    listVariables(): VariableSearchEntry[] {
        const out: VariableSearchEntry[] = [];
        const add = (expression: string, v: KrlValue, scope: string, depth: number): void => {
            if (out.length >= SEARCH_MAX_ENTRIES) { return; }
            out.push({ expression, value: displayValue(v), type: typeLabel(v), scope });
            if (depth >= SEARCH_DEPTH) { return; }
            if (v.t === 'struct' && !isPositionType(v.name)) {
                for (const [k, x] of v.v) { add(`${expression}.${k.toUpperCase()}`, x, scope, depth + 1); }
            } else if (v.t === 'array' && v.v.length <= SEARCH_ARRAY_LIMIT && !isCharArray(v)) {
                v.v.forEach((x, i) => add(elementPath(expression, i + 1), x, scope, depth + 1));
            }
        };
        const addMap = (map: Map<string, KrlValue>, scope: string, signalScope?: string): void => {
            for (const [k, v] of map) { add(this.displayName(k), v, scope, 0); }
            for (const sig of this.signals.values()) {
                if (signalScope !== undefined && sig.scope === signalScope && !map.has(sig.name)) {
                    add(this.displayName(sig.name), this.readSignal(sig), scope, 0);
                }
            }
        };
        for (const t of this.threads) {
            const role = t.role === 'robot' ? 'Robot' : 'Submit';
            for (let i = t.stack.length - 1; i >= 0; i--) {
                const frame = t.stack[i];
                addMap(new Map([...frame.params, ...frame.locals]), `Runtime ${frame.functionName} (${role})`);
            }
        }
        addMap(this.datGlobals, 'DAT Global', 'global');
        addMap(this.configGlobals, '$CONFIG.DAT', 'config');
        const listed = new Set(SYSTEM_SCOPE_VARIABLES.map(n => n.toLowerCase()));
        for (const name of SYSTEM_SCOPE_VARIABLES) {
            const value = this.resolveSystemVar(name.toLowerCase());
            if (value) { add(name, value, 'System', 0); }
        }
        for (const key of [...this.systemVars.keys()].filter(k => !listed.has(k)).sort()) {
            add(key.toUpperCase(), this.systemVars.get(key)!, 'System', 0);
        }
        for (const [key, map] of this.datPrivatesByModule) {
            addMap(map, `DAT ${path.basename(key).toUpperCase()}`, key);
        }
        return out;
    }

    /**
     * Current value of an expression for the live watch, also while the program runs:
     * evaluated in the top frame of the first thread whose scope knows its names.
     */
    peek(expression: string): VariableEntry | null {
        for (const t of this.threads) {
            try {
                const val = evaluateExpression(expression, this.ctxFor(t));
                if (val.t !== 'undef') { return { name: expression, type: typeLabel(val), value: displayValue(val), reference: 0 }; }
            } catch {
                // try the next thread
            }
        }
        return null;
    }

    /** Change a variable from the Variables view. Returns the new entry or an error message. */
    setVariable(ref: number, name: string, valueText: string): VariableEntry | string {
        const handle = this.handles.get(ref);
        if (!handle) { return 'variable is no longer available'; }
        const thread = this.threadAtFrame(handle.kind === 'value' ? undefined : handle);
        if (!thread) { return 'no thread'; }
        // the value as it was shown: "X: 450.0 mm, ..." or "-90.0°"
        const value = evaluateExpression(normalizeEditedValue(valueText), this.ctxFor(thread));
        if (value.t === 'undef') { return `cannot evaluate '${valueText}'`; }
        const key = name.toLowerCase();
        const setIn = (map: Map<string, KrlValue>): KrlValue | null => {
            if (!map.has(key)) { return null; }
            const v = storeValue(map.get(key), value);
            map.set(key, v);
            return v;
        };
        let result: KrlValue | null = null;
        let resultPath: string | undefined;
        switch (handle.kind) {
            case 'runtime': {
                const frame = this.frameOf(handle);
                if (frame) { result = setIn(frame.locals) ?? setIn(frame.params); }
                break;
            }
            case 'datPrivate': {
                const frame = this.frameOf(handle);
                if (frame) { result = setIn(this.datPrivate(frame.progKey)); }
                break;
            }
            case 'datGlobal': case 'configGlobal': {
                result = setIn(handle.kind === 'datGlobal' ? this.datGlobals : this.configGlobals);
                const sig = this.signals.get(key);
                if (!result && sig) { this.writeSignal(sig, value); result = this.readSignal(sig); }
                break;
            }
            case 'system':
                this.setVariablePath(thread, name, value);
                result = this.resolveSystemVar(key);
                resultPath = name;
                break;
            case 'value': {
                const parent = handle.value;
                const childPath = name.startsWith('[') ? name : `.${name}`;
                if (handle.sysPath !== undefined) {
                    resultPath = handle.sysPath + childPath;
                    this.setVariablePath(thread, resultPath, value);
                    result = evaluateExpression(resultPath, this.ctxFor(thread));
                } else if (parent?.t === 'struct' && parent.v.has(key)) {
                    parent.v.set(key, storeValue(parent.v.get(key), value));
                    result = parent.v.get(key) ?? null;
                } else if (parent?.t === 'array') {
                    const i = parseInt(name.replace(/[[\]]/g, ''), 10) - 1;
                    if (i >= 0 && i < parent.v.length) {
                        parent.v[i] = storeValue(parent.v[i], value);
                        result = parent.v[i];
                    }
                }
                break;
            }
            default: break;
        }
        if (!result) { return `cannot set '${name}'`; }
        return this.makeVariable(name, result, resultPath);
    }

    // ------------------------------------------------------------------
    // statement execution

    private executeOne(thread: KrlThread): 'ok' | 'finished' | 'blocked' {
        const frame = this.top(thread);
        if (!frame) { thread.finished = true; return 'finished'; }
        const prog = this.programs.get(frame.progKey);
        if (!prog) { thread.finished = true; return 'finished'; }
        const stmt = prog.stmts[frame.pc];
        if (this.needsAdvanceRunStop(thread, prog, frame.pc, stmt)) {
            thread.wait = { kind: 'mainrun' };
            return 'blocked';
        }
        if (!stmt || (frame.endIdx >= 0 && frame.pc > frame.endIdx)) {
            // ran past the end of the routine
            return this.popFrame(thread);
        }
        if (!prog.errorProceed.has(frame.pc)) { return this.execStmt(thread, prog, frame, stmt); }
        // ON_ERROR_PROCEED: the error goes to $ERR and the program goes on with the next statement
        const pc = frame.pc;
        this.setErr(0, 0);
        try {
            return this.execStmt(thread, prog, frame, stmt);
        } catch (e) {
            if (!(e instanceof KrlStopError) || !SKIPPABLE_ON_ERROR.has(stmt.kind)) { throw e; }
            this.setErr(ERR_VALUE_INVALID, stmt.line + 1);
            frame.pc = pc + 1;
            return 'ok';
        }
    }

    /** $ERR after a statement with ON_ERROR_PROCEED: NUMBER 0 when it ran without error. */
    private setErr(number: number, line: number): void {
        const err = this.resolveSystemVar('$err');
        if (err?.t !== 'struct') { return; }
        for (const [k, v] of [['number', number], ['line', line]] as const) {
            err.v.set(k, storeValue(err.v.get(k), KRL_INT(v)));
        }
    }

    /** Pop the frame, write back OUT parameters and resume the caller (or finish the thread). */
    private popFrame(thread: KrlThread): 'ok' | 'finished' {
        const frame = thread.stack.pop();
        const caller = thread.stack[thread.stack.length - 1];
        if (!frame || !caller) {
            thread.finished = true;
            thread.wait = null;
            return 'finished';
        }
        for (const b of frame.outBindings) {
            const v = frame.params.get(b.param);
            // a parameter bound to the caller's variable already changed it in place;
            // writing it back would undo changes the other threads made meanwhile
            if (v && v !== evaluateExpression(b.target, this.ctxFor(thread))) { this.setVariablePath(thread, b.target, v); }
        }
        if (frame.returnPc >= 0) { caller.pc = frame.returnPc; }
        return 'ok';
    }

    private ctxFor(thread: KrlThread): EvalContext {
        return {
            resolveName: (name: string) => this.resolveName(thread, name),
            invokeFunction: (name: string, args: KrlValue[]) => this.invokeFunction(thread, name, args),
        };
    }

    /** Evaluate for the program: stops at undeclared names and variables without value. */
    private eval(thread: KrlThread, text: string): KrlValue {
        return evaluateExpression(text, this.execCtx(thread));
    }

    /**
     * Evaluate a routine argument: a variable passed whole may have no value yet
     * (an OUT parameter gets it in the routine; reading it there stops the program).
     */
    private evalArgument(thread: KrlThread, text: string): KrlValue {
        return evaluateExpression(text, this.execCtx(thread, !!parseLValue(text)));
    }

    private execStmt(thread: KrlThread, prog: KrlProgram, frame: KrlCallFrame, stmt: KrlStmt): 'ok' | 'finished' | 'blocked' {
        switch (stmt.kind) {
            case 'prog': case 'fct': case 'defdat': {
                // definition reached without being called -> skip its body
                const endIdx = prog.fctEnd.get(frame.pc);
                frame.pc = endIdx !== undefined ? endIdx + 1 : frame.pc + 1;
                return 'ok';
            }
            case 'end': case 'endfct': case 'enddat':
                return this.popFrame(thread);
            case 'if': {
                const m = stmt.text.match(/^IF\b\s*(.*?)\s*THEN\b/i);
                const condText = m && m[1].trim() ? m[1] : stmt.text.replace(/^IF\b/i, '');
                if (krlBool(this.eval(thread, condText))) {
                    frame.pc++;
                } else {
                    const elseIdx = prog.ifFalseToElse.get(frame.pc);
                    const after = prog.ifAfter.get(frame.pc) ?? frame.pc;
                    frame.pc = elseIdx !== undefined ? elseIdx + 1 : after + 1;
                }
                return 'ok';
            }
            case 'else':
                frame.pc = (prog.ifAfter.get(frame.pc) ?? frame.pc) + 1;
                return 'ok';
            case 'for': {
                const m = stmt.text.match(/^FOR\s+([A-Z_$][\w$]*)\s*=\s*(.+?)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i);
                if (!m) { frame.pc++; return 'ok'; }
                const start = Math.trunc(krlNumber(this.eval(thread, m[2])));
                const end = Math.trunc(krlNumber(this.eval(thread, m[3])));
                const step = m[4] ? Math.trunc(krlNumber(this.eval(thread, m[4]))) || 1 : 1;
                this.setVariablePath(thread, m[1], KRL_INT(start), true);
                if (step > 0 ? start > end : start < end) {
                    frame.forLoops.delete(frame.pc);
                    frame.pc = (prog.forEnd.get(frame.pc) ?? frame.pc) + 1;
                } else {
                    frame.forLoops.set(frame.pc, { varName: m[1], end, step });
                    frame.pc++;
                }
                return 'ok';
            }
            case 'endfor': {
                const forIdx = prog.forStart.get(frame.pc);
                const loop = forIdx !== undefined ? frame.forLoops.get(forIdx) : undefined;
                if (forIdx === undefined || !loop) { frame.pc++; return 'ok'; }
                const next = Math.trunc(krlNumber(this.resolveName(thread, loop.varName))) + loop.step;
                this.setVariablePath(thread, loop.varName, KRL_INT(next));
                if (loop.step > 0 ? next <= loop.end : next >= loop.end) {
                    frame.pc = forIdx + 1;
                } else {
                    frame.forLoops.delete(forIdx);
                    frame.pc++;
                }
                return 'ok';
            }
            case 'while': {
                const condText = stmt.text.replace(/^WHILE\b/i, '');
                if (krlBool(this.eval(thread, condText))) {
                    frame.pc++;
                } else {
                    frame.pc = (prog.whileEnd.get(frame.pc) ?? frame.pc) + 1;
                }
                return 'ok';
            }
            case 'endwhile':
                frame.pc = prog.whileStart.get(frame.pc) ?? frame.pc + 1;
                return 'ok';
            case 'loop': case 'repeat':
                frame.pc++;
                return 'ok';
            case 'endloop':
                frame.pc = prog.loopStart.get(frame.pc) ?? frame.pc + 1;
                return 'ok';
            case 'until': {
                const condText = stmt.text.replace(/^UNTIL\b/i, '');
                if (krlBool(this.eval(thread, condText))) {
                    frame.pc++;
                } else {
                    const repeatIdx = prog.untilRepeat.get(frame.pc);
                    frame.pc = repeatIdx !== undefined ? repeatIdx + 1 : frame.pc + 1;
                }
                return 'ok';
            }
            case 'exit': {
                const end = prog.exitTarget.get(frame.pc);
                if (end === undefined) { frame.pc++; return 'ok'; }
                const forIdx = prog.forStart.get(end);
                if (forIdx !== undefined) { frame.forLoops.delete(forIdx); }
                frame.pc = end + 1;
                return 'ok';
            }
            case 'goto': {
                const label = stmt.text.replace(/^GOTO\s+/i, '').trim().toLowerCase();
                const idx = prog.labels.get(`${frame.startIdx}:${label}`);
                if (idx === undefined) {
                    this.warnOnce(`goto:${label}`, `[${thread.name}] GOTO to unknown label ${label.toUpperCase()}`);
                    frame.pc++;
                } else {
                    frame.pc = idx + 1;
                }
                return 'ok';
            }
            case 'switch': {
                const switchValue = this.eval(thread, stmt.text.replace(/^SWITCH\b/i, ''));
                const cases = prog.switchCases.get(frame.pc) ?? [];
                const defIdx = prog.switchDefault.get(frame.pc);
                const after = prog.switchEnd.get(frame.pc) ?? frame.pc;
                const matched = cases.find(c => c.values.some(v => valuesEqual(switchValue, this.eval(thread, v))));
                frame.pc = matched ? matched.caseIdx + 1 : (defIdx !== undefined ? defIdx + 1 : after + 1);
                return 'ok';
            }
            case 'case': case 'default':
                // the previous block ends here: continue after ENDSWITCH
                frame.pc = (prog.caseEnd.get(frame.pc) ?? frame.pc) + 1;
                return 'ok';
            case 'decl':
                this.executeDecl(stmt.text, thread, { frame });
                frame.pc++;
                return 'ok';
            case 'struc': case 'enumdef':
                this.registerType(stmt.text);
                frame.pc++;
                return 'ok';
            case 'signal':
                this.registerSignal(stmt.text, 'global');
                frame.pc++;
                return 'ok';
            case 'assign':
                this.executeAssign(thread, stmt.text);
                frame.pc++;
                return 'ok';
            case 'call':
                return this.executeCall(thread, frame, stmt);
            case 'return': {
                const rest = stmt.text.replace(/^RETURN\b/i, '').trim();
                frame.returnValue = rest ? this.eval(thread, rest) : null;
                return this.popFrame(thread);
            }
            case 'motion': {
                if (thread.role !== 'robot') {
                    this.warnOnce(`motion:${thread.id}`, `[${thread.name}] robot motions are not possible in a submit program (skipped): ${stmt.text}`);
                    frame.pc++;
                    return 'ok';
                }
                // the advance run plans the motion; the main run executes it as time passes
                const motion = this.planMotion(thread, frame, stmt);
                const last = thread.motions[thread.motions.length - 1];
                if (this.nestedDepth === 0 && last && isSamePoint(last, motion)) {
                    // the point the robot is already moving to: advance run stop (KSS), the robot stops exactly
                    // there (approximation not possible); the motion is planned when the robot has arrived
                    const file = path.basename(this.programs.get(frame.progKey)?.path ?? frame.progKey);
                    this.warnOnce(`same:${frame.progKey}:${stmt.line}`, `[${thread.name}] ${file}:${stmt.line + 1}: ${stmt.text} goes to the point of the motion before: advance run stop${last.approximated ? ' (approximation not possible)' : ''}`);
                    this.stopApproximation(last);
                    thread.wait = { kind: 'mainrun' };
                    return 'blocked';
                }
                thread.motions.push(motion);
                if (thread.motions.length === 1) { this.trace(thread, stmt.text); }
                if (this.nestedDepth === 0 && thread.motions.length > this.advanceLimit()) {
                    thread.wait = { kind: 'advance' };
                    return 'blocked';
                }
                frame.pc++;
                return 'ok';
            }
            case 'wait':
                return this.executeWait(thread, frame, stmt);
            case 'label': case 'halt': case 'endif': case 'endswitch': case 'other':
            default:
                frame.pc++;
                return 'ok';
        }
    }

    /** An assignment; `strict` (statements of a program): undeclared names and values that are missing stop it. */
    private executeAssign(thread: KrlThread, text: string, strict = true): void {
        const eq = findSingleEq(text);
        if (eq < 0) { return; }
        const rhs = text.slice(eq + 1);
        const lhs = text.slice(0, eq).trim();
        let value = strict ? this.eval(thread, rhs) : evaluateExpression(rhs, this.ctxFor(thread));
        if (value.t === 'undef' && value.type === NOT_SIMULATED) {
            // the result of a function the simulator does not have: a neutral value, so reading it does not stop
            const old = evaluateExpression(lhs, this.ctxFor(thread));
            value = old.t === 'undef' && old.type && /^(?:INT|REAL|BOOL|CHAR)$/.test(old.type) ? defaultValue(old.type) : old;
        }
        this.setVariablePath(thread, lhs, value, strict);
    }

    private executeWait(thread: KrlThread, frame: KrlCallFrame, stmt: KrlStmt): 'ok' | 'blocked' {
        const forM = stmt.text.match(/^WAIT\s+FOR\s+(.+)$/i);
        if (forM) {
            // inside functions evaluated by an expression a WAIT cannot block
            if (this.nestedDepth > 0 || krlBool(this.eval(thread, forM[1]))) { frame.pc++; return 'ok'; }
            this.trace(thread, `${stmt.text}  (waiting)`);
            thread.wait = { kind: 'for', cond: forM[1] };
            return 'blocked';
        }
        const secM = stmt.text.match(/^WAIT\s+SEC\s+(.+)$/i);
        if (secM) {
            const ms = krlNumber(this.eval(thread, secM[1])) * 1000;
            this.trace(thread, stmt.text);
            if (ms <= 0) { frame.pc++; return 'ok'; }
            if (this.nestedDepth > 0) { this.advanceClock(ms); frame.pc++; return 'ok'; }
            thread.wait = { kind: 'sec', until: this.clockMs + ms };
            return 'blocked';
        }
        frame.pc++;
        return 'ok';
    }

    private executeCall(thread: KrlThread, frame: KrlCallFrame, stmt: KrlStmt): 'ok' {
        const open = stmt.text.indexOf('(');
        const close = findClosing(stmt.text, open);
        const name = stmt.text.slice(0, open).trim();
        const inner = close > open ? stmt.text.slice(open + 1, close) : stmt.text.slice(open + 1);
        let argTexts = splitTopLevel(inner, ',').map(s => s.trim());
        if (argTexts.length === 1 && argTexts[0] === '') { argTexts = []; }

        const routine = this.resolveRoutine(frame.progKey, name);
        if (!routine || routine.func.kind === 'fct') {
            const args = argTexts.map(a => (a ? this.evalArgument(thread, a) : KRL_UNDEF()));
            if (routine) {
                this.runNestedFunction(thread, routine.key, routine.func, args);
            } else if (this.runBuiltin(thread, name.toLowerCase(), args) === null && !NOOP_PROCEDURES.has(name.toLowerCase())) {
                this.warnOnce(`call:${name.toLowerCase()}`, `[${thread.name}] call to unknown routine ${name} (skipped)`);
                this.neutralizeArguments(args);
            }
            frame.pc++;
            return 'ok';
        }

        const callee = this.makeFrame(routine.key, routine.func, frame.pc + 1, stmt.line);
        routine.func.params.forEach((p, i) => {
            const text = argTexts[i];
            if (!text) { return; }
            const value = this.evalArgument(thread, text);
            if (p.dir === 'IN') {
                callee.params.set(p.name, cloneValue(value));
                callee.inParams.add(p.name);
            } else {
                // call by reference (OUT, the default): the parameter is the caller's variable itself;
                // arguments that are not stored yet (undeclared names) are written back on return
                callee.params.set(p.name, value);
                if (parseLValue(text)) { callee.outBindings.push({ param: p.name, target: text }); }
            }
        });
        thread.stack.push(callee);
        return 'ok';
    }

    /**
     * Plan a motion in the advance run: its end position, evaluated now (relative
     * motions start where the motions planned before end), and how long the robot
     * needs for it: velocity profile from the robot's characteristics, $VEL, $ACC,
     * $VEL_AXIS, $ACC_AXIS and $OV_PRO (see krlMotion).
     */
    private planMotion(thread: KrlThread, frame: KrlCallFrame, stmt: KrlStmt): PlannedMotion {
        const before = thread.motions[thread.motions.length - 1];
        const motion: PlannedMotion = {
            progKey: frame.progKey, line: stmt.line, text: stmt.text, sysKey: null, start: new Map(), target: new Map(),
            duration: MIN_MOTION_MS, remaining: MIN_MOTION_MS, timing: null, arc: null, startPose: null, endPose: null, approximated: false, sampledAt: 0,
        };
        const m = stmt.text.match(/^(S?PTP|S?LIN|S?CIRC)(_REL)?\s+(.+)$/i);
        if (!m) { return motion; }
        const kind = m[1].toUpperCase().replace(/^S/, '') as MotionKind;
        let rest = m[3];
        const withIdx = rest.search(/\sWITH\s/i);
        if (withIdx >= 0) { rest = rest.slice(0, withIdx); }
        motion.approximated = /\sC_(?:PTP|DIS|VEL|ORI|SPL)\b/i.test(rest);
        rest = rest.replace(/\s+C_(?:PTP|DIS|VEL|ORI|SPL)\b.*$/i, '');
        const all = splitTopLevel(rest, ',').map(p => p.trim()).filter(p => p);
        const caText = all.find(p => /^CA\b/i.test(p));
        const parts = all.filter(p => !/^CA\b/i.test(p));
        const targetText = kind === 'CIRC' ? parts[parts.length - 1] : parts[0];
        if (!targetText) { return motion; }
        const target = this.eval(thread, targetText);
        if (target.t !== 'struct') { return motion; }
        const sysKey = target.v.has('a1') ? '$axis_act' : (target.v.has('x') || target.v.has('y') || target.v.has('z')) ? '$pos_act' : null;
        const act = sysKey ? this.resolveSystemVar(sysKey) : null;
        if (!sysKey || !act || act.t !== 'struct') { return motion; }
        const startOf = (k: string): number => {
            for (let i = thread.motions.length - 1; i >= 0; i--) {
                const planned = thread.motions[i];
                if (planned.sysKey === sysKey && planned.target.has(k)) { return planned.target.get(k)!; }
                // axes at the end of a Cartesian motion: estimated
                const axis = sysKey === '$axis_act' && planned.endPose ? AXIS_KEYS.indexOf(k) : -1;
                if (axis >= 0) { return planned.endPose!.axes[axis]; }
            }
            return krlNumber(act.v.get(k));
        };
        for (const [k, v] of target.v) {
            if (!act.v.has(k) || (v.t !== 'int' && v.t !== 'real')) { continue; }
            const from = startOf(k);
            motion.start.set(k, from);
            motion.target.set(k, m[2] && k !== 's' && k !== 't' ? from + v.v : v.v);
        }
        motion.sysKey = sysKey;

        // where the robot starts and ends: exact for the moved variable, estimated otherwise
        const start = this.poseBefore(thread, sysKey === '$pos_act' ? startOf : null);
        let end: RobotPose;
        let arc: Arc | null = null;
        if (sysKey === '$axis_act') {
            const axes = start.axes.slice();
            for (const [k, to] of motion.target) {
                const i = AXIS_KEYS.indexOf(k);
                if (i >= 0) { axes[i] = to; }
            }
            end = { axes, point: armPosition(this.robot.arm, axes), ori: null };
        } else {
            const pick = (k: string, fallback: number | null): number | null => motion.target.get(k) ?? fallback;
            let point: Vec3 = [pick('x', start.point[0])!, pick('y', start.point[1])!, pick('z', start.point[2])!];
            const abc = ['a', 'b', 'c'].map((k, i) => pick(k, start.ori ? start.ori[i] : null));
            if (kind === 'CIRC' && parts.length >= 2) {
                const auxValue = this.eval(thread, parts[0]);
                const aux = auxValue.t === 'struct' ? auxValue.v : null;
                const auxAt = (k: string, i: number): number => {
                    const x = aux?.get(k);
                    const n = x && (x.t === 'int' || x.t === 'real') ? x.v : (m[2] ? 0 : start.point[i]);
                    return m[2] ? start.point[i] + n : n;
                };
                const ca = caText ? krlNumber(this.eval(thread, caText.replace(/^CA\s*/i, ''))) : undefined;
                arc = circleThrough(start.point, [auxAt('x', 0), auxAt('y', 1), auxAt('z', 2)], point, ca);
                if (arc && ca) {
                    // with a circular angle the robot ends on the circle, not at the end point
                    point = arcPoint(arc, 1);
                    ['x', 'y', 'z'].forEach((k, i) => { if (act.v.has(k)) { motion.target.set(k, Math.round(point[i] * 1000) / 1000); } });
                }
            }
            const from = armAngles(this.robot.arm, start.point, start.axes);
            const to = armAngles(this.robot.arm, point, start.axes);
            const axes = start.axes.slice();
            axes[0] = start.axes[0] + angleDelta(from[0], to[0]);
            axes[1] = start.axes[1] + to[1] - from[1];
            axes[2] = start.axes[2] + to[2] - from[2];
            for (let i = 6; i < AXIS_KEYS.length; i++) { axes[i] = motion.target.get(AXIS_KEYS[i]) ?? axes[i]; }
            end = { axes, point, ori: abc.every(x => x !== null) ? abc as Vec3 : null };
        }

        const limits = (name: string): PathLimits => {
            const v = this.resolveSystemVar(name);
            return v?.t === 'struct'
                ? { cp: krlNumber(v.v.get('cp')), ori1: krlNumber(v.v.get('ori1')), ori2: krlNumber(v.v.get('ori2')) }
                : { cp: 0, ori1: 0, ori2: 0 };
        };
        const percents = (name: string): number[] => {
            const v = this.resolveSystemVar(name);
            return v?.t === 'array' ? v.v.map(x => krlNumber(x)) : [];
        };
        const request: MotionRequest = {
            kind, robot: this.robot, start, end, arc, cartesian: sysKey === '$pos_act',
            velAxis: percents('$vel_axis'), accAxis: percents('$acc_axis'), vel: limits('$vel'), acc: limits('$acc'),
            override: krlNumber(this.resolveSystemVar('$ov_pro'), 100),
            mode: this.getMode(),
            // the robot passes an approximated point without stopping (not with $ADVANCE 0)
            blendIn: !!before?.approximated, blendOut: motion.approximated && this.advanceLimit() > 0,
        };
        const timing = planTiming(request);
        motion.request = request;
        motion.timing = timing;
        motion.arc = arc;
        motion.startPose = start;
        motion.endPose = end;
        motion.duration = motion.remaining = Math.max(MIN_MOTION_MS, timing.ms);
        return motion;
    }

    /** The robot has to stop exactly at the end of a motion planned as approximated: its timing gets the braking ramp. */
    private stopApproximation(motion: PlannedMotion): void {
        if (!motion.approximated) { return; }
        motion.approximated = false;
        if (!motion.request || !motion.timing) { return; }
        const elapsed = motion.duration - motion.remaining;
        motion.request = { ...motion.request, blendOut: false };
        motion.timing = planTiming(motion.request);
        motion.duration = Math.max(MIN_MOTION_MS, motion.timing.ms);
        motion.remaining = Math.max(CLOCK_EPSILON_MS * 10, motion.duration - elapsed);
    }

    /**
     * Where the robot is before the motion planned next: the end of the last
     * planned motion, else where it is now. `cartesian` reads the start of a
     * Cartesian motion ($POS_ACT or the planned motions before).
     */
    private poseBefore(thread: KrlThread, cartesian: ((k: string) => number) | null): RobotPose {
        let pose: RobotPose | null = null;
        let exactCartesian = this.pose?.exact === 'cartesian';
        for (let i = thread.motions.length - 1; i >= 0 && !pose; i--) {
            pose = thread.motions[i].endPose;
            if (pose) { exactCartesian = thread.motions[i].sysKey === '$pos_act'; }
        }
        pose = pose ?? this.currentPose();
        if (cartesian && exactCartesian) {
            // the Cartesian position is known: take it as it is (it may have been changed in the Variables view)
            return { ...pose, point: [cartesian('x'), cartesian('y'), cartesian('z')], ori: [cartesian('a'), cartesian('b'), cartesian('c')] };
        }
        return pose;
    }

    /** Where the robot is now: $AXIS_ACT or $POS_ACT, whichever the last motion moved; the rest is estimated. */
    private currentPose(): RobotPose {
        const read = (key: string, comps: string[]): number[] | null => {
            const v = this.resolveSystemVar(key);
            return v?.t === 'struct' ? comps.map(c => krlNumber(v.v.get(c))) : null;
        };
        if (this.pose?.exact === 'cartesian') {
            const p = read('$pos_act', ['x', 'y', 'z', 'a', 'b', 'c']);
            if (p) { return { axes: this.pose.estimate.axes, point: [p[0], p[1], p[2]], ori: [p[3], p[4], p[5]] }; }
        }
        const axes = read('$axis_act', AXIS_KEYS) ?? AXIS_KEYS.map(() => 0);
        return { axes, point: armPosition(this.robot.arm, axes), ori: null };
    }

    /** The robot is on its way: move $POS_ACT / $AXIS_ACT to where it is now. */
    private sampleMotion(motion: PlannedMotion): void {
        const act = motion.sysKey ? this.resolveSystemVar(motion.sysKey) : null;
        if (!act || act.t !== 'struct' || !motion.timing) { return; }
        const elapsed = motion.duration - motion.remaining;
        motion.sampledAt = elapsed;
        const f = motionState(motion.timing, elapsed * motion.timing.ms / motion.duration).fraction;
        const onArc = motion.arc ? arcPoint(motion.arc, f) : null;
        for (const [k, to] of motion.target) {
            // status and turn change when the robot arrives
            if (k === 's' || k === 't') { continue; }
            const from = motion.start.get(k) ?? to;
            const xyz = ['x', 'y', 'z'].indexOf(k);
            const n = onArc && xyz >= 0 ? onArc[xyz]
                : motion.sysKey === '$pos_act' && /^[abc]$/.test(k) ? from + angleDelta(from, to) * f
                    : from + (to - from) * f;
            const cur = act.v.get(k);
            act.v.set(k, storeValue(cur, cur?.t === 'int' ? KRL_INT(Math.round(n)) : KRL_REAL(Math.round(n * 1000) / 1000)));
        }
        if (motion.sysKey === '$pos_act' && motion.startPose && motion.endPose) {
            const from = motion.startPose.axes;
            const to = motion.endPose.axes;
            this.setEstimatedAxes(from.map((a, i) => a + (to[i] - a) * f));
        }
    }

    /**
     * A Cartesian motion moves the axes, too: without the robot's kinematics
     * $AXIS_ACT gets the estimate of the arm model (A1 .. A3; A4 .. A6 stay).
     */
    private setEstimatedAxes(axes: number[]): void {
        const act = this.resolveSystemVar('$axis_act');
        if (!act || act.t !== 'struct') { return; }
        AXIS_KEYS.forEach((k, i) => {
            const cur = act.v.get(k);
            if (!cur || !Number.isFinite(axes[i])) { return; }
            const n = Math.round(axes[i] * 1000) / 1000;
            if (krlNumber(cur) !== n) { act.v.set(k, storeValue(cur, cur.t === 'int' ? KRL_INT(Math.round(n)) : KRL_REAL(n))); }
        });
    }

    /** The main run has executed a motion: the robot is at its end position. */
    private finishMotion(motion: PlannedMotion): void {
        const act = motion.sysKey ? this.resolveSystemVar(motion.sysKey) : null;
        if (!act || act.t !== 'struct') { return; }
        for (const [k, n] of motion.target) {
            const cur = act.v.get(k);
            act.v.set(k, storeValue(cur, cur?.t === 'int' ? KRL_INT(n) : KRL_REAL(n)));
        }
        if (motion.endPose) {
            this.pose = { exact: motion.sysKey === '$axis_act' ? 'axes' : 'cartesian', estimate: motion.endPose };
            if (motion.sysKey === '$pos_act') { this.setEstimatedAxes(motion.endPose.axes); }
        }
    }

    /** Where each robot interpreter's main run is: the motion the robot executes, and the motions planned after it. */
    getMainRun(): MainRunView[] {
        const fileOf = (key: string) => this.programs.get(key)?.path ?? key;
        return this.threads
            .filter(t => t.motions.length > 0)
            .map(t => {
                const head = t.motions[0];
                return {
                    threadId: t.id, file: fileOf(head.progKey),
                    line: head.line, text: head.text, planned: t.motions.length - 1,
                    motions: t.motions.slice(1).map(m => ({ file: fileOf(m.progKey), line: m.line })),
                };
            });
    }

    /** Where each running robot interpreter's advance run is: the statement it executes next. */
    getAdvanceRun(): AdvanceRunView[] {
        return this.threads
            .filter(t => t.role === 'robot' && !t.finished && t.stack.length > 0)
            .map(t => {
                const frame = t.stack[t.stack.length - 1];
                // motions planned after the one the robot executes
                return { threadId: t.id, file: this.programs.get(frame.progKey)?.path ?? frame.progKey, line: this.currentLine(t), ahead: Math.max(0, t.motions.length - 1) };
            });
    }

    // ------------------------------------------------------------------
    // robot view and I/O view

    /** Position, axes, active tool and base, motion parameters and mode: the KRL Robot view. */
    getRobotState(): RobotViewEntry[] {
        const out: RobotViewEntry[] = [];
        const read = (name: string): KrlValue | null => {
            const v = this.resolveSystemVar(name.toLowerCase());
            return v && v.t !== 'undef' ? v : null;
        };
        const structEntry = (label: string, expression: string, v: KrlValue | null, tooltip?: string): RobotViewEntry => {
            if (!v || v.t !== 'struct') { return { label, value: '—', expression, tooltip }; }
            const children = [...v.v.entries()]
                .filter(([k, x]) => !/^e[1-6]$/.test(k) || (x.t !== 'int' && x.t !== 'real') || x.v !== 0)
                .map(([k, x]) => ({ label: k.toUpperCase(), value: componentText(v.v, k, x) ?? displayValue(x), expression: `${expression}.${k.toUpperCase()}` }));
            return { label, value: positionSummary(v.v) ?? displayValue(v), expression, tooltip, matrix: matrixOf(v.v) ?? undefined, children };
        };
        out.push(structEntry('Position', '$POS_ACT', read('$pos_act'), this.pose?.exact === 'axes'
            ? 'Cartesian position of the TCP ($POS_ACT) after the last Cartesian motion: the last motion went to axis angles and the simulator has no kinematics of the robot.'
            : 'Current Cartesian position of the TCP ($POS_ACT), follows the robot while it moves.'));
        out.push(structEntry('Axes', '$AXIS_ACT', read('$axis_act'), this.pose?.exact === 'cartesian'
            ? 'Axis angles ($AXIS_ACT), estimated: the last motion went to a Cartesian point and the simulator has no kinematics of the robot (arm model from the machine data for A1 .. A3).'
            : 'Current axis angles ($AXIS_ACT), follow the robot while it moves.'));
        out.push(this.motionEntry());
        out.push(this.overrideEntry());
        out.push(this.modeEntry());

        // the active tool and base: $ACT_TOOL / $ACT_BASE, else the TOOL_DATA / BASE_DATA entry equal to $TOOL / $BASE
        const frameSource = (frameVar: string, actVar: string, table: string): string => {
            const act = read(actVar);
            const n = act && (act.t === 'int' || act.t === 'real') ? act.v : -1;
            if (n > 0) { return `${table}[${n}]`; }
            const frame = read(frameVar);
            const data = this.configGlobals.get(table.toLowerCase()) ?? this.datGlobals.get(table.toLowerCase());
            if (frame && data?.t === 'array') {
                const i = data.v.findIndex(x => valuesEqual(x, frame));
                if (i >= 0 && !(frame.t === 'struct' && [...frame.v.values()].every(x => krlNumber(x) === 0))) { return `${table}[${i + 1}]`; }
            }
            return '';
        };
        const tool = frameSource('$tool', '$act_tool', 'TOOL_DATA');
        const base = frameSource('$base', '$act_base', 'BASE_DATA');
        out.push(structEntry(tool ? `Tool: ${tool}` : 'Tool', '$TOOL', read('$tool'), 'Active TOOL frame ($TOOL): the TCP relative to the flange.'));
        out.push(structEntry(base ? `Base: ${base}` : 'Base', '$BASE', read('$base'), 'Active BASE frame ($BASE) relative to WORLD.'));

        const num = (expr: string, unit: string): RobotViewEntry => {
            const v = this.peekValue(expr);
            const shown = v && (v.t === 'int' || v.t === 'real') ? `${displayValue(v)}${unit ? ' ' + unit : ''}` : v ? displayValue(v) : '—';
            return { label: expr, value: shown, expression: expr };
        };
        out.push({
            label: 'Motion parameters', value: '', children: [
                num('$OV_PRO', '%'), num('$VEL.CP', 'm/s'), num('$ACC.CP', 'm/s²'), num('$VEL.ORI1', '°/s'), num('$ACC.ORI1', '°/s²'),
                num('$APO.CDIS', 'mm'), num('$ADVANCE', ''),
                ...[1, 2, 3, 4, 5, 6].map(i => num(`$VEL_AXIS[${i}]`, '%')),
                ...[1, 2, 3, 4, 5, 6].map(i => num(`$ACC_AXIS[${i}]`, '%')),
            ],
        });
        out.push(this.robotEntry());
        const main = this.getMainRun();
        const advance = this.getAdvanceRun();
        out.push({
            label: 'Program', value: displayValue(read('$mode_op')), children: [
                { label: '$MODE_OP', value: displayValue(read('$mode_op')), expression: '$MODE_OP' },
                ...main.map(m => ({ label: 'Main run', value: `${path.basename(m.file)}:${m.line + 1}  ${m.text}`, tooltip: `${m.planned} more motion(s) planned` })),
                ...advance.map(a => ({ label: 'Advance run', value: `${path.basename(a.file)}:${a.line + 1}`, tooltip: `${a.ahead} motion(s) ahead of the robot` })),
            ],
        });
        return out;
    }

    /** The motion the robot executes: TCP velocity, acceleration, progress and what limits it. */
    private motionEntry(): RobotViewEntry {
        const thread = this.threads.find(t => t.role === 'robot' && !t.stopped && t.motions.length > 0);
        const head = thread?.motions[0];
        const tcp = (velocity: number, acceleration: number): RobotViewEntry[] => [
            { label: 'Velocity', value: `${formatReal(velocity / 1000, 3)} m/s`, tooltip: 'TCP velocity along the path (simulated robot time).' },
            {
                label: 'Acceleration', value: `${formatReal(acceleration / 1000, 2)} m/s²${acceleration < -1e-9 ? ' (braking)' : ''}`,
                tooltip: 'TCP acceleration along the path; negative while the robot brakes.',
            },
        ];
        if (!thread || !head || !head.timing) {
            return { label: 'Motion', value: head ? head.text : 'standing', children: tcp(0, 0) };
        }
        const timing = head.timing;
        const elapsed = head.duration - head.remaining;
        const now = motionState(timing, head.duration > 0 ? elapsed * timing.ms / head.duration : timing.ms);
        const seconds = (ms: number) => formatReal(ms / 1000, 2);
        const estimated = timing.kind === 'PTP';
        const children = tcp(now.velocity, now.acceleration);
        if (estimated) {
            children[0].tooltip = 'TCP velocity of a PTP motion, estimated on the straight line (the path of a PTP motion is not a line).';
        }
        const leadText = timing.lead === 'path' ? `path ($VEL.CP ${formatReal(timing.leadVelocity / 1000, 2)} m/s)`
            : timing.lead === 'orientation' ? `orientation ($VEL.ORI1 ${formatReal(timing.leadVelocity, 1)} °/s)`
                : timing.lead ? `${timing.lead} (${formatReal(timing.leadVelocity, 1)} °/s at $VEL_AXIS)`
                    : 'no travel';
        children.push(
            { label: 'Progress', value: `${Math.round(now.fraction * 100)} %  (${seconds(elapsed)} of ${seconds(head.duration)} s)`, tooltip: 'Time of the motion in simulated robot time.' },
            { label: 'Limited by', value: leadText, tooltip: 'The axis, path or orientation that needs longest: the others are slowed down to arrive together.' },
        );
        if (timing.kind === 'PTP') {
            const axes = timing.axisTravel.map((d, i) => ({ d, i })).filter(({ d, i }) => i < 6 || d > 0);
            children.push({
                label: 'Axis velocities', value: timing.lead.startsWith('A') || timing.lead.startsWith('E') ? `${timing.lead} leads` : '',
                tooltip: head.sysKey === '$pos_act' ? 'Estimated: the axis travel of a PTP motion to a Cartesian point comes from an arm model.' : undefined,
                children: axes.map(({ i }) => ({ label: axisName(i), value: `${formatReal(now.axisVelocity[i], 1)} °/s` })),
            });
        }
        if (thread.motions.length > 1) { children.push({ label: 'Planned', value: `${thread.motions.length - 1} more motion(s)` }); }
        return {
            label: 'Motion', value: `${head.text}  ·  ${formatReal(now.velocity / 1000, 3)} m/s`,
            tooltip: `${timing.kind} motion, ${formatReal(timing.path, 1)} mm${estimated ? ' (straight line)' : ''}${head.approximated ? ', approximated' : ''}.`,
            children,
        };
    }

    /** The override (as on the smartPAD, up to 10000 % for the simulation). */
    private overrideEntry(): RobotViewEntry {
        const { value, ovPro, speed } = this.getOverride();
        return {
            label: 'Override',
            value: `${formatOverride(value)} %${speed !== null && speed > 100 && ovPro < 100 ? `  ($OV_PRO ${formatOverride(ovPro)} %)` : ''}`,
            contextValue: 'krlRobotOverride',
            tooltip: 'Like the override of the smartPAD: 0 .. 100 % is the program override $OV_PRO (motions slow down, 0 % = the robot stands). '
                + `Above 100 % (up to ${MAX_SIMULATION_OVERRIDE} %) the whole simulation runs faster than real time. Change it with - / + in the debug toolbar or here.`,
            children: [
                { label: '$OV_PRO', value: `${formatOverride(ovPro)} %`, expression: '$OV_PRO', tooltip: 'Program override of the controller (0 .. 100 %).' },
                {
                    label: 'Simulation speed', value: speed === null ? 'as fast as possible' : `${formatOverride(Math.max(100, speed))} % of real time`,
                    tooltip: 'Above 100 % the simulation runs faster than the robot: motions, WAIT SEC and timers.',
                },
            ],
        };
    }

    /** The operating mode, like the key switch of the smartPAD. */
    private modeEntry(): RobotViewEntry {
        return {
            label: 'Mode', value: this.describeMode(), expression: '$MODE_OP', contextValue: 'krlRobotMode',
            tooltip: 'Operating mode ($MODE_OP), like the key switch of the smartPAD: T1, T2, AUT or EX. It can be changed while the program is paused or stopped.',
        };
    }

    /** Characteristics of the simulated robot: from its machine data or the standard robot. */
    private robotEntry(): RobotViewEntry {
        const r = this.robot;
        const axes = Math.max(6, Math.min(12, r.numAxes));
        return {
            label: 'Robot', value: r.source ? r.name : `${r.name} (standard)`,
            tooltip: r.source
                ? `Motion timing from the machine data ${r.source}: axis velocity = $VEL_AXIS_MA × $RAT_MOT_AX, path limits $VEL_MA / $ACC_MA.`
                : `No Mada/$machine.dat found next to the robot programs: the motion timing uses a standard robot. Axes reach full speed in ${DEFAULT_RAISE_TIME_S} s at 100 % $ACC_AXIS.`,
            children: [
                ...Array.from({ length: axes }, (_, i) => ({
                    label: axisName(i), value: `${formatReal(r.axisVel[i], 1)} °/s  ·  ${formatReal(r.axisAcc[i], 0)} °/s²`,
                    tooltip: 'Maximum velocity at 100 % $VEL_AXIS, acceleration at 100 % $ACC_AXIS.',
                })),
                { label: 'Path', value: `${formatReal(r.velMa.cp, 2)} m/s  ·  ${formatReal(r.accMa.cp, 2)} m/s²`, tooltip: 'Maximum path velocity and acceleration ($VEL_MA.CP, $ACC_MA.CP).' },
                { label: 'Orientation', value: `${formatReal(r.velMa.ori1, 1)} °/s  ·  ${formatReal(r.accMa.ori1, 1)} °/s²`, tooltip: 'Maximum swivel velocity and acceleration ($VEL_MA.ORI1, $ACC_MA.ORI1).' },
            ],
        };
    }

    /** Value of an expression in the scope of the first thread that knows it (also while running). */
    private peekValue(expression: string): KrlValue | null {
        for (const t of this.threads) {
            const v = evaluateExpression(expression, this.ctxFor(t));
            if (v.t !== 'undef') { return v; }
        }
        return null;
    }

    /** I/O indices the loaded programs use: `$IN[5]`, `$OUT[3]`, ... by system variable. */
    private ioReferences(): Map<string, Set<number>> {
        const refs = new Map<string, Set<number>>();
        const re = /\$(IN|OUT|ANIN|ANOUT|FLAG|CYCFLAG|TIMER)\s*\[\s*(\d+)\s*\]/gi;
        for (const prog of this.programs.values()) {
            for (const stmt of prog.stmts) {
                for (const m of stmt.text.matchAll(re)) {
                    const key = `$${m[1].toLowerCase()}`;
                    if (!refs.has(key)) { refs.set(key, new Set()); }
                    refs.get(key)!.add(Number(m[2]));
                }
            }
        }
        return refs;
    }

    /**
     * Inputs, outputs, flags, timers, signals and system signals for the KRL I/O view:
     * the ones the programs use, the ones that are set (TRUE / not 0), and `extra`
     * expressions the user pinned.
     */
    getIoState(extra: string[] = []): IoGroup[] {
        const refs = this.ioReferences();
        const names = new Map<string, string[]>();
        for (const sig of this.signals.values()) {
            if (!sig.io) { continue; }
            for (let i = sig.from; i <= sig.to; i++) {
                const key = `${sig.io}[${i}]`;
                if (!refs.has(sig.io)) { refs.set(sig.io, new Set()); }
                refs.get(sig.io)!.add(i);
                names.set(key, [...(names.get(key) ?? []), this.displayName(sig.name)]);
            }
        }
        for (const e of extra) {
            const m = /^\$(\w+)\s*\[\s*(\d+)\s*\]$/.exec(e.trim());
            if (m) {
                const key = `$${m[1].toLowerCase()}`;
                if (!refs.has(key)) { refs.set(key, new Set()); }
                refs.get(key)!.add(Number(m[2]));
            }
        }
        const entry = (expression: string, v: KrlValue | null, key: string): IoEntry => ({
            expression, value: v ? displayValue(v) : '—', kind: v?.t === 'bool' ? 'bool' : v && (v.t === 'int' || v.t === 'real') ? 'number' : 'other',
            names: names.get(key) ?? [],
        });
        const arrayGroup = (title: string, name: string): IoGroup | null => {
            const arr = this.resolveSystemVar(name);
            const indices = new Set(refs.get(name) ?? []);
            if (arr?.t === 'array') {
                // set ones (TRUE / not 0) are listed even when no program names them
                arr.v.forEach((x, i) => { if ((x.t === 'bool' && x.v) || ((x.t === 'int' || x.t === 'real') && x.v !== 0 && name !== '$timer')) { indices.add(i + 1); } });
            }
            if (indices.size === 0) { return null; }
            const label = name.toUpperCase();
            return {
                name: title,
                entries: [...indices].sort((a, b) => a - b).map(i => entry(`${label}[${i}]`, arr?.t === 'array' ? arr.v[i - 1] ?? null : null, `${name}[${i}]`)),
            };
        };
        const groups = [
            arrayGroup('Digital inputs ($IN)', '$in'),
            arrayGroup('Digital outputs ($OUT)', '$out'),
            arrayGroup('Analog inputs ($ANIN)', '$anin'),
            arrayGroup('Analog outputs ($ANOUT)', '$anout'),
            arrayGroup('Flags ($FLAG)', '$flag'),
            arrayGroup('Cyclical flags ($CYCFLAG)', '$cycflag'),
            arrayGroup('Timers ($TIMER)', '$timer'),
        ].filter((g): g is IoGroup => !!g);
        if (this.signals.size > 0) {
            groups.push({
                name: 'Signals',
                entries: [...this.signals.values()].map(sig => {
                    const target = !sig.io ? (sig.from === 1 ? 'TRUE' : 'FALSE')
                        : `${sig.io.toUpperCase()}[${sig.from}]${sig.to !== sig.from ? ` TO ${sig.io.toUpperCase()}[${sig.to}]` : ''}`;
                    return { ...entry(this.displayName(sig.name), this.readSignal(sig), ''), names: [target] };
                }),
            });
        }
        const system = ['$OV_PRO', '$MODE_OP', '$PRO_STATE0', '$PRO_STATE1', '$STOPMESS', '$MOVE_ENABLE', '$DRIVES_ON', '$PERI_RDY', '$T1', '$T2', '$AUT', '$EXT'];
        groups.push({ name: 'System', entries: system.map(s => entry(s, this.resolveSystemVar(s.toLowerCase()), '')) });
        return groups;
    }

    /** Force an input, output, flag, signal or system variable (simulation). Returns an error message, or null. */
    setIo(expression: string, valueText: string): string | null {
        const result = this.evaluateForDebugger(`${expression} = ${valueText}`, undefined, true);
        return result ? null : `cannot set ${expression} to ${valueText}`;
    }

    /** Toggle a Boolean input, output, flag or signal. Returns the new value or an error message. */
    toggleIo(expression: string): { value?: string; error?: string } {
        const current = this.peekValue(expression);
        if (!current) { return { error: `${expression} is not known` }; }
        if (current.t !== 'bool') { return { error: `${expression} is not a Boolean (${displayValue(current)})` }; }
        // `current` is the stored value itself, which the assignment overwrites in place
        const next = current.v ? 'FALSE' : 'TRUE';
        const error = this.setIo(expression, next);
        return error ? { error } : { value: next };
    }

    // ------------------------------------------------------------------
    // variables

    private makeFrame(progKey: string, func: KrlFunctionInfo, returnPc: number, callLine: number): KrlCallFrame {
        return {
            progKey,
            functionName: func.displayName,
            kind: func.kind,
            pc: func.startIdx + 1,
            startIdx: func.startIdx,
            endIdx: func.endIdx,
            params: new Map(),
            inParams: new Set(),
            locals: new Map(),
            returnPc,
            callLine,
            returnValue: null,
            forLoops: new Map(),
            outBindings: [],
        };
    }

    /** Resolve a variable name: locals, params, data lists, signals, then system vars. */
    private resolveName(thread: KrlThread, name: string): KrlValue | null {
        const key = name.toLowerCase();
        const map = this.findVariableMap(thread, key);
        if (map) { return map.get(key) ?? null; }
        const sig = this.signals.get(key);
        if (sig) { return this.readSignal(sig); }
        return key.startsWith('$') ? this.resolveSystemVar(key) : null;
    }

    /** The scope map holding a (non-system) variable, following KRL visibility rules. */
    private findVariableMap(thread: KrlThread, key: string): Map<string, KrlValue> | null {
        const frame = this.top(thread);
        if (frame) {
            if (frame.locals.has(key)) { return frame.locals; }
            if (frame.params.has(key)) { return frame.params; }
        }
        const priv = this.datPrivatesByModule.get(moduleKeyOf(frame ? frame.progKey : thread.fileKey));
        if (priv?.has(key)) { return priv; }
        if (this.datGlobals.has(key)) { return this.datGlobals; }
        if (this.configGlobals.has(key)) { return this.configGlobals; }
        return null;
    }

    private resolveSystemVar(key: string): KrlValue | null {
        switch (key) {
            case '$timer':
                return { t: 'array', v: this.timerValue.map((_, i) => KRL_INT(this.readTimer(i))) };
            case '$timer_stop':
                return { t: 'array', v: this.timerStopped.map(s => KRL_BOOL(s)) };
            case '$timer_flag':
                return { t: 'array', v: this.timerArmed.map((armed, i) => KRL_BOOL(armed && this.readTimer(i) >= 0)) };
            default: break;
        }
        const existing = this.systemVars.get(key);
        if (existing) { return existing; }
        const factory = SYSTEM_DEFAULTS[key];
        if (!factory) { return null; }
        const created = factory();
        this.systemVars.set(key, created);
        return created;
    }

    /** $TIMER[i] in ms: counts simulated time while $TIMER_STOP[i] is FALSE (manual 2.4). */
    private readTimer(i: number): number {
        return Math.trunc(this.timerStopped[i] ? this.timerValue[i] : this.timerValue[i] + this.clockMs - this.timerBase[i]);
    }

    private writeTimer(base: string, index: number, value: KrlValue): void {
        const i = index - 1;
        if (i < 0 || i >= TIMER_COUNT) { return; }
        if (base === '$timer') {
            this.timerValue[i] = krlNumber(value);
            this.timerBase[i] = this.clockMs;
            this.timerArmed[i] = this.timerValue[i] < 0;
        } else if (base === '$timer_stop') {
            const stop = krlBool(value);
            if (stop && !this.timerStopped[i]) { this.timerValue[i] = this.readTimer(i); }
            if (!stop && this.timerStopped[i]) { this.timerBase[i] = this.clockMs; }
            this.timerStopped[i] = stop;
        }
    }

    /**
     * Assign to a variable path such as "counter", "cpos.X", "$OUT[1]",
     * "FELD[I,J]" or "NAME[]". Missing components are created on demand.
     */
    private setVariablePath(thread: KrlThread, lvalue: string, value: KrlValue, fromProgram = false): void {
        const parts = parseLValue(lvalue);
        if (!parts) { return; }
        const base = parts.base.toLowerCase();
        // `NAME[]` addresses the whole array
        const segments = parts.segments.filter((s, i) => !(s.kind === 'index' && s.text.trim() === '' && i === parts.segments.length - 1));

        if ((base === '$timer' || base === '$timer_stop') && segments.length === 1 && segments[0].kind === 'index') {
            this.writeTimer(base, Math.trunc(krlNumber(this.eval(thread, segments[0].text))), value);
            return;
        }

        let map = this.findVariableMap(thread, base);
        if (!map) {
            const sig = this.signals.get(base);
            if (sig && segments.length === 0) { this.writeSignal(sig, value); return; }
            if (base.startsWith('$')) {
                this.resolveSystemVar(base);
                map = this.systemVars;
            } else {
                // the controller does not accept a program that writes an undeclared name
                if (fromProgram) { throw new KrlStopError(invalidReadMessage({ kind: 'undeclared', path: parts.base }), { kind: 'undeclared', path: parts.base }); }
                // not declared (Debug Console, Variables view): create it where the statement runs
                const frame = this.top(thread);
                map = frame ? frame.locals : this.datPrivate(thread.fileKey);
                this.rememberName(parts.base);
            }
        }

        if (segments.length === 0) {
            map.set(base, storeValue(map.get(base), value));
            return;
        }
        let current = map.get(base);
        if (!current) { current = KRL_UNDEF(); map.set(base, current); }
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const last = i === segments.length - 1;
            if (seg.kind === 'index') {
                const indexTexts = splitTopLevel(seg.text, ',');
                const indices = indexTexts.map(t => Math.trunc(krlNumber(fromProgram ? this.eval(thread, t) : evaluateExpression(t, this.ctxFor(thread)))));
                for (let j = 0; j < indices.length; j++) {
                    ensureArray(current);
                    if (current.t !== 'array') { return; }
                    const at = indices[j] - 1;
                    // an empty index (NAME[1,] = "text": a row of a CHAR array) is not checked
                    if (fromProgram && !base.startsWith('$') && indexTexts[j].trim() !== '' && current.v.length > 0 && (at < 0 || at >= current.v.length)) {
                        const where = { kind: 'index' as const, path: `${parts.base}[${indices.join(',')}]` };
                        throw new KrlStopError(invalidReadMessage(where), where);
                    }
                    if (at < 0 || at >= 100000) { return; }
                    while (current.v.length <= at) { current.v.push(KRL_UNDEF()); }
                    if (last && j === indices.length - 1) {
                        current.v[at] = storeValue(current.v[at], value);
                        return;
                    }
                    current = current.v[at];
                }
            } else {
                const member = seg.text.toLowerCase();
                upgradeToStruct(current);
                if (current.t !== 'struct') { return; }
                if (last) {
                    current.v.set(member, storeValue(current.v.get(member), value));
                    return;
                }
                let next = current.v.get(member);
                if (!next) { next = KRL_UNDEF(); current.v.set(member, next); }
                current = next;
            }
        }
    }

    // ------------------------------------------------------------------
    // functions

    /** Function invocation used by the expression evaluator. */
    private invokeFunction(thread: KrlThread, name: string, args: KrlValue[]): KrlValue | null {
        const frame = this.top(thread);
        const routine = this.resolveRoutine(frame ? frame.progKey : thread.fileKey, name);
        if (routine) { return this.runNestedFunction(thread, routine.key, routine.func, args); }
        const builtin = this.runBuiltin(thread, name.toLowerCase(), args);
        if (builtin === null) {
            this.warnOnce(`fct:${name.toLowerCase()}`, `[${thread.name}] function ${name} is not simulated (its result and OUT arguments get 0 / FALSE)`);
            this.neutralizeArguments(args);
            return { t: 'undef', type: NOT_SIMULATED };
        }
        return builtin;
    }

    /**
     * A routine the simulator does not have may write its OUT arguments: those
     * without value get 0 / FALSE, so reading them afterwards does not stop the program.
     */
    private neutralizeArguments(args: KrlValue[]): void {
        const fill = (v: KrlValue): void => {
            if (v.t === 'undef' && v.type && /^(?:INT|REAL|BOOL|CHAR)$/.test(v.type)) {
                storeValue(v, defaultValue(v.type));
            } else if (v.t === 'array') {
                v.v.forEach(fill);
            } else if (v.t === 'struct') {
                v.v.forEach(fill);
            }
        };
        args.forEach(fill);
    }

    /** Run a DEFFCT synchronously for use inside an expression. */
    private runNestedFunction(thread: KrlThread, progKey: string, func: KrlFunctionInfo, args: KrlValue[]): KrlValue | null {
        if (this.nestedDepth > 100) {
            this.warnOnce(`depth:${func.name}`, `[${thread.name}] recursion depth exceeded in ${func.displayName}`);
            return null;
        }
        const frame = this.makeFrame(progKey, func, -1, 0);
        func.params.forEach((p, i) => {
            const arg = args[i];
            // an OUT argument without value is still the caller's variable: the function may assign it
            if (!arg || (arg.t === 'undef' && (p.dir === 'IN' || !arg.type))) { return; }
            if (p.dir === 'IN') { frame.params.set(p.name, cloneValue(arg)); frame.inParams.add(p.name); }
            else { frame.params.set(p.name, arg); }
        });
        const base = thread.stack.length;
        thread.stack.push(frame);
        this.nestedDepth++;
        try {
            let guard = 0;
            // also runs DEF routines the function calls, until the function returns
            while (thread.stack.length > base && thread.stack[base] === frame) {
                if (this.stopRequested || ++guard > NESTED_FUNCTION_GUARD) {
                    if (guard > NESTED_FUNCTION_GUARD) {
                        this.warnOnce(`guard:${func.name}`, `[${thread.name}] ${func.displayName} did not return; result undefined`);
                    }
                    break;
                }
                if (this.executeOne(thread) === 'finished') { break; }
            }
            return frame.returnValue;
        } catch (e) {
            if (e instanceof KrlStopError && !e.where) {
                const top = this.top(thread);
                const file = top ? this.programs.get(top.progKey)?.path ?? top.progKey : '';
                e.where = `${func.displayName}, ${path.basename(file)}:${this.currentLine(thread) + 1}`;
            }
            throw e;
        } finally {
            thread.stack.length = Math.min(thread.stack.length, base);
            this.nestedDepth--;
        }
    }

    private runBuiltin(thread: KrlThread, name: string, args: KrlValue[]): KrlValue | null {
        const n = (i: number, fb = 0) => krlNumber(args[i], fb);
        const D2R = Math.PI / 180;
        const R2D = 180 / Math.PI;
        const text = (v: KrlValue | undefined) => (!v ? '' : v.t === 'str' || v.t === 'char' ? v.v : isCharArray(v) ? charArrayText(v) : '');
        switch (name) {
            // arithmetic
            case 'abs':   return args.length >= 1 ? KRL_REAL(Math.abs(n(0))) : null;
            case 'sign':  return args.length >= 1 ? KRL_INT(Math.sign(n(0))) : null;
            case 'trunc': return args.length >= 1 ? KRL_INT(Math.trunc(n(0))) : null;
            case 'round': return args.length >= 1 ? KRL_INT(Math.round(n(0))) : null;
            case 'sqrt':  return args.length >= 1 ? KRL_REAL(Math.sqrt(Math.abs(n(0)))) : null;
            case 'min':   return args.length >= 2 ? KRL_REAL(Math.min(n(0), n(1))) : null;
            case 'max':   return args.length >= 2 ? KRL_REAL(Math.max(n(0), n(1))) : null;
            case 'pow':   return args.length >= 2 ? KRL_REAL(Math.pow(n(0), n(1))) : null;
            case 'exp':   return args.length >= 1 ? KRL_REAL(Math.exp(n(0))) : null;
            case 'ln':    return args.length >= 1 ? KRL_REAL(Math.log(Math.abs(n(0)) || 1e-300)) : null;
            // trigonometry (degrees, per KRL)
            case 'sin':   return args.length >= 1 ? KRL_REAL(Math.sin(n(0) * D2R)) : null;
            case 'cos':   return args.length >= 1 ? KRL_REAL(Math.cos(n(0) * D2R)) : null;
            case 'tan':   return args.length >= 1 ? KRL_REAL(Math.tan(n(0) * D2R)) : null;
            case 'asin':  return args.length >= 1 ? KRL_REAL(Math.asin(n(0)) * R2D) : null;
            case 'acos':  return args.length >= 1 ? KRL_REAL(Math.acos(n(0)) * R2D) : null;
            case 'atan':  return args.length >= 1 ? KRL_REAL(Math.atan(n(0)) * R2D) : null;
            case 'atan2': return args.length >= 2 ? KRL_REAL(Math.atan2(n(0), n(1)) * R2D) : null;
            // sequence helpers
            case 'odd':   return args.length >= 1 ? KRL_BOOL(Math.abs(Math.trunc(n(0))) % 2 === 1) : null;
            case 'even':  return args.length >= 1 ? KRL_BOOL(Math.abs(Math.trunc(n(0))) % 2 === 0) : null;
            case 'len':   return args.length >= 1 ? KRL_INT(args[0].t === 'str' ? args[0].v.length : (args[0].t === 'array' ? args[0].v.length : 0)) : null;
            // bit operators written as functions
            case 'b_and': return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) & Math.trunc(n(1))) : null;
            case 'b_or':  return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) | Math.trunc(n(1))) : null;
            case 'b_xor': case 'b_exor': return args.length >= 2 ? KRL_INT(Math.trunc(n(0)) ^ Math.trunc(n(1))) : null;
            case 'b_not': return args.length >= 1 ? KRL_INT(~Math.trunc(n(0))) : null;
            // string functions on CHAR arrays
            case 'strlen': return KRL_INT(text(args[0]).length);
            case 'strdecllen': return KRL_INT(args[0]?.t === 'array' ? args[0].v.length : 0);
            case 'strclear':
                if (args[0]?.t === 'array') { args[0].v.forEach((_, i, arr) => { arr[i] = { t: 'char', v: ' ' }; }); }
                return KRL_BOOL(true);
            case 'strcomp': {
                const caseSensitive = args.length < 3 || krlBool(args[2]);
                const a = text(args[0]);
                const b = text(args[1]);
                return KRL_BOOL(caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());
            }
            case 'strcopy': case 'stradd': {
                const dst = args[0];
                if (dst?.t !== 'array') { return KRL_INT(0); }
                const value = (name === 'stradd' ? charArrayText(dst) : '') + text(args[1]);
                dst.v.forEach((_, i, arr) => { arr[i] = { t: 'char', v: i < value.length ? value[i] : ' ' }; });
                return name === 'stradd' ? KRL_INT(Math.min(value.length, dst.v.length)) : KRL_BOOL(true);
            }
            case 'strfind': {
                const caseSensitive = args.length < 4 || krlBool(args[3]);
                const hay = caseSensitive ? text(args[1]) : text(args[1]).toLowerCase();
                const needle = caseSensitive ? text(args[2]) : text(args[2]).toLowerCase();
                return KRL_INT(hay.indexOf(needle, Math.max(0, n(0) - 1)) + 1);
            }
            // KSS 8 conversions: ok = StrToInt(TEXT[], value) writes `value`, TRUE on success
            case 'strtobool': case 'strtoint': case 'strtoreal': case 'strtostring': {
                const src = text(args[0]).trim();
                let parsed: KrlValue | null = null;
                if (name === 'strtostring') { parsed = KRL_STR(text(args[0])); }
                else if (name === 'strtobool') { parsed = /^(TRUE|FALSE)$/i.test(src) ? KRL_BOOL(/^TRUE$/i.test(src)) : null; }
                else if (name === 'strtoint') { parsed = /^[+-]?\d+$/.test(src) ? KRL_INT(parseInt(src, 10)) : null; }
                else { parsed = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(src) ? KRL_REAL(parseFloat(src)) : null; }
                if (!parsed || !args[1]) { return KRL_BOOL(false); }
                storeValue(args[1], parsed);
                return KRL_BOOL(true);
            }
            // SWRITE(TEXT[], STATE, OFFSET, FORMAT, PAR1, ...): format into TEXT[] from OFFSET (0 = first character)
            case 'swrite': {
                const dst = args[0];
                if (dst?.t !== 'array') { return KRL_BOOL(false); }
                const formatted = formatKrl(text(args[3]), args.slice(4), text);
                const offset = Math.max(0, Math.trunc(n(2)));
                const written = Math.max(0, Math.min(formatted.text.length, dst.v.length - offset));
                for (let i = 0; i < written; i++) { dst.v[offset + i] = storeValue(dst.v[offset + i], { t: 'char', v: formatted.text[i] }); }
                if (args[2]) { storeValue(args[2], KRL_INT(offset + written)); }
                if (args[1]) {
                    storeValue(args[1], {
                        t: 'struct', name: 'STATE_T',
                        v: new Map<string, KrlValue>([['ret1', { t: 'enum', v: '#CMD_OK' }], ['hits', KRL_INT(formatted.hits)], ['length', KRL_INT(written)]]),
                    });
                }
                return KRL_BOOL(true);
            }
            case 'varstate': {
                const v = this.resolveName(thread, text(args[0]));
                return { t: 'enum', v: !v ? '#UNKNOWN' : hasNoValue(v) ? '#DECLARED' : '#INITIALIZED' };
            }
            // messages and dialogs: shown in the KRL Messages view until acknowledged, answered or cleared
            case 'set_krlmsg': return KRL_INT(this.setMessage(thread, args, false));
            case 'set_krldlg': return KRL_INT(this.setMessage(thread, args, true));
            case 'exists_krlmsg': return KRL_BOOL(this.messages.some(m => m.handle === Math.trunc(n(0))));
            case 'exists_krldlg': {
                const handle = Math.trunc(n(0));
                if (this.messages.some(m => m.handle === handle)) { return KRL_BOOL(true); }
                const answer = this.dialogAnswers.get(handle);
                if (answer !== undefined && args[1]) { storeValue(args[1], KRL_INT(answer)); }
                return KRL_BOOL(false);
            }
            case 'clear_krlmsg': {
                // -88: all messages of this interpreter, -99: all messages
                const handle = Math.trunc(n(0));
                const before = this.messages.length;
                this.removeMessages(m => handle === -99 || (handle === -88 ? m.threadId === thread.id : m.handle === handle));
                return KRL_BOOL(this.messages.length < before || handle === -88 || handle === -99);
            }
            case 'getsysstate': return KRL_BOOL(false);
            default: return null;
        }
    }

    /**
     * SET_KRLMSG(type, msg, par[], opt) or SET_KRLDLG(msg, par[], softkeys[], opt):
     * add the message and return its handle. An identical message that is still
     * shown is not added twice (its handle is returned).
     */
    private setMessage(thread: KrlThread, args: KrlValue[], dialog: boolean): number {
        const member = (v: KrlValue | undefined, name: string): KrlValue | undefined => (v?.t === 'struct' ? v.v.get(name) : undefined);
        const chars = (v: KrlValue | undefined): string => !v ? ''
            : v.t === 'array' ? v.v.map(x => (x.t === 'char' ? x.v : '')).join('').trim()
                : v.t === 'str' || v.t === 'char' ? v.v.trim() : '';
        const typeArg = dialog ? undefined : args[0];
        const type = dialog ? 'dialog' : (typeArg?.t === 'enum' ? typeArg.v.replace(/^#/, '').toLowerCase() : '');
        if (type !== 'notify' && type !== 'state' && type !== 'quit' && type !== 'waiting' && type !== 'dialog') { return -1; }
        const msg = args[dialog ? 0 : 1];
        const pars = args[dialog ? 1 : 2];
        let text = chars(member(msg, 'msg_txt'));
        for (let i = 1; i <= 3; i++) {
            const par = pars?.t === 'array' ? pars.v[i - 1] : undefined;
            const kind = member(par, 'par_type');
            if (!par || (kind?.t === 'enum' && /^#EMPTY$/i.test(kind.v))) { continue; }
            const txt = chars(member(par, 'par_txt'));
            const value = txt || [member(par, 'par_int'), member(par, 'par_real'), member(par, 'par_bool')]
                .filter((x): x is KrlValue => !!x && x.t !== 'undef')
                .map(x => displayValue(x))[0] || '';
            text = text.split(`%${i}`).join(value);
        }
        const softkeys: KrlMessage['softkeys'] = [];
        const keys = dialog ? args[2] : undefined;
        if (keys?.t === 'array') {
            keys.v.forEach((sk, i) => {
                const kind = member(sk, 'sk_type');
                const label = chars(member(sk, 'sk_txt'));
                if (label && !(kind?.t === 'enum' && /^#EMPTY$/i.test(kind.v))) { softkeys.push({ nr: i + 1, label }); }
            });
        }
        const message: KrlMessage = {
            handle: 0, type, module: chars(member(msg, 'modul')), nr: Math.trunc(krlNumber(member(msg, 'nr'))),
            text, softkeys, thread: thread.name, threadId: thread.id,
        };
        const same = this.messages.find(m => m.type === message.type && m.module === message.module && m.nr === message.nr
            && m.text === message.text && m.threadId === message.threadId);
        if (same) { return same.handle; }
        message.handle = ++this.krlMsgHandle;
        this.messages.push(message);
        this.onOutput(`[${thread.name}] ${type} message ${message.module} ${message.nr}: ${text}`
            + (softkeys.length > 0 ? `  [${softkeys.map(k => k.label).join(' | ')}]` : ''));
        this.opts.onMessagesChanged?.(this.getMessages());
        return message.handle;
    }

    private removeMessages(match: (m: KrlMessage) => boolean): void {
        const before = this.messages.length;
        this.messages = this.messages.filter(m => !match(m));
        if (this.messages.length !== before) { this.opts.onMessagesChanged?.(this.getMessages()); }
    }

    /** Messages and dialogs shown in the message window, oldest first. */
    getMessages(): KrlMessage[] {
        return this.messages.map(m => ({ ...m, softkeys: [...m.softkeys] }));
    }

    /**
     * The operator acknowledges a message (OK): acknowledgement and notification
     * messages, and wait messages ("Simulate"). Status messages are removed by the
     * program only; dialogs are answered. Returns an error message, or null.
     */
    acknowledgeMessage(handle: number): string | null {
        const m = this.messages.find(x => x.handle === handle);
        if (!m) { return 'the message is no longer shown'; }
        if (m.type === 'state') { return 'status messages are removed by the program (CLEAR_KRLMSG)'; }
        if (m.type === 'dialog') { return 'answer the dialog with one of its softkeys'; }
        this.removeMessages(x => x.handle === handle);
        return null;
    }

    /** "All OK": acknowledge every acknowledgement and notification message. */
    acknowledgeAllMessages(): void {
        this.removeMessages(m => m.type === 'quit' || m.type === 'notify');
    }

    /** The operator answers a dialog with a softkey; the next EXISTS_KRLDLG returns it. */
    answerDialog(handle: number, softkey: number): string | null {
        const m = this.messages.find(x => x.handle === handle);
        if (!m || m.type !== 'dialog') { return 'the dialog is no longer shown'; }
        if (!m.softkeys.some(k => k.nr === softkey)) { return `the dialog has no softkey ${softkey}`; }
        this.dialogAnswers.set(handle, softkey);
        this.removeMessages(x => x.handle === handle);
        return null;
    }

    private top(thread: KrlThread): KrlCallFrame | undefined {
        return thread.stack[thread.stack.length - 1];
    }

    // ------------------------------------------------------------------
    // output

    /**
     * Program trace lines (motions, waits) of the robot interpreter, rate limited so endless
     * loops cannot flood the console. Submit programs cannot move the robot; their WAITs
     * repeat every cycle and are not traced.
     */
    private trace(thread: KrlThread, text: string): void {
        if (this.nestedDepth > 0 || thread.role !== 'robot') { return; }
        if (text === this.lastTrace) { this.traceRepeats++; return; }
        this.flushRepeats();
        this.lastTrace = text;
        const now = Date.now();
        if (now - this.traceWindowStart >= 1000) {
            this.flushTrace();
            this.traceWindowStart = now;
            this.traceCount = 0;
        }
        if (this.traceCount < TRACE_LINES_PER_SECOND) {
            this.traceCount++;
            this.onOutput(`[${thread.name}] ${text}`);
        } else {
            this.traceSuppressed++;
        }
    }

    private flushRepeats(): void {
        if (this.traceRepeats > 0) {
            this.onOutput(`[krl] previous line repeated ${this.traceRepeats} times`);
            this.traceRepeats = 0;
        }
    }

    private flushTrace(): void {
        this.flushRepeats();
        if (this.traceSuppressed > 0) {
            this.onOutput(`[krl] ${this.traceSuppressed} further trace lines suppressed`);
            this.traceSuppressed = 0;
        }
    }

    private warnOnce(key: string, text: string): void {
        if (this.warned.has(key)) { return; }
        this.warned.add(key);
        this.onOutput(text);
    }
}


// ---------------------------------------------------------------------------
// module-level helpers

/**
 * printf-like formatting of SWRITE: %d %i %u %x %X %f %e %E %g %G %c %s with flags,
 * width and precision. Returns the text and the number of parameters used.
 */
function formatKrl(format: string, params: KrlValue[], textOf: (v: KrlValue | undefined) => string): { text: string; hits: number } {
    let next = 0;
    let hits = 0;
    const text = format.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([diuxXfeEgGcsr%])/g, (_all, flags: string, width: string, prec: string | undefined, type: string) => {
        if (type === '%') { return '%'; }
        const v = params[next++];
        if (!v) { return ''; }
        hits++;
        const num = krlNumber(v);
        const digits = prec !== undefined ? Number(prec) : 6;
        let s: string;
        switch (type) {
            case 'd': case 'i': case 'u': s = String(Math.trunc(num)); break;
            case 'x': s = (Math.trunc(num) >>> 0).toString(16); break;
            case 'X': s = (Math.trunc(num) >>> 0).toString(16).toUpperCase(); break;
            case 'f': s = num.toFixed(digits); break;
            case 'e': s = num.toExponential(digits); break;
            case 'E': s = num.toExponential(digits).toUpperCase(); break;
            case 'g': s = String(Number(num.toPrecision(Math.max(1, digits)))); break;
            case 'G': s = String(Number(num.toPrecision(Math.max(1, digits)))).toUpperCase(); break;
            case 'c': s = v.t === 'char' ? v.v : String.fromCharCode(Math.trunc(num)); break;
            default: s = textOf(v) || displayValue(v); break;
        }
        if (/[diufeEgG]/.test(type) && flags.includes('+') && num >= 0) { s = `+${s}`; }
        const w = Number(width || 0);
        if (s.length < w) {
            s = flags.includes('-') ? s.padEnd(w) : flags.includes('0') && /[diuxXfeEgG]/.test(type) ? s.padStart(w, '0') : s.padStart(w);
        }
        return s;
    });
    return { text, hits };
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** The .dat file next to a program, matched case-insensitively. */
function siblingDat(programPath: string): string | null {
    const dir = path.dirname(programPath);
    const want = path.basename(programPath).replace(/\.[^.]+$/, '').toLowerCase() + '.dat';
    try {
        const hit = fs.readdirSync(dir).find(n => n.toLowerCase() === want);
        return hit ? path.join(dir, hit) : null;
    } catch {
        return null;
    }
}

/** Find the first top-level assignment '=' that is not part of == <= >= <>. */
export function findSingleEq(text: string): number {
    let depth = 0;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) { quote = ''; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') { depth--; continue; }
        if (c === '=' && depth === 0) {
            const prev = i > 0 ? text[i - 1] : '';
            const next = i + 1 < text.length ? text[i + 1] : '';
            if (!'=!<>'.includes(prev) && next !== '=' && next !== '>') { return i; }
        }
    }
    return -1;
}

interface LValue { base: string; segments: { kind: 'index' | 'member'; text: string }[] }

/** Parse "A.B[1,2].C" into its base name and member/index segments; null if not an lvalue. */
function parseLValue(text: string): LValue | null {
    const src = text.trim();
    const m = /^([A-Za-z_$][\w$]*)/.exec(src);
    if (!m) { return null; }
    const segments: LValue['segments'] = [];
    let rest = src.slice(m[0].length).trimStart();
    while (rest.length > 0) {
        if (rest.startsWith('.')) {
            const mm = /^\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
            if (!mm) { return null; }
            segments.push({ kind: 'member', text: mm[1] });
            rest = rest.slice(mm[0].length).trimStart();
            continue;
        }
        if (rest.startsWith('[')) {
            const close = findClosing(rest, 0);
            if (close < 0) { return null; }
            segments.push({ kind: 'index', text: rest.slice(1, close) });
            rest = rest.slice(close + 1).trimStart();
            continue;
        }
        return null;
    }
    return { base: m[1], segments };
}

/** Expression for element `index` of the array at `path`; an inner dimension continues the index list: A[1] -> A[1,2]. */
function elementPath(path: string, index: number): string {
    const base = path.replace(/\[\s*\]$/, '');
    return base.endsWith(']') ? `${base.slice(0, -1)},${index}]` : `${base}[${index}]`;
}

function ensureArray(v: KrlValue): void {
    if (v.t === 'undef') {
        const a = v as unknown as { t: 'array'; v: KrlValue[] };
        a.t = 'array';
        a.v = [];
    }
}

function upgradeToStruct(v: KrlValue): void {
    if (v.t === 'undef') {
        const s = v as unknown as { t: 'struct'; name: string; v: Map<string, KrlValue> };
        s.t = 'struct';
        s.name = 'STRUCT';
        s.v = new Map();
    }
}
