# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and version numbers follow Semantic Versioning.

## [Unreleased]

### Added
- Release automation for tag-based VSIX publishing and checksum generation.
- Completion flow tests that execute the registered provider against realistic operand scenarios.
- Versioning policy documentation for repeatable releases.

## [0.1.4] - 2026-02-23

### Added
- Scope-aware DFP index caching and stronger invalidation behavior.
- Cancellable provider execution and active-target diagnostics command/output.
- AVR register completion for operand contexts, including comma-triggered completion.
- CI checks with lint, test, and VSIX content validation.
- Hardened VSIX packaging script using an explicit file/dir whitelist.

[Unreleased]: https://github.com/garyPenhook/avr-asm-navigator/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/garyPenhook/avr-asm-navigator/releases/tag/v0.1.4
