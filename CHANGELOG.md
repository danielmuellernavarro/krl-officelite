# Change Log

### 2.0.2

- Marketplace page: screenshots of the hovers, diagnostics with quick fixes and the debugger.

### 2.0.1

- Marketplace page: overview of the features and getting started, search keywords.

### 2.0.0

The extension now checks KRL like the controller does, the formatter no longer needs Python, and the debugger simulates the robot: motions take as long as on the robot, and errors stop the program where the controller would.

#### Breaking changes

- Requires VS Code 1.67 or newer.
- The formatter runs inside the extension: Python is no longer needed and the settings `pythonPath` and `formatterPath` are removed.
- The debugger runs programs in real robot time and starts in T1 (reduced velocity), like the controller. Change the override (up to 10000 % to run faster) and the mode (AUT for full speed) in the debug toolbar.
- Undeclared names, points and routines are errors, also without `$config.dat`. The debugger stops where a program uses them, reads a variable that has no value or an index outside its array.

#### Editor

- Context-aware completion: points after motions, INT counters, numbers in arithmetic, structure members, ENUM literals, system variables with type and access; the runtime variables of the routine first, then the module's data list, the globals and the system variables.
- Statement templates (`IF`, `FOR`, `WHILE`, `WAIT FOR`, `SWITCH` state machine, ...) offered first while typing and inserted with Tab; `DEF` / `DEFDAT` named like the file.
- Signature help, inlay hints (velocity, acceleration and approximation of motions, parameter names), hovers with positions in mm / ° and decoded Status / Turn.
- Go to definition and references for variables, routines, globals, STRUC members and ENUM literals; system variables, standard functions and predefined types open a reference document. Outline.
- Folding of `;FOLD` regions and blocks; inline form folds collapse when a file is opened and their parameters are dimmed; commands to wrap a selection in a fold.
- Syntax check of every statement and expression (missing operands and brackets, `=` instead of `==`, misspelled statements with suggestions, ...) for all KRL files of the workspace, also the ones that are not open.
- Diagnostics with quick fixes: block structure, `;FOLD` pairs, undeclared points (declared in the module's `.dat` by the quick fix) and names, unused declarations, write-protected system variables, I/O index ranges, velocity limits, declaration order, name length, FOR counters, numeric and structure arrays used without index.
- Formatter rewritten in TypeScript: formats unsaved text and selections, keeps strings and comments as written, no longer splits names like `caseNr`. Format on save (`krl-officelite.formatOnSave`) edits only the changed lines.

#### Debugger

- Robot and submit interpreters run side by side (`SPS.SUB` like on the controller); stop, start and restart them from the Call Stack.
- Advance run (`$ADVANCE`) with advance run stops (also for the same point twice) and `CONTINUE`; main run, planned motions and advance run in the editor gutter.
- Motion timing from the robot's machine data (`Mada/$machine.dat`: axis speeds, path limits, arm lengths) or a standard robot: acceleration and braking ramps, synchronized PTP axes, LIN / CIRC path length and orientation, approximation, `$OV_PRO`. `$POS_ACT` / `$AXIS_ACT` follow the moving robot.
- Override like on the smartPAD (0 … 100 % = `$OV_PRO`, acting at once on the moving robot; up to 10000 % the simulation runs faster) and operating mode T1 / T2 / AUT / EXT (`$MODE_OP`; T1 reduces the velocity with `$VEL_CP_T1` / `$RED_T1` of the machine data; changed only while paused): in the debug toolbar next to play / pause / stop, the status bar, the KRL Robot view and commands; settings `krl-officelite.simulation.override` / `simulation.mode`, launch attributes `override` / `mode`.
- KRL Robot view: position, axes, the executing motion with TCP velocity, acceleration, progress and axis velocities, the override, the active tool and base with matrix, motion parameters, the robot's characteristics.
- KRL I/O view: watch and force inputs, outputs, flags, timers and signals, also from the editor.
- KRL Messages view for `SET_KRLMSG` / `SET_KRLDLG` messages and dialogs; KRL Live Watch and Search Variables while the programs run.
- Errors stop the program like on the controller: undeclared names, variables without value, indexes outside the array; `ON_ERROR_PROCEED` puts the error in `$ERR` (1422) and goes on. Syntax errors are listed in the Debug Console at the start.
- Positions shown with units and decoded Status / Turn everywhere; hovers evaluate the whole access path.

### 1.0.0

- Initial publish, grammar, snippets, formatting

### 0.0.1

- Initial release
