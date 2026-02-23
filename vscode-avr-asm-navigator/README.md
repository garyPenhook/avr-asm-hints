# AVR® ASM Navigator

Local VS Code extension that adds practical symbol help for AVR® assembly (`.S/.s`) projects.
Optimized for Microchip® MPLAB® XC8™ (`xc8-cc`) AVR® workflows and device-family packs (DFP).

Repository:
- https://github.com/garyPenhook/avr-asm-navigator

## Requirements

- Visual Studio Code `1.85+`
- Microchip® VS Code extensions with MPLAB® project metadata (`.vscode/*.mplab.json`) for best auto-detection
- Installed Microchip® AVR® DFP pack for your target device
- `node` and `zip` to build the VSIX package
- Optional: `code` CLI for command-line installation

## Package and Install

Build the VSIX:

```sh
./package-vsix.sh
```

Install the generated VSIX in VS Code:

```sh
code --install-extension ./avr1-local.avr-asm-navigator-<version>.vsix --force
```

## Uninstall

If the Extensions view does not show a gear icon, use one of these:

1. Command Palette:
   - Run `Extensions: Uninstall Extension`
   - Select `AVR® ASM Navigator`
2. CLI:
   ```sh
   code --uninstall-extension avr1-local.avr-asm-navigator
   ```
3. Verify installed extension IDs if uninstall says "not found":
   ```sh
   code --list-extensions | rg -i "avr|navigator"
   ```
4. Last resort, delete extension folder and reload VS Code:
   - Linux/macOS: `~/.vscode/extensions/avr1-local.avr-asm-navigator-*`
   - Windows: `%USERPROFILE%\\.vscode\\extensions\\avr1-local.avr-asm-navigator-*`

If you use WSL/SSH/Container remote contexts, uninstall in that same remote context as well.

## Features

- Contributes language mode `avr-asm` for `.S` and `.s` files
- Hover hints for:
  - local labels and `.equ/.set` symbols in the current file
  - target-device DFP symbols resolved from your project
- Go-to-definition for local labels and DFP symbols
- Completion items from local symbols + DFP symbol index
- Built-in completion coverage for AVR instruction mnemonics
- Document symbols (Outline view / `Go to Symbol in Editor`)
- Workspace symbols (`Go to Symbol in Workspace`)
- Find References for AVR® assembly symbols across workspace files
- Command: `AVR® ASM: Lookup Symbol` (quick-pick jump to symbol definition)
- Command: `AVR® ASM: Show Active Target` (prints resolved scope/device/pack details)

## Configuration

- `avrAsmNavigator.dfpPath`
  - Optional explicit DFP root path override.
- `avrAsmNavigator.device`
  - Optional explicit device override (examples: `AVR128DA32`, `ATmega4809`).
- `avrAsmNavigator.autoDetectMplabProject`
  - When enabled (default), device + pack are auto-detected from `.vscode/*.mplab.json`.
- `avrAsmNavigator.maxHoverResults`
- `avrAsmNavigator.maxCompletionItems`
- `avrAsmNavigator.enableCompletion`
- `avrAsmNavigator.enableInstructionCompletion`
- `avrAsmNavigator.enableReferences`
- `avrAsmNavigator.includeDfpInWorkspaceSymbols`
- `avrAsmNavigator.maxWorkspaceScanFiles`
- `avrAsmNavigator.maxWorkspaceSymbols`
- `avrAsmNavigator.maxReferenceResults`

## Notes

- Preferred mode is `avr-asm` (provided by this extension).
- If no `.vscode/*.mplab.json` exists, the extension also tries to infer device from workspace source text (for example `ATmega4809`, `AVR128DA32`, `__AVR_*__`, `io*.h`, or `*def.inc` hints).
- Diagnostic details are written to the `AVR ASM Navigator` output channel.

## Development Checks

Run local quality checks:

```sh
npm run check
```

Build VSIX using the package whitelist:

```sh
npm run package:vsix
```

## Scope and Non-goals

- This extension provides editor assistance (syntax mode, hover, completion, definitions, symbols, and references).
- It does not compile, link, flash, or debug firmware.
- It does not replace the Microchip® build/debug toolchain.
- Designed for AVR® device families supported by Microchip® DFP packs.
- Best results are with MPLAB® project metadata (`.vscode/*.mplab.json`) from Microchip® VS Code extensions.

## Trademarks

- Microchip®, MPLAB®, and AVR® are registered trademarks of Microchip® Technology Incorporated (and its subsidiaries) in the U.S. and other countries.
- MPLAB® XC8™ is used in this document as a Microchip® toolchain product name.
- All other trademarks are the property of their respective owners.
- This project is an independent community project and is not affiliated with, endorsed by, or sponsored by Microchip® Technology Incorporated.
