# Startup transport alternatives not taken, 2026-10-18

On 2026-10-18 two alternatives to the per-start compiled transport were drafted as candidate amendments to the [integrated startup execution](../features/runtime-startup-execution-30.md) spec, and a NativeAOT broker spike was prepared. None was accepted. The same day the user approved the [source-bound bootstrap image pins](runtime-bootstrap-image-pins-candidate-20261018.md) design instead: a Go broker and a native Go job observer, shipped in the repository and pinned for the life of the chat process. No record states an explicit decision rejecting either alternative; this report keeps what each proposed, what was measured and which gates it left open. The drafts and the spike lived on private branches that were later deleted.

## Shared evidence

Both drafts cite the same private snapshot, `pi17a`. Two pinned offline builds with `DebugType=none` reproduced its five selected outputs byte for byte: the framework-dependent C# broker apphost, its managed assembly, dependency and runtime configuration documents, and the Go observer. Copied-save starts with a fake provider attached healthy in 25.503 seconds for a newly detected save, 18.745 seconds for an acknowledged restart and 21.915 seconds for one interrupted-marker recovery. Both drafts state that these single synthetic observations prove neither a trusted source-to-binary release, the bytes Windows mapped for execution, a complete repository-only write footprint, real SDK behavior nor a production 30-second pass. Both left the compiled selector off and left the 30-second routine, 180-second recovery and 120-second post-acquisition settlement targets unchanged.

## Prepared compiled process transport

This draft would build the compiled broker and observer into a local versioned cache, either through a separate preparation operation or automatically on first use inside `chat`, and launch routine chat from that cache read-only. It left four decisions open:

- **First-use entry.** A separate preparation command would change the CLI's four-command entry surface, while automatic preparation inside `chat` would add a state-changing phase, crash states and its whole elapsed time to the first start, and could not run before the instance guard under the zero pre-guard write rule.
- **Capacity and write containment.** The Go build cache was observed at 121.6 MB. The draft proposed a namespace limit of two complete versions and one staging attempt with peak-byte admission informed by measurements, but found no way to keep preparation from spending a live runtime's recovery reserve without either proved nonconcurrency with every writer on the volume or a separately protected reserve, and it required a whole builder and loader process tree proved to write only inside the repository.
- **Staging maintenance and recovery.** Incomplete, stale or foreign cache entries would be preserved and refused rather than deleted, because no owner, removal proof or user-facing disposition was agreed.
- **Provider route.** Keeping the provider on the PowerShell broker or moving it to the compiled broker was unresolved, with no whole-start timing or default-profile footprint proof for either.

It also required proof that the executed images were the admitted bytes, which the private before-and-after path hashes did not give.

## Shipped immutable native artifacts

This draft would ship the five outputs as a complete versioned package written only by a reviewed release installer, never built or extracted by chat, with a source-owned pin selecting one trusted manifest. Its open gates were:

- **Framework images.** A framework-dependent apphost also loads the installed `hostfxr` and shared framework, which the five shipped outputs do not include, so the package would have to pin and admit those images too.
- **Consumed documents.** `hostfxr` and `hostpolicy` read the runtime configuration and dependency documents as parsed input, which needs its own proof that the exact admitted bytes were consumed.
- **Mapped images.** Node's read handles allow write and delete sharing, so a path hash before or after launch does not prove the mapped bytes; the [executable image gap](runtime-artifact-image-gap-20261018.md) records the same limit for the private Go adapters.
- **Write footprint.** The broker, observer, loader and provider-child process trees needed positive repository-only write evidence, including crash, telemetry and loader temporary writes.

The draft named a self-contained NativeAOT broker as a separate possible architecture, not a proven substitute.

## NativeAOT broker spike

The spike prepared the C# broker for NativeAOT on x64 Windows: it replaced the broker header's one reflection-based JSON call with `Utf8JsonWriter`, locked six source files and four installed 10.0.8 compiler and runtime package archives by hash, and wrote an offline build script that would redirect every profile, temporary, .NET and NuGet path into a run folder under the repository. The script was gated off pending review, and nothing was restored, built, published or run. Its acceptance plan required a single executable with no managed DLL or host documents, byte-identical repeat builds and header byte equivalence with the original broker. It established no result.
