# krl-officelite

KUKA KRL language support for VS Code (formatter + debugger).

## Requirements

- Python 3 (for formatter)
- Node.js / npm (for extension development build)

## Running the extension locally

1. Open this repository in VS Code.
2. Run `npm install` once.
3. Press `F5` to start an **Extension Development Host** window.
4. In that new window, open a `.src` file and press `F5` to start KRL debugging.

## KRL debugger behavior

- Main thread: the configured `program` (`.src`).
- Submit threads: if `submitPrograms` is not provided, all `.sub` files in the main program folder are auto-loaded (`SPS.SUB` first).
- Program `.dat`: `<program>.dat` is auto-loaded when present.
- `$config.dat`: searched automatically upward from the main program folder, unless explicitly set via `configDat`.

### Variable scopes in debugger

The Variables panel is split into 4 sections:

1. **Runtime Variables** (declared/executed in `.src`, plus params)
2. **DAT Private Variables** (non-`GLOBAL` declarations from module `.dat`)
3. **DAT Global Variables** (`GLOBAL` declarations from regular `.dat` files)
4. **$CONFIG.DAT Globals** (declarations loaded from `$config.dat`)

## Launch configuration example

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "krl",
      "request": "launch",
      "name": "KRL: Debug",
      "program": "${workspaceFolder}/cell/main.src",
      "submitPrograms": [
        "${workspaceFolder}/cell/sps.sub",
        "${workspaceFolder}/cell/monitor.sub"
      ],
      "configDat": "${workspaceFolder}/$config.dat",
      "stopOnEntry": true
    }
  ]
}
```