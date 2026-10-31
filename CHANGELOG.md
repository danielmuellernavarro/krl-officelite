# Change Log

### 2.0.6

- The extension no longer contributes a file icon theme, which replaced the icons of all files in VS Code. KRL files (`.src`, `.dat`, `.sub`) show the KRL icon in your current file icon theme.

### 2.0.5

- Routines declared with `EXT` in `$config.dat` or in the module's data list (e.g. `H50`, `USERSPOT`) are no longer *Unknown routine*. Hover, signature help and completion show their parameters.

### 2.0.4

- Debugger: change values with one click while stopped (toggle a BOOL, pick an ENUM value, **Change Value...**).
- Debugger: **Jump to Cursor** moves the program pointer like block selection on the smartPAD.
- Debugger: **Search Variables** lists every variable, also in large projects.
- Debugger: BAS.SRC no longer stops in `SJERK` with *RET_JERK has no value*; system variables the simulator does not have read as 0 / FALSE.
- Marketplace page: shorter README.

### 2.0.3

- **Debug KRL Program** / **Run KRL Program** button in `.src` / `.sub` editors; Run Without Debugging (Ctrl+F5) no longer stops at the first line.
- Offers to open `.src` / `.dat` files as KRL when another extension opens them in its own language.
- The example project recommends the extension in `.vscode/extensions.json`.
- A name declared where the file cannot see it is a warning that says where it is declared, no longer *is not declared* (`krl-officelite.diagnostics.declaredElsewhere`).
- Optional warning with quick fixes for names written in another case than declared (`krl-officelite.diagnostics.nameCase`).
- File icons for `.src`, `.dat`, `.sub` and `$config.dat`.
- KUKA system functions `EB_ABS`, `EB_TEST`, `EO`, `GET_COLLMON_SET` and `Test_BRAKE` are known.
- Files saved as UTF-8 with a byte order mark are read correctly.
- Expressions with variables are no longer checked as if the variables were 0.

### 2.0.2

- Marketplace page: screenshots of the hovers, diagnostics with quick fixes and the debugger.

### 2.0.1

- Marketplace page: overview of the features and getting started, search keywords.

### 2.0.0

The extension checks KRL like the controller, the formatter no longer needs Python, and the debugger simulates the robot.

#### Breaking changes

- Requires VS Code 1.67 or newer.
- The formatter runs inside the extension; the settings `pythonPath` and `formatterPath` are removed.
- The debugger runs in real robot time and starts in T1; change override and mode in the debug toolbar.
- Undeclared names, points and routines are errors, also without `$config.dat`.

#### Editor

- Context-aware completion, statement templates, signature help, inlay hints and hovers.
- Go to definition, references and outline; folding of `;FOLD` regions and blocks.
- Syntax check and diagnostics with quick fixes for all KRL files of the workspace.
- Formatter rewritten in TypeScript; format on save edits only the changed lines.

#### Debugger

- Robot and submit interpreters side by side (`SPS.SUB`), advance run, motion timing from the machine data.
- Override and operating mode T1 / T2 / AUT / EXT in the debug toolbar.
- KRL Robot, I/O, Messages and Live Watch views; Search Variables.
- Errors stop the program like on the controller.

### 1.0.0

- Initial publish, grammar, snippets, formatting

### 0.0.1

- Initial release
