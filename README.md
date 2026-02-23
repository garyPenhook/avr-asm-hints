# AVR ASM Navigator

Local VS Code extension that adds practical symbol help for AVR assembly (`.S/.s`) projects.
Optimized for Microchip MPLAB XC8 (`xc8-cc`) AVR workflows and device-family packs (DFP).

Source files are in:
- `vscode-avr-asm-navigator/`

## Package And Install

Build the VSIX:

```sh
cd vscode-avr-asm-navigator
./package-vsix.sh
```

Install it in VS Code:

```sh
code --install-extension ./avr1-local.avr-asm-navigator-0.1.4.vsix --force
```

## Features

- Contributes language mode `avr-asm` for `.S` and `.s` files
- Hover hints for:
  - local labels and `.equ/.set` symbols in the current file
  - target-device DFP symbols resolved from your project
- Go-to-definition for local labels and DFP symbols
- Completion items from local symbols + DFP symbol index
- Document symbols (Outline view / `Go to Symbol in Editor`)
- Workspace symbols (`Go to Symbol in Workspace`)
- Find References for AVR assembly symbols across workspace files
- Command: `AVR ASM: Lookup Symbol` (quick-pick jump to symbol definition)

## Configuration

- `avrAsmHints.dfpPath`
  - Optional explicit DFP root path override.
- `avrAsmHints.device`
  - Optional explicit device override (example: `AVR64DA32`).
- `avrAsmHints.autoDetectMplabProject`
  - When enabled (default), device + pack are auto-detected from `.vscode/*.mplab.json`.
- `avrAsmHints.maxHoverResults`
- `avrAsmHints.maxCompletionItems`
- `avrAsmHints.enableCompletion`
- `avrAsmHints.enableReferences`
- `avrAsmHints.includeDfpInWorkspaceSymbols`
- `avrAsmHints.maxWorkspaceScanFiles`
- `avrAsmHints.maxWorkspaceSymbols`
- `avrAsmHints.maxReferenceResults`

## Notes

- This extension is for editor assistance only.
- It does not replace the Microchip build/debug toolchain.
- Preferred mode is `avr-asm` (provided by this extension).
- Designed for AVR device families supported by Microchip DFP packs.
- Best results are with MPLAB project metadata (`.vscode/*.mplab.json`) from Microchip VS Code extensions.
