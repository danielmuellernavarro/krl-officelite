// krlCatalog.ts
// What KRL itself provides: system variables (type, access, unit), the
// standard functions and procedures with their parameters, keywords, the
// predefined types and their members, and the enumeration literals of the
// system types. Used by completion, signature help, hovers and diagnostics.
// Pure logic (no vscode imports).

import { builtinStructMembers, StructMember } from '../debugger/krlValue';

export type Access = 'R' | 'RW';

export interface SystemVariable {
    name: string;
    /** type as shown, e.g. E6POS, BOOL[], VEL */
    type: string;
    access: Access;
    doc: string;
    unit?: string;
    /** structure type of the variable or of its elements, for member completion */
    struct?: string;
    /** enumeration type of the variable or of its elements, for `#` completion */
    enumType?: string;
    /** valid range of the value (or of the elements) */
    range?: [number, number];
    /** valid range of the index of an array */
    index?: [number, number];
    /** reading or writing it in the robot program triggers an advance run stop */
    advanceStop?: boolean;
}

const SYSTEM_VARIABLE_LIST: SystemVariable[] = [
    // --- robot position --------------------------------------------------------------------
    { name: '$POS_ACT', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'Current Cartesian robot position: the TCP relative to the active BASE.' },
    { name: '$AXIS_ACT', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', advanceStop: true, doc: 'Current axis-specific robot position (degrees; mm for linear axes).' },
    { name: '$POS_ACT_MES', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'Measured Cartesian robot position.' },
    { name: '$AXIS_ACT_MEAS', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', doc: 'Measured axis-specific robot position.' },
    { name: '$POS_INT', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'Cartesian position at which the interrupt was triggered.' },
    { name: '$AXIS_INT', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', advanceStop: true, doc: 'Axis-specific position at which the interrupt was triggered.' },
    { name: '$POS_RET', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'Cartesian position at which the robot left the programmed path.' },
    { name: '$AXIS_RET', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', advanceStop: true, doc: 'Axis-specific position at which the robot left the programmed path.' },
    { name: '$POS_BACK', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'Start position of the current motion block (Cartesian).' },
    { name: '$POS_FOR', type: 'E6POS', struct: 'E6POS', access: 'R', advanceStop: true, doc: 'End position of the current motion block (Cartesian).' },
    { name: '$AXIS_BACK', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', advanceStop: true, doc: 'Start position of the current motion block (axis-specific).' },
    { name: '$AXIS_FOR', type: 'E6AXIS', struct: 'E6AXIS', access: 'R', advanceStop: true, doc: 'End position of the current motion block (axis-specific).' },
    { name: '$H_POS', type: 'E6AXIS', struct: 'E6AXIS', access: 'RW', doc: 'HOME position (axis-specific). Set by the PTP HOME inline form.' },
    // --- coordinate systems, tool and load ---------------------------------------------------
    { name: '$TOOL', type: 'FRAME', struct: 'FRAME', access: 'RW', doc: 'Active TOOL coordinate system: the TCP relative to the flange. Usually `TOOL_DATA[n]`.' },
    { name: '$BASE', type: 'FRAME', struct: 'FRAME', access: 'RW', doc: 'Active BASE coordinate system relative to WORLD. Usually `BASE_DATA[n]`.' },
    { name: '$ROBROOT', type: 'FRAME', struct: 'FRAME', access: 'R', doc: 'ROBROOT coordinate system: the robot foot relative to WORLD (machine data).' },
    { name: '$WORLD', type: 'FRAME', struct: 'FRAME', access: 'R', doc: 'WORLD coordinate system.' },
    { name: '$NULLFRAME', type: 'FRAME', struct: 'FRAME', access: 'R', doc: 'Zero frame {X 0, Y 0, Z 0, A 0, B 0, C 0}.' },
    { name: '$IPO_MODE', type: 'IPO_MODE', enumType: 'IPO_MODE', access: 'RW', doc: 'Interpolation mode: `#BASE` (tool on the flange) or `#TCP` (fixed tool).' },
    { name: '$ACT_TOOL', type: 'INT', access: 'RW', doc: 'Number of the active tool (index into TOOL_DATA), set by the inline forms through BAS.' },
    { name: '$ACT_BASE', type: 'INT', access: 'RW', doc: 'Number of the active base (index into BASE_DATA), set by the inline forms through BAS.' },
    { name: '$ACT_EX_AX', type: 'INT', access: 'RW', doc: 'Number of the active external kinematic system.' },
    { name: '$LOAD', type: 'LOAD', struct: 'LOAD', access: 'RW', doc: 'Payload data of the active tool: mass M (kg), center of mass CM (FRAME), inertia J (kg m²).' },
    { name: '$LOAD_A1', type: 'LOAD', struct: 'LOAD', access: 'RW', doc: 'Supplementary load on axis 1.' },
    { name: '$LOAD_A2', type: 'LOAD', struct: 'LOAD', access: 'RW', doc: 'Supplementary load on axis 2.' },
    { name: '$LOAD_A3', type: 'LOAD', struct: 'LOAD', access: 'RW', doc: 'Supplementary load on axis 3.' },
    // --- motion parameters --------------------------------------------------------------------
    { name: '$VEL', type: 'VEL', struct: 'VEL', access: 'RW', doc: 'Velocity of CP motions: `CP` path velocity (m/s), `ORI1` swivel and `ORI2` rotational velocity (°/s).' },
    { name: '$ACC', type: 'ACC', struct: 'ACC', access: 'RW', doc: 'Acceleration of CP motions: `CP` (m/s²), `ORI1`, `ORI2` (°/s²).' },
    { name: '$VEL_AXIS', type: 'INT[]', access: 'RW', unit: '%', range: [1, 100], index: [1, 12], doc: 'Axis velocity of PTP motions in % of the maximum axis velocity.' },
    { name: '$ACC_AXIS', type: 'INT[]', access: 'RW', unit: '%', range: [1, 100], index: [1, 12], doc: 'Axis acceleration of PTP motions in % of the maximum.' },
    { name: '$VEL_EXTAX', type: 'INT[]', access: 'RW', unit: '%', range: [1, 100], index: [1, 6], doc: 'Velocity of the external axes in % of the maximum.' },
    { name: '$ACC_EXTAX', type: 'INT[]', access: 'RW', unit: '%', range: [1, 100], index: [1, 6], doc: 'Acceleration of the external axes in % of the maximum.' },
    { name: '$APO', type: 'APO', struct: 'APO', access: 'RW', doc: 'Approximate positioning: `CDIS` distance (mm), `CORI` orientation (°), `CVEL` velocity (%), `CPTP` PTP (%).' },
    { name: '$ORI_TYPE', type: 'ORI_TYPE', enumType: 'ORI_TYPE', access: 'RW', doc: 'Orientation control of CP motions: `#CONSTANT`, `#VAR` or `#JOINT`.' },
    { name: '$CIRC_TYPE', type: 'CIRC_TYPE', enumType: 'CIRC_TYPE', access: 'RW', doc: 'Orientation control of CIRC motions: `#BASE` or `#PATH`.' },
    { name: '$ADVANCE', type: 'INT', access: 'RW', range: [0, 5], doc: 'Number of motion blocks the advance run may plan ahead of the main run (default 3, maximum 5).' },
    { name: '$OV_PRO', type: 'INT', access: 'RW', unit: '%', range: [0, 100], advanceStop: true, doc: 'Program override in % (0 … 100). Must not be written in the test modes T1/T2.' },
    { name: '$VEL_ACT', type: 'REAL', access: 'R', unit: 'm/s', doc: 'Current Cartesian path velocity (m/s).' },
    { name: '$VEL_AXIS_ACT', type: 'REAL[]', access: 'R', unit: '%', index: [1, 12], doc: 'Current axis velocity in % of the maximum.' },
    { name: '$TORQUE_AXIS_ACT', type: 'REAL[]', access: 'R', unit: 'Nm', index: [1, 12], advanceStop: true, doc: 'Current torque of the axes.' },
    { name: '$CURR_ACT', type: 'REAL[]', access: 'R', unit: '%', index: [1, 12], doc: 'Current motor current in % of the maximum.' },
    { name: '$DISTANCE', type: 'REAL', access: 'R', unit: 'mm', doc: 'Distance traveled along the path of the current motion.' },
    { name: '$PAL_MODE', type: 'BOOL', access: 'RW', advanceStop: true, doc: 'Palletizing mode.' },
    { name: '$BWDSTART', type: 'BOOL', access: 'RW', doc: 'Backward motion start flag, reset by the motion inline forms.' },
    // --- inputs and outputs, flags, timers -----------------------------------------------------
    { name: '$IN', type: 'BOOL[]', access: 'R', index: [1, 8192], advanceStop: true, doc: 'Digital input (4096 by default, at most 8192). Write-protected for programs.' },
    { name: '$OUT', type: 'BOOL[]', access: 'RW', index: [1, 8192], advanceStop: true, doc: 'Digital output (4096 by default, at most 8192).' },
    { name: '$OUT_C', type: 'BOOL[]', access: 'RW', index: [1, 8192], doc: 'Digital output set in the main run, without an advance run stop.' },
    { name: '$ANIN', type: 'REAL[]', access: 'R', index: [1, 32], range: [-1, 1], advanceStop: true, doc: 'Analog input (-1.0 … 1.0).' },
    { name: '$ANOUT', type: 'REAL[]', access: 'RW', index: [1, 32], range: [-1, 1], advanceStop: true, doc: 'Analog output (-1.0 … 1.0).' },
    { name: '$FLAG', type: 'BOOL[]', access: 'RW', index: [1, 1024], doc: 'Flag (global Boolean memory bit).' },
    { name: '$CYCFLAG', type: 'BOOL[]', access: 'RW', index: [1, 256], doc: 'Cyclical flag: a Boolean expression assigned to it is evaluated cyclically in the background.' },
    { name: '$TIMER', type: 'INT[]', access: 'RW', unit: 'ms', index: [1, 64], doc: 'Timer in ms. Counts while `$TIMER_STOP[n]` is FALSE.' },
    { name: '$TIMER_STOP', type: 'BOOL[]', access: 'RW', index: [1, 64], doc: 'TRUE stops the timer, FALSE starts it.' },
    { name: '$TIMER_FLAG', type: 'BOOL[]', access: 'R', index: [1, 64], doc: 'TRUE as soon as the timer is greater than or equal to 0.' },
    // --- operating mode and program state ------------------------------------------------------
    { name: '$MODE_OP', type: 'MODE_OP', enumType: 'MODE_OP', access: 'R', advanceStop: true, doc: 'Operating mode: `#T1`, `#T2`, `#AUT`, `#EX` (automatic external) or `#INVALID`.' },
    { name: '$PRO_STATE0', type: 'PRO_STATE', enumType: 'PRO_STATE', access: 'R', doc: 'State of the submit interpreter: `#P_FREE`, `#P_RESET`, `#P_ACTIVE`, `#P_STOP` or `#P_END`.' },
    { name: '$PRO_STATE1', type: 'PRO_STATE', enumType: 'PRO_STATE', access: 'R', doc: 'State of the robot interpreter: `#P_FREE`, `#P_RESET`, `#P_ACTIVE`, `#P_STOP` or `#P_END`.' },
    { name: '$PRO_MODE', type: 'PRO_MODE', enumType: 'PRO_MODE', access: 'R', doc: 'Program run mode: `#GO`, `#MSTEP`, `#ISTEP`, `#BSTEP`, `#PSTEP` or `#CSTEP`.' },
    { name: '$STOPMESS', type: 'BOOL', access: 'R', doc: 'TRUE while a stop message is active (it has to be acknowledged).' },
    { name: '$MOVE_ENABLE', type: 'BOOL', access: 'R', doc: 'Motion enable from the higher-level controller.' },
    { name: '$DRIVES_ON', type: 'BOOL', access: 'R', doc: 'Drives ON request (input of the external automatic interface).' },
    { name: '$DRIVES_OFF', type: 'BOOL', access: 'R', doc: 'Drives OFF request (input of the external automatic interface).' },
    { name: '$PERI_RDY', type: 'BOOL', access: 'R', doc: 'The drives are ready (output of the external automatic interface).' },
    { name: '$USER_SAF', type: 'BOOL', access: 'R', doc: 'Operator safety (safety fence) is closed.' },
    { name: '$ALARM_STOP', type: 'BOOL', access: 'R', doc: 'FALSE while an EMERGENCY STOP is active.' },
    { name: '$POWER_FAIL', type: 'BOOL', access: 'R', doc: 'Power failure.' },
    { name: '$ON_PATH', type: 'BOOL', access: 'R', advanceStop: true, doc: 'The robot is on the programmed path.' },
    { name: '$NEAR_POSRET', type: 'BOOL', access: 'R', doc: 'The robot is near `$POS_RET`.' },
    { name: '$IN_HOME', type: 'BOOL', access: 'R', doc: 'The robot is in its HOME position.' },
    { name: '$T1', type: 'BOOL', access: 'R', doc: 'Operating mode T1 is selected.' },
    { name: '$T2', type: 'BOOL', access: 'R', doc: 'Operating mode T2 is selected.' },
    { name: '$AUT', type: 'BOOL', access: 'R', doc: 'Operating mode AUT is selected.' },
    { name: '$EXT', type: 'BOOL', access: 'R', doc: 'Operating mode EXT (automatic external) is selected.' },
    { name: '$EXT_START', type: 'BOOL', access: 'R', doc: 'Program start from the external automatic interface.' },
    { name: '$I_O_ACT', type: 'BOOL', access: 'R', doc: 'The external automatic interface is active.' },
    { name: '$CONF_MESS', type: 'BOOL', access: 'R', doc: 'Acknowledgement of messages from the higher-level controller.' },
    { name: '$ERR', type: 'ERR', struct: 'ERR', access: 'R', doc: 'Information about the last error (ON_ERROR_PROCEED): NUMBER, PHASE, MODULE, LINE, TYPE, STATE.' },
    { name: '$NUM_AX', type: 'INT', access: 'R', doc: 'Number of robot axes.' },
    { name: '$EX_AX_NUM', type: 'INT', access: 'R', doc: 'Number of external axes.' },
    { name: '$LOOP_MSG', type: 'CHAR[]', access: 'RW', doc: 'Text of the status message of the submit interpreter.' },
    { name: '$SEN_PINT', type: 'INT[]', access: 'RW', doc: 'Integer values of the sensor interface.' },
    { name: '$SEN_PREA', type: 'REAL[]', access: 'RW', doc: 'Real values of the sensor interface.' },
    { name: '$ROBNAME', type: 'CHAR[]', access: 'R', doc: 'Name of the robot.' },
    { name: '$CMD', type: 'CHANNEL', access: 'R', doc: 'Channel for CWRITE commands to the interpreters (e.g. `"RUN /R1/CELL()"`).' },
];

const SYSTEM_VARIABLES = new Map(SYSTEM_VARIABLE_LIST.map(v => [v.name.toLowerCase(), v]));

export function systemVariables(): SystemVariable[] {
    return SYSTEM_VARIABLE_LIST;
}

export function systemVariable(name: string): SystemVariable | undefined {
    return SYSTEM_VARIABLES.get(name.toLowerCase());
}

/** Assigning these in a program is an error on the controller (write-protected). */
export function isWriteProtected(name: string): boolean {
    return systemVariable(name)?.access === 'R'
        && !/^\$(ROBROOT|WORLD|NULLFRAME|CMD|ROBNAME|NUM_AX|EX_AX_NUM|PRO_MODE|LOOP_MSG)$/i.test(name);
}

// ---------------------------------------------------------------------------
// standard functions and procedures

export interface BuiltinParam {
    name: string;
    type: string;
    dir: 'IN' | 'OUT';
    doc?: string;
    optional?: boolean;
}

export interface BuiltinRoutine {
    name: string;
    /** '' for procedures */
    returnType: string;
    params: BuiltinParam[];
    doc: string;
    /** further arguments of the type of the last parameter may follow (CWRITE, SWRITE, ...) */
    variadic?: boolean;
    /** calling it in the robot program triggers an advance run stop */
    advanceStop?: boolean;
}

const p = (name: string, type: string, dir: 'IN' | 'OUT' = 'IN', doc?: string, optional?: boolean): BuiltinParam =>
    ({ name, type, dir, doc, optional });

const BUILTIN_LIST: BuiltinRoutine[] = [
    // arithmetic and trigonometry (angles in degrees)
    { name: 'ABS', returnType: 'REAL', params: [p('Value', 'REAL')], doc: 'Absolute value.' },
    { name: 'SQRT', returnType: 'REAL', params: [p('Value', 'REAL', 'IN', 'must not be negative')], doc: 'Square root.' },
    { name: 'SIN', returnType: 'REAL', params: [p('Angle', 'REAL', 'IN', 'degrees')], doc: 'Sine of an angle in degrees.' },
    { name: 'COS', returnType: 'REAL', params: [p('Angle', 'REAL', 'IN', 'degrees')], doc: 'Cosine of an angle in degrees.' },
    { name: 'TAN', returnType: 'REAL', params: [p('Angle', 'REAL', 'IN', 'degrees')], doc: 'Tangent of an angle in degrees.' },
    { name: 'ACOS', returnType: 'REAL', params: [p('Value', 'REAL', 'IN', '-1.0 … 1.0')], doc: 'Arccosine in degrees.' },
    { name: 'ATAN2', returnType: 'REAL', params: [p('Y', 'REAL'), p('X', 'REAL')], doc: 'Arctangent of Y/X in degrees (-180 … 180), using the signs of both to find the quadrant.' },
    // geometry
    { name: 'INV_POS', returnType: 'FRAME', params: [p('Frame', 'FRAME')], doc: 'Inverse of a frame.' },
    { name: 'FORWARD', returnType: 'E6POS', params: [p('Axis_Pos', 'E6AXIS'), p('Error', 'INT', 'OUT', '0 = no error')], doc: 'Forward kinematics: the Cartesian position of an axis position (KSS 8).' },
    { name: 'INVERSE', returnType: 'E6AXIS', params: [p('Pos', 'E6POS'), p('Start_Axis', 'E6AXIS', 'IN', 'reference for Status and Turn'), p('Error', 'INT', 'OUT', '0 = no error')], doc: 'Inverse kinematics: the axis position of a Cartesian position (KSS 8).' },
    // string variables (CHAR arrays)
    { name: 'StrDeclLen', returnType: 'INT', params: [p('StrVar[]', 'CHAR[]')], doc: 'Declared length of a string variable.' },
    { name: 'StrLen', returnType: 'INT', params: [p('StrVar[]', 'CHAR[]')], doc: 'Length of the text in a string variable.' },
    { name: 'StrClear', returnType: 'BOOL', params: [p('StrVar[]', 'CHAR[]', 'OUT')], doc: 'Deletes the contents of a string variable.' },
    { name: 'StrCopy', returnType: 'BOOL', params: [p('StrDest[]', 'CHAR[]', 'OUT'), p('StrToCopy[]', 'CHAR[]')], doc: 'Copies a string into a string variable.' },
    { name: 'StrAdd', returnType: 'INT', params: [p('StrDest[]', 'CHAR[]', 'OUT'), p('StrToAdd[]', 'CHAR[]')], doc: 'Appends a string to a string variable; returns the new length.' },
    { name: 'StrComp', returnType: 'BOOL', params: [p('StrComp1[]', 'CHAR[]'), p('StrComp2[]', 'CHAR[]'), p('CaseSens', 'BOOL', 'IN', 'TRUE: case-sensitive')], doc: 'Compares two strings.' },
    { name: 'StrFind', returnType: 'INT', params: [p('StartAt', 'INT', 'IN', 'first character to search'), p('StrVar[]', 'CHAR[]'), p('StrFind[]', 'CHAR[]'), p('CaseSens', 'BOOL')], doc: 'Searches a string; returns the position of the first match (0 = not found).' },
    { name: 'StrToBool', returnType: 'BOOL', params: [p('StrVar[]', 'CHAR[]'), p('MyBool', 'BOOL', 'OUT')], doc: 'Converts a string to BOOL; returns TRUE on success.' },
    { name: 'StrToInt', returnType: 'BOOL', params: [p('StrVar[]', 'CHAR[]'), p('MyInt', 'INT', 'OUT')], doc: 'Converts a string to INT; returns TRUE on success.' },
    { name: 'StrToReal', returnType: 'BOOL', params: [p('StrVar[]', 'CHAR[]'), p('MyReal', 'REAL', 'OUT')], doc: 'Converts a string to REAL; returns TRUE on success.' },
    { name: 'StrToString', returnType: 'BOOL', params: [p('StrVar[]', 'CHAR[]'), p('MyString[]', 'CHAR[]', 'OUT')], doc: 'Copies a string into another string variable; returns TRUE on success.' },
    // system functions
    { name: 'VARSTATE', returnType: 'VAR_STATE', params: [p('VAR_STR[]', 'CHAR[]', 'IN', 'name of the variable')], doc: 'State of a variable: `#UNKNOWN`, `#DECLARED` or `#INITIALIZED`.' },
    { name: 'DELETE_BACKWARD_BUFFER', returnType: '', params: [], doc: 'Prevents backward motion beyond this point.', advanceStop: true },
    { name: 'ROB_STOP', returnType: 'BOOL', params: [p('Type', 'STOP_TYPE')], doc: 'Stops the robot.' },
    { name: 'ROB_STOP_RELEASE', returnType: 'BOOL', params: [p('Type', 'STOP_TYPE')], doc: 'Releases a robot stop of ROB_STOP.' },
    { name: 'SET_BRAKE_DELAY', returnType: 'INT', params: [p('Axes_Nr', 'INT', 'IN', 'bit mask of the axes'), p('Delay', 'INT', 'IN', 'ms')], doc: 'Reduces the brake delay at the end of a cycle.', advanceStop: true },
    { name: 'PULSE', returnType: '', params: [p('Signal', 'BOOL', 'OUT', 'output, e.g. $OUT[3]'), p('Level', 'BOOL', 'IN', 'TRUE: high pulse'), p('Duration', 'REAL', 'IN', 'seconds, 0.1 … 3.0')], doc: 'Sets an output to a level for the given time.', advanceStop: true },
    { name: 'ERR_RAISE', returnType: '', params: [p('Err', 'ERR')], doc: 'Raises the error again (ON_ERROR_PROCEED).' },
    { name: 'ERR_CLEAR', returnType: '', params: [p('Err', 'ERR', 'OUT')], doc: 'Clears the error information (ON_ERROR_PROCEED).' },
    // messages and dialogs
    { name: 'SET_KRLMSG', returnType: 'INT', params: [p('Type', 'EKRLMSGTYPE', 'IN', '#NOTIFY, #STATE, #QUIT or #WAITING'), p('MyMessage', 'KRLMSG_T', 'OUT'), p('Parameter[]', 'KRLMSGPAR_T[]', 'OUT', 'values for %1 … %3'), p('Option', 'KRLMSGOPT_T', 'OUT')], doc: 'Shows a message in the message window; returns its handle (-1 on error).', advanceStop: true },
    { name: 'SET_KRLDLG', returnType: 'INT', params: [p('MyQuestion', 'KRLMSG_T', 'OUT'), p('Parameter[]', 'KRLMSGPAR_T[]', 'OUT'), p('Touchkey[]', 'KRLMSGDLGSK_T[]', 'OUT', 'up to 7 softkeys'), p('Option', 'KRLMSGOPT_T', 'OUT')], doc: 'Shows a dialog; returns its handle (-1 on error).', advanceStop: true },
    { name: 'EXISTS_KRLMSG', returnType: 'BOOL', params: [p('nHandle', 'INT')], doc: 'TRUE while the message is shown.' },
    { name: 'EXISTS_KRLDLG', returnType: 'BOOL', params: [p('nHandle', 'INT'), p('Answer', 'INT', 'OUT', 'number of the softkey pressed')], doc: 'TRUE while the dialog is shown; afterwards `Answer` holds the softkey.' },
    { name: 'CLEAR_KRLMSG', returnType: 'BOOL', params: [p('nHandle', 'INT', 'IN', '-88: all of this interpreter, -99: all')], doc: 'Deletes a message.' },
    // communication
    { name: 'CWRITE', returnType: '', params: [p('Channel', 'CHANNEL'), p('State', 'STATE_T', 'OUT'), p('Mode', 'MODUS_T', 'OUT'), p('Format[]', 'CHAR[]'), p('Var', 'ANY', 'IN', '', true)], variadic: true, doc: 'Writes to a channel, e.g. `CWRITE($CMD, STAT, MODE, "RUN /R1/CELL()")`.', advanceStop: true },
    { name: 'CREAD', returnType: '', params: [p('Handle', 'INT'), p('State', 'STATE_T', 'OUT'), p('Mode', 'MODUS_T', 'OUT'), p('TimeOut', 'REAL'), p('Offset', 'INT', 'OUT'), p('Format[]', 'CHAR[]'), p('Var', 'ANY', 'OUT', '', true)], variadic: true, doc: 'Reads from a channel.', advanceStop: true },
    { name: 'SWRITE', returnType: '', params: [p('String[]', 'CHAR[]', 'OUT'), p('State', 'STATE_T', 'OUT'), p('Offset', 'INT', 'OUT'), p('Format[]', 'CHAR[]'), p('Var', 'ANY', 'IN', '', true)], variadic: true, doc: 'Formats values into a string variable (like printf).' },
    { name: 'SREAD', returnType: '', params: [p('String[]', 'CHAR[]'), p('State', 'STATE_T', 'OUT'), p('Offset', 'INT', 'OUT'), p('Format[]', 'CHAR[]'), p('Var', 'ANY', 'OUT', '', true)], variadic: true, doc: 'Reads values from a string variable (like scanf).' },
    { name: 'COPEN', returnType: '', params: [p('Channel', 'CHANNEL'), p('Handle', 'INT', 'OUT')], doc: 'Opens a channel.', advanceStop: true },
    { name: 'CCLOSE', returnType: '', params: [p('Handle', 'INT'), p('State', 'STATE_T', 'OUT')], doc: 'Closes a channel.', advanceStop: true },
    { name: 'CAST_TO', returnType: '', params: [p('Buffer[]', 'CHAR[]', 'OUT'), p('Offset', 'INT', 'OUT'), p('Var', 'ANY', 'IN', '', true)], variadic: true, doc: 'Copies values into a CHAR buffer in binary form.' },
    { name: 'CAST_FROM', returnType: '', params: [p('Buffer[]', 'CHAR[]'), p('Offset', 'INT', 'OUT'), p('Var', 'ANY', 'OUT', '', true)], variadic: true, doc: 'Copies values out of a CHAR buffer in binary form.' },
    { name: 'CIOCTL', returnType: 'INT', params: [p('Handle', 'INT'), p('Request', 'INT'), p('Argument', 'INT'), p('String[]', 'CHAR[]'), p('RetVal', 'INT', 'OUT')], doc: 'Control function of a channel.' },
    { name: 'SET_TORQUE_LIMITS', returnType: '', params: [p('Axis', 'INT'), p('Limits', 'TORQLIMITPARAM')], doc: 'Torque mode: sets the torque limits of an axis.', advanceStop: true },
    { name: 'RESET_TORQUE_LIMITS', returnType: '', params: [p('Axis', 'INT')], doc: 'Torque mode: resets the torque limits of an axis.', advanceStop: true },
    // kinematic systems (BAS uses them to compute $BASE)
    { name: 'EK', returnType: 'FRAME', params: [p('Root', 'FRAME'), p('Mech_Type', 'ESYS'), p('Offset', 'FRAME')], doc: 'Base of an external kinematic system (BASE on an external axis).' },
    { name: 'LK', returnType: 'FRAME', params: [p('Root', 'FRAME'), p('Ip_Addr[]', 'CHAR[]'), p('Offset', 'FRAME'), p('Mech_Type', 'ESYS')], doc: 'Base of a linked (RoboTeam) kinematic system.' },
    { name: 'EB', returnType: 'FRAME', params: [p('Mach_Idx', 'INT'), p('Offset', 'FRAME')], doc: 'Base of an external kinematic system defined in the machine data.' },
    // system functions of option and technology packages
    { name: 'ISMESSAGESET', returnType: 'BOOL', params: [p('Message', 'INT')], doc: 'TRUE while the system message is active.' },
    { name: 'MD_CMD', returnType: 'INT', params: [p('Device[]', 'CHAR[]'), p('Command[]', 'CHAR[]'), p('Parameter[]', 'CHAR[]', 'IN', '', true)], doc: 'Command to a system device (e.g. brake test).' },
    { name: 'MD_SETSTATE', returnType: 'INT', params: [p('Device[]', 'CHAR[]'), p('State', 'INT', 'IN', '', true)], doc: 'Sets the state of a system device (e.g. brake test).' },
    // functions the spline inline forms use in WITH clauses
    ...['SVEL_JOINT', 'SACC_JOINT', 'SVEL_CP', 'SVEL_ORI1', 'SVEL_ORI2', 'SACC_CP', 'SACC_ORI1', 'SACC_ORI2', 'STOOL2', 'SBASE', 'SIPO_MODE',
        'SLOAD', 'SAPO', 'SAPO_PTP', 'SORI_TYP', 'SCIRC_TYP', 'SCIRC_MODE', 'SGEAR_JERK', 'SJERK', 'USE_CM_PRO_VALUES'].map((name): BuiltinRoutine => ({
        name, returnType: 'ANY', params: [p('Value', 'ANY', 'IN', '', true)], variadic: true,
        doc: 'Parameter function of the spline inline forms (`SPTP ... WITH ...`).',
    })),
];

const BUILTINS = new Map(BUILTIN_LIST.map(r => [r.name.toLowerCase(), r]));

export function builtinRoutines(): BuiltinRoutine[] {
    return BUILTIN_LIST;
}

export function builtinRoutine(name: string): BuiltinRoutine | undefined {
    return BUILTINS.get(name.toLowerCase());
}

/** Functions the debugger simulates although KRL itself does not define them: not suggested, not reported. */
export const SIMULATOR_FUNCTIONS = new Set([
    'sign', 'trunc', 'round', 'min', 'max', 'pow', 'exp', 'ln', 'asin', 'atan', 'odd', 'even', 'len',
    'b_and', 'b_or', 'b_xor', 'b_exor', 'b_not', 'getsysstate', 'mbx_rec', 'sync', 'get_sig_inf', 'wait_for_on',
]);

// ---------------------------------------------------------------------------
// keywords and types

/** Words that are never variable names. */
const KEYWORD_LIST = [
    'DEF', 'DEFFCT', 'DEFDAT', 'END', 'ENDFCT', 'ENDDAT', 'GLOBAL', 'PUBLIC', 'DECL', 'CONST', 'STRUC', 'ENUM', 'SIGNAL',
    'EXT', 'EXTFCT', 'EXTP', 'EXTFCTP', 'IMPORT', 'CHANNEL',
    'IF', 'THEN', 'ELSE', 'ENDIF', 'FOR', 'ENDFOR', 'WHILE', 'ENDWHILE', 'LOOP', 'ENDLOOP', 'REPEAT', 'UNTIL',
    'SWITCH', 'CASE', 'DEFAULT', 'ENDSWITCH', 'GOTO', 'EXIT', 'HALT', 'RETURN', 'WAIT', 'CONTINUE',
    'INTERRUPT', 'TRIGGER', 'PRIO', 'BRAKE', 'RESUME', 'CONFIRM', 'ON_ERROR_PROCEED',
    'PTP', 'LIN', 'CIRC', 'PTP_REL', 'LIN_REL', 'CIRC_REL', 'SPTP', 'SLIN', 'SCIRC', 'SPTP_REL', 'SLIN_REL', 'SCIRC_REL',
    'SPL', 'SPLINE', 'ENDSPLINE', 'PTP_SPLINE', 'TIME_BLOCK',
    'C_PTP', 'C_DIS', 'C_VEL', 'C_ORI', 'C_SPL', 'ANIN', 'ANOUT', 'DIGIN', 'MINIMUM', 'MAXIMUM',
    'AND', 'OR', 'NOT', 'EXOR', 'B_AND', 'B_OR', 'B_EXOR', 'B_NOT', 'TRUE', 'FALSE', 'IN', 'OUT',
];

export const KEYWORDS = new Set(KEYWORD_LIST.map(k => k.toLowerCase()));

const words = (...w: string[]) => new Set(w);
const NO_WORDS = new Set<string>();

/**
 * Words that are keywords only inside one statement (a variable may be called F,
 * CA or START elsewhere): by the first word of the statement, lowercase.
 */
export function statementKeywords(firstWord: string, isMotion: boolean): Set<string> {
    switch (firstWord.toUpperCase()) {
        case 'FOR': return words('to', 'step');
        case 'WAIT': return words('sec');
        case 'INTERRUPT': return words('decl', 'when', 'do', 'on', 'off', 'enable', 'disable');
        case 'TRIGGER': return words('when', 'distance', 'path', 'delay', 'do', 'onstart');
        case 'BRAKE': return words('f');
        case 'IMPORT': return words('is');
        case 'TIME_BLOCK': return words('start', 'part');
        case 'ANIN': case 'ANOUT': case 'DIGIN': return words('on', 'off', 'delay');
        case 'SIGNAL': return words('to');
        case 'SPLINE': case 'PTP_SPLINE': return words('with');
        default: return isMotion ? words('with', 'ca') : NO_WORDS;
    }
}

/** Simple and structure types predefined by KRL (manual 11.3.3). */
export const PREDEFINED_TYPES = ['INT', 'REAL', 'BOOL', 'CHAR', 'FRAME', 'POS', 'E6POS', 'AXIS', 'E6AXIS'];

export const POSITION_TYPES = new Set(['FRAME', 'POS', 'E6POS', 'AXIS', 'E6AXIS']);

export const NUMERIC_TYPES = new Set(['INT', 'REAL']);

/** Structure types of $CONFIG.DAT the inline forms use, for projects without it. */
const FALLBACK_STRUCTS: Record<string, StructMember[]> = {
    'PDAT': [
        { name: 'VEL', type: 'REAL', dims: [] }, { name: 'ACC', type: 'REAL', dims: [] }, { name: 'APO_DIST', type: 'REAL', dims: [] },
        { name: 'APO_MODE', type: 'APO_MODE_T', dims: [] }, { name: 'GEAR_JERK', type: 'REAL', dims: [] }, { name: 'EXAX_IGN', type: 'INT', dims: [] },
    ],
    'LDAT': [
        ...['VEL', 'ACC', 'APO_DIST', 'APO_FAC', 'AXIS_VEL', 'AXIS_ACC'].map(name => ({ name, type: 'REAL', dims: [] })),
        { name: 'ORI_TYP', type: 'ORI_TYPE', dims: [] }, { name: 'CIRC_TYP', type: 'CIRC_TYPE', dims: [] },
        { name: 'JERK_FAC', type: 'REAL', dims: [] }, { name: 'GEAR_JERK', type: 'REAL', dims: [] }, { name: 'EXAX_IGN', type: 'INT', dims: [] },
        { name: 'CB', type: 'CIRC_MODE', dims: [] },
    ],
    'FDAT': [
        { name: 'TOOL_NO', type: 'INT', dims: [] }, { name: 'BASE_NO', type: 'INT', dims: [] }, { name: 'IPO_FRAME', type: 'IPO_MODE', dims: [] },
        { name: 'POINT2', type: 'CHAR', dims: [24] }, { name: 'TQ_STATE', type: 'BOOL', dims: [] },
    ],
};

/** Members of a predefined, system or inline form structure type. */
export function catalogStructMembers(typeName: string): StructMember[] | undefined {
    return builtinStructMembers(typeName) ?? FALLBACK_STRUCTS[typeName.toUpperCase()];
}

/** Unit of a member of a structure type, for hovers and inlay hints. */
export function memberUnit(typeName: string, member: string): string {
    const t = typeName.toUpperCase();
    const m = member.toUpperCase();
    if (POSITION_TYPES.has(t)) {
        if (/^[XYZ]$/.test(m)) { return 'mm'; }
        if (/^([ABC]|A[1-6])$/.test(m)) { return '°'; }
        return '';
    }
    switch (`${t}.${m}`) {
        case 'VEL.CP': return 'm/s';
        case 'VEL.ORI1': case 'VEL.ORI2': return '°/s';
        case 'ACC.CP': return 'm/s²';
        case 'ACC.ORI1': case 'ACC.ORI2': return '°/s²';
        case 'APO.CDIS': return 'mm';
        case 'APO.CORI': return '°';
        case 'APO.CVEL': case 'APO.CPTP': return '%';
        case 'LOAD.M': return 'kg';
        case 'LOAD.J': return 'kg m²';
        case 'PDAT.VEL': case 'PDAT.ACC': case 'LDAT.ACC': case 'LDAT.AXIS_VEL': case 'LDAT.AXIS_ACC': return '%';
        case 'LDAT.VEL': return 'm/s';
        case 'PDAT.APO_DIST': case 'LDAT.APO_DIST': return 'mm';
        default: return '';
    }
}

/** Literals of the enumeration types of the system (without the leading #). */
const SYSTEM_ENUMS: Record<string, string[]> = {
    'MODE_OP': ['T1', 'T2', 'AUT', 'EX', 'INVALID'],
    'PRO_STATE': ['P_FREE', 'P_RESET', 'P_ACTIVE', 'P_STOP', 'P_END'],
    'PRO_MODE': ['GO', 'MSTEP', 'ISTEP', 'BSTEP', 'PSTEP', 'CSTEP'],
    'IPO_MODE': ['BASE', 'TCP'],
    'ORI_TYPE': ['CONSTANT', 'VAR', 'JOINT'],
    'CIRC_TYPE': ['BASE', 'PATH'],
    'APO_MODE_T': ['CPTP', 'CDIS'],
    'VAR_STATE': ['UNKNOWN', 'DECLARED', 'INITIALIZED'],
    'EKRLMSGTYPE': ['NOTIFY', 'STATE', 'QUIT', 'WAITING'],
    'KRLMSGPARTYPE_T': ['VALUE', 'KEY', 'EMPTY'],
};

export function systemEnumValues(typeName: string): string[] | undefined {
    return SYSTEM_ENUMS[typeName.toUpperCase()];
}

export function systemEnums(): [string, string[]][] {
    return Object.entries(SYSTEM_ENUMS);
}

/** Structure types listed in the reference: predefined, system and inline form types. */
const REFERENCE_STRUCTS = [
    'FRAME', 'POS', 'E6POS', 'AXIS', 'E6AXIS', 'VEL', 'ACC', 'APO', 'LOAD', 'ERR', 'PDAT', 'LDAT', 'FDAT',
    'KRLMSG_T', 'KRLMSGPAR_T', 'KRLMSGOPT_T', 'KRLMSGDLGSK_T',
];

export type ReferenceKind = 'system' | 'builtin' | 'type' | 'literal';

/**
 * A read-only KRL document describing what the controller provides: system
 * variables (as DECL lines with access, unit and description), standard functions,
 * predefined structure and enumeration types. Go to definition opens it for names
 * that no program declares. `lineOf` gives the line of `kind:name` (lowercase).
 */
export function systemReference(): { text: string; lineOf: Map<string, number> } {
    const out: string[] = [
        '; KUKA KRL: system variables, standard functions and predefined types (KSS 8)',
        '; Reference of krl-officelite. The controller provides these: programs use them without declaring them.',
        '',
    ];
    const lineOf = new Map<string, number>();
    const at = (key: string) => { if (!lineOf.has(key)) { lineOf.set(key, out.length); } };

    out.push(';FOLD System variables', '');
    for (const v of systemVariables()) {
        at(`system:${v.name.toLowerCase()}`);
        const array = v.type.endsWith('[]');
        const dims = array ? `[${v.index ? v.index[1] : ''}]` : '';
        const facts = [
            v.access === 'R' ? 'read-only' : 'read/write', v.unit,
            v.range ? `${v.range[0]} … ${v.range[1]}` : '', v.index ? `index ${v.index[0]} … ${v.index[1]}` : '',
            v.advanceStop ? 'advance run stop' : '',
        ].filter(Boolean).join(', ');
        out.push(`DECL ${v.type.replace(/\[\]$/, '')} ${v.name}${dims} ; ${facts}. ${v.doc}`);
    }
    out.push('', ';ENDFOLD', '', ';FOLD Standard functions and procedures', '');
    for (const b of builtinRoutines()) {
        at(`builtin:${b.name.toLowerCase()}`);
        const params = b.params.map(p => `${p.name}:${p.dir}`).join(', ') + (b.variadic ? ', ...' : '');
        out.push(`${b.returnType ? `DEFFCT ${b.returnType}` : 'DEF'} ${b.name}(${params}) ; ${b.doc}`);
    }
    out.push('', ';ENDFOLD', '', ';FOLD Predefined types', '');
    for (const t of ['INT', 'REAL', 'BOOL', 'CHAR']) { at(`type:${t.toLowerCase()}`); }
    out.push('; INT, REAL, BOOL, CHAR: simple types (CHAR arrays hold strings: CHAR NAME[24])');
    for (const name of REFERENCE_STRUCTS) {
        const members = catalogStructMembers(name);
        if (!members) { continue; }
        at(`type:${name.toLowerCase()}`);
        const body = members.map(m => `${m.type} ${m.name}${m.dims.length ? `[${m.dims.join(',')}]` : ''}`).join(', ');
        const units = members.map(m => memberUnit(name, m.name) ? `${m.name} ${memberUnit(name, m.name)}` : '').filter(Boolean).join(', ');
        out.push(`STRUC ${name} ${body}${units ? ` ; ${units}` : ''}`);
    }
    for (const [name, values] of systemEnums()) {
        at(`type:${name.toLowerCase()}`);
        for (const v of values) { at(`literal:#${v.toLowerCase()}`); }
        out.push(`ENUM ${name} ${values.join(', ')}`);
    }
    out.push('', ';ENDFOLD', '');
    return { text: out.join('\n'), lineOf };
}

/** Motion statements: the keyword, how many target points it takes, and what they are. */
export const MOTIONS: Record<string, { points: number; cp: boolean; doc: string }> = {
    'PTP': { points: 1, cp: false, doc: 'Point-to-point motion: the fastest path to the end point.' },
    'LIN': { points: 1, cp: true, doc: 'Linear motion of the TCP to the end point.' },
    'CIRC': { points: 2, cp: true, doc: 'Circular motion through the auxiliary point to the end point.' },
    'PTP_REL': { points: 1, cp: false, doc: 'Point-to-point motion relative to the current position.' },
    'LIN_REL': { points: 1, cp: true, doc: 'Linear motion relative to the current position.' },
    'CIRC_REL': { points: 2, cp: true, doc: 'Circular motion relative to the current position.' },
    'SPTP': { points: 1, cp: false, doc: 'Spline point-to-point motion.' },
    'SLIN': { points: 1, cp: true, doc: 'Spline linear motion.' },
    'SCIRC': { points: 2, cp: true, doc: 'Spline circular motion.' },
    'SPTP_REL': { points: 1, cp: false, doc: 'Spline point-to-point motion relative to the current position.' },
    'SLIN_REL': { points: 1, cp: true, doc: 'Spline linear motion relative to the current position.' },
    'SCIRC_REL': { points: 2, cp: true, doc: 'Spline circular motion relative to the current position.' },
};

export function motionInfo(word: string): { points: number; cp: boolean; doc: string } | undefined {
    return MOTIONS[word.toUpperCase()];
}
