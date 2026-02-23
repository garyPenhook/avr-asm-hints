# Versioning and Releases

This project follows Semantic Versioning.

## SemVer Rules

- `MAJOR` for incompatible behavior or API changes.
- `MINOR` for backward-compatible feature additions.
- `PATCH` for backward-compatible fixes and quality-only updates.

Version source of truth is `vscode-avr-asm-navigator/package.json`.

## Required Release Inputs

- `CHANGELOG.md` must include a section for the exact package version.
- A Git tag must match the package version format: `v<package-version>`.
- CI checks must pass (`npm run check` and VSIX packaging validation).

## Release Process

1. Update `vscode-avr-asm-navigator/package.json` version.
2. Move release notes from `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`.
3. Commit and push to `main`.
4. Create and push a matching tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. GitHub Actions `Release VSIX` builds the VSIX, generates a `.sha256`, and publishes both assets to the GitHub Release for that tag.

## Validation Commands

From repository root:

```sh
cd vscode-avr-asm-navigator
npm run check
./package-vsix.sh
```
