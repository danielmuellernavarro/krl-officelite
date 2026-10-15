# Example project

A tiny pick-and-place cell: open the folder `examples/KRC` in VS Code, open `R1/Program/demo.src` and press **F5**. Without the extension, VS Code offers to install it: the folder recommends it in `.vscode/extensions.json`.

- The program waits for `$IN[1]` (a part): force it in the **KRL I/O** view (click the input).
- Watch the robot in the **KRL Robot** view; change the override and the mode (T1 / T2 / AUT / EXT) in the debug toolbar. The mode can only change while the program is paused.
- Set a breakpoint, step, and look at the advance run and main run pointers in the gutter.
- Try breaking something: use an undeclared variable and see the error in Problems and the stop in the debugger.
