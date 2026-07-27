# STT resources

## Active path (0.13.2+)

Host STT does **not** use a native helper. It drives **VS Code Speech** via
`workbench.action.editorDictation.*` and a scratch document (see
`src/host/voice/sttHost.ts`).

## Experimental (not wired)

`HostSttMac.swift` + `Info.plist` were a prototype for Apple Speech in a
helper process. macOS TCC aborts ad-hoc/unsigned helpers for Speech
Recognition even when usage descriptions are present; do not ship as the
default path without a properly signed app identity.
