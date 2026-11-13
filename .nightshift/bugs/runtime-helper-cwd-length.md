# Deep helper working directories

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh Fable review 84cd0e64 and independent Astra skepticism 74df3e0d confirmed a measured private Windows helper launch limitation. A guarded ProcessSupervisor probe completed with working directories of length 240, 247 and 250, and failed with result-invalid transport at 259, 262 and 270 while verifying quiescence. Scoped helper working directories add 147 characters to the companion root in the measured configuration; the canonical project root remained below that bracket, while a standard Nightshift private copy exceeded it. This is not a universal Windows path threshold or proof of a production installation failure. The earlier long-root residue and control probes both failed for this independent reason.

## Proposed follow-up

Track a bounded helper working-directory and launch-diagnostic design. Preserve absolute scope arguments, containment, owned-process quiescence and fail-closed behavior; verify broker and child launch at measured boundary lengths before changing the path policy. Use shallow private fixtures for the current MVP checks.

## Status

The user chose to track this item on 2026-10-12. Fixed on 2026-11-13 in Nightshift run a69edaac-e54c-47ec-ba9c-3e2c5bb3418d and archived in [`BUGS_HISTORY.md`](../BUGS_HISTORY.md); see Resolution.

## Resolution

Re-measurement on the Go native helper path, on the reference host with long paths enabled: owned launches with working directories of 240 to 258 characters started, and 259, 260, 262, 270 and 300 failed with result-invalid "Owned-process transport failed.", the core role verifying quiescent after each. A plain Node spawn agreed (258 started, 259 failed ENOENT), as did the Go broker's `syscall.StartProcess` (258 started; 259 failed with "The directory name is invalid"). For executable paths, Node's spawn started 259 characters and failed ENOENT at 260, while `syscall.StartProcess` started 260, 261 and 270. Since the Go native helper MVP every owned child starts in the companion root, so the 147-character scoped working directories of the original finding no longer exist and the bound applies to the root itself.

Fix: `runtime/src/launch-directory.ts` holds the measured limits and `installationRootBound(adapter)`, the shortest bound over the launches the runtime makes below the root: the root, `runtime/native/helper` and `adapters/<adapter>` as working directories, and `runtime/native/companion-helper.exe` as the Node-spawned helper image, 223 characters for `disco_elysium`. Every CLI command, `openBackend` and standalone status refuse a longer root (a command whose configuration cannot be read checks every term but the adapter's and then fails on the configuration) with `configurationInvalid`, naming the root's length and that bound, before the build step or any process. `NativeHelper.start`, `compileHelper` and `ProcessSupervisor.spawn` keep their own refusals for a launch that reaches them anyway. Coverage is in `runtime/test/launch-directory.test.ts`, `runtime/test/process.test.ts` and `runtime/test/native-image.test.ts`.

Not covered, and tracked in [Adapter tool path length](adapter-tool-path-length.md): adapter tool executables inside the core-resolved adapter release folder; the Disco Elysium dump tool sits about 87 characters below the root and is started by the PowerShell core, whose executable-path limit was not measured. All measurements come from one host.
