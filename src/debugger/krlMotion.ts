// krlMotion.ts
// How long the simulated robot needs for a motion. The robot's characteristics
// come from its machine data (KRC/R1/Mada/$machine.dat: motor speed and gear
// ratio per axis, $VEL_MA / $ACC_MA, arm lengths) or from a standard robot.
// Each motion gets a velocity profile with acceleration and braking ramps:
//   PTP   the axes move synchronized; the axis that needs longest leads
//   LIN   path length at $VEL.CP / $ACC.CP, orientation change at $VEL.ORI1
//   CIRC  arc length (circular angle CA included), orientation like LIN
// A program override scales the velocity by k and the acceleration by k², so
// the robot follows the same path in 1/k of the time.
// PTP motions to Cartesian targets need the axis travel: without the full
// kinematics it is estimated with an arm model (A1 turns, A2/A3 reach out,
// the wrist follows the orientation change).
// Pure logic (no vscode imports).

import { frameMatrix } from './krlRobotFormat';

export type Vec3 = [number, number, number];

export interface PathLimits {
    /** path [m/s, m/s²] */
    cp: number;
    /** swivel [deg/s, deg/s²] */
    ori1: number;
    /** rotation [deg/s, deg/s²] */
    ori2: number;
}

export interface ArmGeometry {
    /** A2 above the robot base ($TIRORO.Z) [mm] */
    height: number;
    /** A1 to A2 ($LENGTH_A) [mm] */
    a: number;
    /** A2 to A3 ($LENGTH_B) [mm] */
    b: number;
    /** A3 to the wrist point along and across the forearm ($TX3P3.X / .Z) [mm] */
    foreX: number;
    foreZ: number;
    /** wrist point to flange ($TFLWP.Z) [mm] */
    flange: number;
}

export interface RobotCharacteristics {
    /** the $machine.dat they come from, null for the standard robot */
    source: string | null;
    /** robot type ($TRAFONAME) */
    name: string;
    numAxes: number;
    /** A1..A6, E1..E6: maximum velocity [deg/s or mm/s] */
    axisVel: number[];
    /** A1..A6, E1..E6: acceleration at 100 % $ACC_AXIS [deg/s² or mm/s²] */
    axisAcc: number[];
    /** $VEL_MA, $ACC_MA */
    velMa: PathLimits;
    accMa: PathLimits;
    /** T1 (manual reduced velocity): path velocity limit $VEL_CP_T1 [m/s] and axis velocity reduction $RED_T1 [%] */
    velCpT1: number;
    redT1: number;
    arm: ArmGeometry;
}

/** Operating mode ($MODE_OP): manual reduced / high velocity, automatic, automatic external. */
export type KrlMode = 'T1' | 'T2' | 'AUT' | 'EX';
export const KRL_MODES: KrlMode[] = ['T1', 'T2', 'AUT', 'EX'];

/** time the axes need to reach full speed at 100 % $ACC_AXIS when the machine data has no $RAISE_TIME */
export const DEFAULT_RAISE_TIME_S = 0.25;
const AXIS_COUNT = 12;

/** A medium-size 6-axis robot, used when no machine data is found. */
export const STANDARD_ROBOT: RobotCharacteristics = (() => {
    const axisVel = [200, 200, 195, 370, 310, 610, 300, 300, 300, 300, 300, 300];
    return {
        source: null,
        name: 'standard 6-axis robot',
        numAxes: 6,
        axisVel,
        axisAcc: axisVel.map(v => v / DEFAULT_RAISE_TIME_S),
        velMa: { cp: 3, ori1: 400, ori2: 400 },
        accMa: { cp: 10, ori1: 1000, ori2: 1000 },
        velCpT1: 0.25,
        redT1: 10,
        arm: { height: 675, a: 260, b: 680, foreX: 670, foreZ: -35, flange: 115 },
    };
})();

// ---------------------------------------------------------------------------
// machine data

function members(text: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g)) { out.set(m[1].toLowerCase(), Number(m[2])); }
    return out;
}

/**
 * Robot characteristics from the text of $machine.dat; whatever is missing
 * comes from the standard robot.
 *   axis velocity [deg/s] = $VEL_AXIS_MA [rpm] * 360 / 60 * |D / N| of $RAT_MOT_AX
 *   axis acceleration     = axis velocity / $RAISE_TIME (or DEFAULT_RAISE_TIME_S)
 */
export function parseMachineData(text: string, source: string): RobotCharacteristics {
    const indexed = (name: string): Map<number, string> => {
        const out = new Map<number, string>();
        const re = new RegExp(`^\\s*\\$${name}\\[(\\d+)\\]\\s*=\\s*(.+?)\\s*(?:;.*)?$`, 'gim');
        for (const m of text.matchAll(re)) { out.set(Number(m[1]), m[2]); }
        return out;
    };
    const scalar = (name: string): string | null => {
        const m = new RegExp(`^\\s*(?:DECL\\s+)?(?:\\w+\\s+)?\\$${name}\\s*=\\s*(.+?)\\s*(?:;.*)?$`, 'im').exec(text);
        return m ? m[1] : null;
    };
    const struct = (name: string): Map<string, number> | null => {
        const v = scalar(name);
        const m = v ? /^\{([^}]*)\}/.exec(v) : null;
        return m ? members(m[1]) : null;
    };
    const number = (name: string): number | null => {
        const v = scalar(name);
        const n = v === null ? NaN : Number(v);
        return Number.isFinite(n) ? n : null;
    };

    const std = STANDARD_ROBOT;
    const rpm = indexed('VEL_AXIS_MA');
    const ratio = indexed('RAT_MOT_AX');
    const raise = indexed('RAISE_TIME');
    const numAxes = number('NUM_AX') ?? 6;
    const axisVel: number[] = [];
    const axisAcc: number[] = [];
    for (let i = 1; i <= AXIS_COUNT; i++) {
        const r = Number(rpm.get(i));
        const g = members(ratio.get(i) ?? '');
        const n = g.get('n') ?? 0;
        const d = g.get('d') ?? 0;
        const vel = r > 0 && n !== 0 && d !== 0 ? r * 6 * Math.abs(d / n) : std.axisVel[i - 1];
        const raiseMs = Number(raise.get(i));
        axisVel.push(vel);
        axisAcc.push(vel / (raiseMs > 0 ? raiseMs / 1000 : DEFAULT_RAISE_TIME_S));
    }
    const limits = (name: string, fallback: PathLimits): PathLimits => {
        const s = struct(name);
        const pick = (k: keyof PathLimits) => { const v = s?.get(k); return v !== undefined && v > 0 ? v : fallback[k]; };
        return { cp: pick('cp'), ori1: pick('ori1'), ori2: pick('ori2') };
    };
    const tiroro = struct('TIRORO');
    const tx3p3 = struct('TX3P3');
    const tflwp = struct('TFLWP');
    const velCpT1 = number('VEL_CP_T1');
    const redT1 = number('RED_T1');
    const lengthA = number('LENGTH_A');
    const lengthB = number('LENGTH_B');
    // without the main lengths the arm model of the standard robot is used as a whole
    const arm: ArmGeometry = lengthB && lengthB > 0 && tx3p3 ? {
        height: tiroro?.get('z') ?? 0,
        a: lengthA ?? 0,
        b: lengthB,
        foreX: tx3p3.get('x') ?? 0,
        foreZ: tx3p3.get('z') ?? 0,
        flange: tflwp?.get('z') ?? 0,
    } : { ...std.arm };
    const name = /^\s*\$TRAFONAME\[\]\s*=\s*"([^"]*)"/im.exec(text)?.[1].trim();
    return {
        source,
        name: name || 'robot',
        numAxes,
        axisVel,
        axisAcc,
        velMa: limits('VEL_MA', std.velMa),
        accMa: limits('ACC_MA', std.accMa),
        // T1 never exceeds 250 mm/s
        velCpT1: velCpT1 && velCpT1 > 0 ? Math.min(0.25, velCpT1) : std.velCpT1,
        redT1: redT1 && redT1 > 0 ? Math.min(100, redT1) : std.redT1,
        arm,
    };
}

// ---------------------------------------------------------------------------
// velocity profile

/**
 * Velocity over time for a distance: accelerate from v0 to vp, cruise, brake
 * to v1. Times in seconds; distance, velocities and acceleration in the units
 * of the moved quantity (mm, deg).
 */
export interface Profile {
    distance: number;
    acc: number;
    v0: number;
    vp: number;
    v1: number;
    ta: number;
    tc: number;
    td: number;
    /** total time [s] */
    t: number;
}

const ZERO_PROFILE: Profile = { distance: 0, acc: 0, v0: 0, vp: 0, v1: 0, ta: 0, tc: 0, td: 0, t: 0 };

/**
 * Plan a profile: from standstill (or already at speed when the motion before
 * was approximated) to standstill (or at speed into an approximated motion).
 * A short distance does not reach the velocity: the profile becomes a triangle.
 */
export function planProfile(distance: number, vel: number, acc: number, startMoving = false, endMoving = false): Profile {
    if (!(distance > 0) || !(vel > 0)) { return { ...ZERO_PROFILE }; }
    if (!(acc > 0) || !Number.isFinite(acc)) {
        return { distance, acc: 0, v0: vel, vp: vel, v1: vel, ta: 0, tc: distance / vel, td: 0, t: distance / vel };
    }
    let v0 = startMoving ? vel : 0;
    let v1 = endMoving ? vel : 0;
    let vp = vel;
    const ramp = (from: number, to: number) => Math.abs(to * to - from * from) / (2 * acc);
    if (ramp(v0, vp) + ramp(vp, v1) > distance) {
        vp = Math.sqrt((2 * acc * distance + v0 * v0 + v1 * v1) / 2);
        if (v0 > vp) {
            // already too fast to brake to v1: brake only, from the speed that just makes it
            v0 = vp = Math.sqrt(2 * acc * distance + v1 * v1);
        } else if (v1 > vp) {
            // accelerate only, up to the speed reached at the end
            v1 = vp = Math.sqrt(2 * acc * distance + v0 * v0);
        }
    }
    const ta = (vp - v0) / acc;
    const td = (vp - v1) / acc;
    const tc = Math.max(0, (distance - ramp(v0, vp) - ramp(vp, v1)) / vp);
    return { distance, acc, v0, vp, v1, ta, tc, td, t: ta + tc + td };
}

/** Where the profile is after `t` seconds: covered distance, velocity and acceleration. */
export function profileAt(p: Profile, t: number): { s: number; v: number; a: number } {
    if (p.t <= 0 || t >= p.t) { return { s: p.distance, v: p.t > 0 ? p.v1 : 0, a: 0 }; }
    if (t <= 0) { return { s: 0, v: p.v0, a: p.ta > 0 ? p.acc : 0 }; }
    if (t < p.ta) { return { s: p.v0 * t + p.acc * t * t / 2, v: p.v0 + p.acc * t, a: p.acc }; }
    const sa = (p.v0 + p.vp) / 2 * p.ta;
    if (t < p.ta + p.tc) { return { s: sa + p.vp * (t - p.ta), v: p.vp, a: 0 }; }
    const u = t - p.ta - p.tc;
    return { s: Math.min(p.distance, sa + p.vp * p.tc + p.vp * u - p.acc * u * u / 2), v: Math.max(0, p.vp - p.acc * u), a: -p.acc };
}

// ---------------------------------------------------------------------------
// geometry

const RAD = Math.PI / 180;

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, k: number): Vec3 { return [a[0] * k, a[1] * k, a[2] * k]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function distance(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** Angle [deg] of the rotation from one A, B, C orientation to another. */
export function orientationAngle(from: Vec3, to: Vec3): number {
    const r1 = frameMatrix(0, 0, 0, from[0], from[1], from[2]);
    const r2 = frameMatrix(0, 0, 0, to[0], to[1], to[2]);
    let trace = 0;
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { trace += r1[i][j] * r2[i][j]; } }
    return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) / RAD;
}

/** Difference of two angles [deg], the short way round (-180 .. 180). */
export function angleDelta(from: number, to: number): number {
    let d = (to - from) % 360;
    if (d > 180) { d -= 360; }
    if (d < -180) { d += 360; }
    return d;
}

/** A circle through the start, auxiliary and end point of a CIRC; `angle` runs from the start via the auxiliary point. */
export interface Arc {
    center: Vec3;
    /** unit vectors spanning the circle: u towards the start, v 90° further in the direction of motion */
    u: Vec3;
    v: Vec3;
    radius: number;
    /** signed angle of the motion [rad] */
    angle: number;
}

/**
 * The arc of a CIRC from `start` via `aux` to `end`, or over the circular angle
 * CA [deg] (negative: against the direction start -> aux -> end). Null when the
 * points are on a line.
 */
export function circleThrough(start: Vec3, aux: Vec3, end: Vec3, caDeg?: number): Arc | null {
    const a = sub(aux, start);
    const b = sub(end, start);
    const n = cross(a, b);
    const n2 = dot(n, n);
    if (n2 < 1e-9 * Math.max(1, dot(a, a) * dot(b, b))) { return null; }
    const rel = scale(cross(sub(scale(b, dot(a, a)), scale(a, dot(b, b))), n), 1 / (2 * n2));
    const center = add(start, rel);
    const radius = Math.hypot(...rel);
    const u = scale(sub(start, center), 1 / radius);
    const v = cross(scale(n, 1 / Math.sqrt(n2)), u);
    const angleOf = (p: Vec3) => {
        const d = sub(p, center);
        const ang = Math.atan2(dot(d, v), dot(d, u));
        return ang < 0 ? ang + 2 * Math.PI : ang;
    };
    const angle = caDeg !== undefined && Number.isFinite(caDeg) && caDeg !== 0 ? caDeg * RAD : angleOf(end);
    return { center, u, v, radius, angle };
}

/** The point at `fraction` (0..1) of the arc. */
export function arcPoint(arc: Arc, fraction: number): Vec3 {
    const phi = arc.angle * fraction;
    return add(arc.center, add(scale(arc.u, arc.radius * Math.cos(phi)), scale(arc.v, arc.radius * Math.sin(phi))));
}

/**
 * Flange position for axis angles [deg] in the arm model: A1 turns about the
 * vertical (positive clockwise seen from above), A2 lifts the upper arm (-90 =
 * upright), A3 bends the forearm (90 = at right angles to the upper arm), A4..A6
 * turn the wrist. At HOME {A1 0, A2 -90, A3 90, A4 0, A5 0, A6 0} the flange
 * points forward.
 */
export function armPosition(arm: ArmGeometry, axes: number[]): Vec3 {
    const [a1, a2, a3, a4, a5] = [0, 1, 2, 3, 4].map(i => (axes[i] ?? 0) * RAD);
    const theta = a2 + a3;
    // in the arm plane: r forward from A1, y to the left, z up
    const pitch = (x: number, z: number): [number, number] => [x * Math.cos(theta) + z * Math.sin(theta), -x * Math.sin(theta) + z * Math.cos(theta)];
    const [er, ez] = [arm.a + arm.b * Math.cos(-a2), arm.height + arm.b * Math.sin(-a2)];
    const [wr, wz] = pitch(arm.foreX, arm.foreZ);
    // flange: the wrist bends by A5 about the turned A4 axis
    const fx = arm.flange * Math.cos(a5);
    const fy = arm.flange * Math.sin(a5) * Math.sin(-a4);
    const fz = -arm.flange * Math.sin(a5) * Math.cos(-a4);
    const [fr, fzz] = pitch(fx, fz);
    const r = er + wr + fr;
    const y = fy;
    const z = ez + wz + fzz;
    const phi = -a1;
    return [r * Math.cos(phi) - y * Math.sin(phi), r * Math.sin(phi) + y * Math.cos(phi), z];
}

/**
 * Estimated A1, A2, A3 [deg] that bring the flange to a point (arm in front,
 * elbow up, wrist straight). `fallback` keeps A1 when the point is on the A1 axis.
 */
export function armAngles(arm: ArmGeometry, p: Vec3, fallback: number[] = []): [number, number, number] {
    const horizontal = Math.hypot(p[0], p[1]);
    const a1 = horizontal < 1e-6 ? fallback[0] ?? 0 : -Math.atan2(p[1], p[0]) / RAD;
    const r = horizontal - arm.a;
    const z = p[2] - arm.height;
    const l2 = arm.b;
    const fx = arm.foreX + arm.flange;
    const l3 = Math.hypot(fx, arm.foreZ);
    const delta = Math.atan2(arm.foreZ, fx);
    if (l2 <= 0 || l3 <= 0) { return [a1, fallback[1] ?? -90, fallback[2] ?? 90]; }
    const d = Math.max(Math.abs(l2 - l3) + 1e-6, Math.min(l2 + l3 - 1e-6, Math.hypot(r, z)));
    const beta = Math.acos(Math.max(-1, Math.min(1, (l2 * l2 + d * d - l3 * l3) / (2 * l2 * d))));
    const up = Math.atan2(z, r) + beta;
    const er = l2 * Math.cos(up);
    const ez = l2 * Math.sin(up);
    const fore = Math.atan2(z - ez, r - er);
    const a2 = -up;
    const a3 = delta - fore - a2;
    return [a1, a2 / RAD, a3 / RAD];
}

// ---------------------------------------------------------------------------
// motion timing

export type MotionKind = 'PTP' | 'LIN' | 'CIRC';

/** Where the robot is (estimated where the simulator has no kinematics). */
export interface RobotPose {
    /** A1..A6, E1..E6 [deg, mm] */
    axes: number[];
    /** TCP position [mm] */
    point: Vec3;
    /** A, B, C [deg], null when unknown */
    ori: Vec3 | null;
}

export interface MotionRequest {
    kind: MotionKind;
    robot: RobotCharacteristics;
    start: RobotPose;
    end: RobotPose;
    /** CIRC: the arc; null for a straight line */
    arc: Arc | null;
    /** PTP: the target is Cartesian, the axis travel is estimated */
    cartesian: boolean;
    /** $VEL_AXIS / $ACC_AXIS [%] per axis (0: 100 %) */
    velAxis: number[];
    accAxis: number[];
    /** $VEL / $ACC (0: the BAS defaults) */
    vel: PathLimits;
    acc: PathLimits;
    /** $OV_PRO [%] */
    override: number;
    /** operating mode: T1 reduces the velocity ($VEL_CP_T1, $RED_T1); omitted: automatic */
    mode?: KrlMode;
    /** the motion before is approximated / this one is */
    blendIn: boolean;
    blendOut: boolean;
}

export interface MotionTiming {
    kind: MotionKind;
    /** what takes longest: 'A1'..'E6', 'path' or 'orientation' */
    lead: string;
    /** velocity profile of the leading quantity */
    profile: Profile;
    /** TCP travel [mm] (straight line for PTP, estimated for axis targets) */
    path: number;
    /** PTP: travel of each axis [deg, mm] */
    axisTravel: number[];
    /** limit of the leading quantity: velocity at 100 % override [deg/s, mm/s] */
    leadVelocity: number;
    /** total time [ms] */
    ms: number;
}

/** BAS defaults when a program has not set $VEL / $ACC */
export const DEFAULT_VEL: PathLimits = { cp: 2, ori1: 200, ori2: 200 };
export const DEFAULT_ACC: PathLimits = { cp: 2.3, ori1: 100, ori2: 100 };

export function axisName(i: number): string {
    return i < 6 ? `A${i + 1}` : `E${i - 5}`;
}

/** The axis travel of a PTP motion: exact for axis targets, estimated with the arm model for Cartesian ones. */
export function ptpTravel(req: Pick<MotionRequest, 'robot' | 'start' | 'end' | 'cartesian'>): number[] {
    const travel: number[] = [];
    for (let i = 0; i < AXIS_COUNT; i++) { travel.push(Math.abs((req.end.axes[i] ?? 0) - (req.start.axes[i] ?? 0))); }
    if (req.cartesian) {
        const from = armAngles(req.robot.arm, req.start.point, req.start.axes);
        const to = armAngles(req.robot.arm, req.end.point, req.start.axes);
        travel[0] = Math.abs(angleDelta(from[0], to[0]));
        travel[1] = Math.abs(to[1] - from[1]);
        travel[2] = Math.abs(to[2] - from[2]);
        const wrist = req.start.ori && req.end.ori ? orientationAngle(req.start.ori, req.end.ori) : 0;
        travel[3] = travel[4] = travel[5] = wrist;
    }
    return travel;
}

/** How long a motion takes, and its velocity profile. */
export function planTiming(req: MotionRequest): MotionTiming {
    const k = Math.max(0.01, Math.min(100, req.override > 0 ? req.override : 100)) / 100;
    const pct = (list: number[], i: number) => { const p = list[i] ?? 0; return (p > 0 ? p : 100) / 100; };
    const robot = req.robot;
    // T1: axes and orientation at $RED_T1 %, the path at most $VEL_CP_T1
    const t1 = req.mode === 'T1' ? robot.redT1 / 100 : 1;
    let best: { lead: string; profile: Profile; velocity: number } = { lead: '', profile: { ...ZERO_PROFILE }, velocity: 0 };
    const consider = (lead: string, dist: number, vel: number, acc: number) => {
        const profile = planProfile(dist, vel * k, acc * k * k, req.blendIn, req.blendOut);
        if (profile.t > best.profile.t) { best = { lead, profile, velocity: vel }; }
    };
    let axisTravel: number[] = [];
    let path: number;
    if (req.kind === 'PTP') {
        axisTravel = ptpTravel(req);
        for (let i = 0; i < AXIS_COUNT; i++) {
            if (axisTravel[i] > 1e-9) { consider(axisName(i), axisTravel[i], robot.axisVel[i] * pct(req.velAxis, i) * t1, robot.axisAcc[i] * pct(req.accAxis, i)); }
        }
        path = distance(req.start.point, req.end.point);
    } else {
        path = req.arc ? Math.abs(req.arc.angle) * req.arc.radius : distance(req.start.point, req.end.point);
        const limit = (v: number, fallback: number, max: number) => Math.min(v > 0 ? v : fallback, max);
        const cp = limit(req.vel.cp, DEFAULT_VEL.cp, robot.velMa.cp);
        consider('path', path, (req.mode === 'T1' ? Math.min(cp, robot.velCpT1) : cp) * 1000, limit(req.acc.cp, DEFAULT_ACC.cp, robot.accMa.cp) * 1000);
        const turn = req.start.ori && req.end.ori ? orientationAngle(req.start.ori, req.end.ori) : 0;
        if (turn > 1e-6) {
            consider('orientation', turn, limit(req.vel.ori1, DEFAULT_VEL.ori1, robot.velMa.ori1) * t1, limit(req.acc.ori1, DEFAULT_ACC.ori1, robot.accMa.ori1));
        }
        // external axes move along
        for (let i = 6; i < AXIS_COUNT; i++) {
            const d = Math.abs((req.end.axes[i] ?? 0) - (req.start.axes[i] ?? 0));
            if (d > 1e-9) { consider(axisName(i), d, robot.axisVel[i] * t1, robot.axisAcc[i]); }
        }
    }
    return {
        kind: req.kind, lead: best.lead, profile: best.profile, path, axisTravel,
        leadVelocity: best.velocity, ms: best.profile.t * 1000,
    };
}

/**
 * The motion `elapsedMs` after its start: fraction of the way (0..1), TCP
 * velocity [mm/s] and acceleration [mm/s²], and the axis velocities [deg/s]
 * of a PTP motion.
 */
export function motionState(timing: MotionTiming, elapsedMs: number): { fraction: number; velocity: number; acceleration: number; axisVelocity: number[] } {
    const p = timing.profile;
    if (p.distance <= 0) { return { fraction: 1, velocity: 0, acceleration: 0, axisVelocity: timing.axisTravel.map(() => 0) }; }
    const at = profileAt(p, elapsedMs / 1000);
    const per = 1 / p.distance;
    return {
        fraction: Math.max(0, Math.min(1, at.s * per)),
        velocity: at.v * per * timing.path,
        acceleration: at.a * per * timing.path,
        axisVelocity: timing.axisTravel.map(d => at.v * per * d),
    };
}
