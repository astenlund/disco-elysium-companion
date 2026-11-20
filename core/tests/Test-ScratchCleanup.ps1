#Requires -Version 7.5

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('All', 'Removal', 'FileSweep', 'HarnessCleanup', 'ConcurrentSweep', 'StaggeredSweep', IgnoreCase = $false)]
    [string] $Only = 'All',

    # The concurrent races are timing-dependent, so the stress rounds trade run time for the
    # chance of meeting them; a passing run is evidence, not proof, that the sweep tolerates them.
    [Parameter()] [ValidateRange(1, 1000)] [int] $Rounds = 40,
    [Parameter()] [ValidateRange(2, 16)] [int] $Sweepers = 6,
    [Parameter()] [ValidateRange(1, 1000)] [int] $StaggerRounds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'TestSupport.psm1') -Force
# The body below is deliberately not indented under this try, so its here-string fixtures keep their bytes.
try {

$script:TestSupport = Get-Module TestSupport
$script:ProjectTmp = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tmp'))
$script:Utf8 = [Text.UTF8Encoding]::new($false, $true)
$script:ClaimPattern = '^scratch-sweep-claim-([0-9]+)-[0-9a-f]{32}$'

function Test-Selected {
    param([Parameter(Mandatory)] [string] $Name)

    return $Only -ceq 'All' -or $Only -ceq $Name
}

function New-ScratchTree {
    param([Parameter(Mandatory)] [string] $Root, [int] $Directories = 60, [int] $FilesPerDirectory = 60)

    for ($directory = 0; $directory -lt $Directories; $directory++) {
        $leaf = Join-Path $Root "d$directory/a/b/c"
        [void] [IO.Directory]::CreateDirectory($leaf)
        for ($file = 0; $file -lt $FilesPerDirectory; $file++) { [IO.File]::WriteAllText((Join-Path $leaf "f$file.txt"), 'x', $script:Utf8) }
    }
}

function Invoke-StaleRootRemoval {
    param([Parameter(Mandatory)] [string] $Path, [scriptblock] $Remove, [ValidateSet('Remove-StaleScratchRoot', 'Remove-StaleScratchFile')] [string] $Command = 'Remove-StaleScratchRoot')

    if ($null -eq $Remove) {
        & $script:TestSupport { param($Command, $Path) & $Command -Path $Path } $Command $Path
    }
    else {
        & $script:TestSupport { param($Command, $Path, $Remove) & $Command -Path $Path -Remove $Remove } $Command $Path $Remove
    }
}

# Returns a process that has already exited, standing in for a dead scratch creator. Callers
# hold the returned object for as long as they rely on its id: its open handle keeps Windows
# from reusing the id for a new process, which a sweep would then see as a live creator.
function Start-ExitedProcess {
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden
    $process.WaitForExit()

    return $process
}

function Test-OwnedScratchRoot {
    param([Parameter(Mandatory)] [string] $Path)

    return & $script:TestSupport { param($Path) $script:ScratchRoots.Contains($Path) } $Path
}

function Get-ScratchResidueReports {
    param([Parameter(Mandatory)] [AllowEmptyString()] [string] $StdErr)

    return @($StdErr -split '\r?\n' | Where-Object { $_.StartsWith('{"scratchResidue"', [StringComparison]::Ordinal) } | ForEach-Object { ($_ | ConvertFrom-Json).scratchResidue })
}

# Removes a root a child harness left behind once the child has exited, after checking it is a scratch root directly under .tmp.
function Remove-ChildScratchRoot {
    param([Parameter(Mandatory)] [string] $Path)

    Assert-OrdinalEqual -Actual ([IO.Path]::GetDirectoryName($Path)) -Expected $script:ProjectTmp -Message "A child's leftover root lies directly under .tmp ($Path)."
    if ([IO.Directory]::Exists($Path)) { [IO.Directory]::Delete($Path, $true) }
}

function Get-ClaimNames {
    param([Parameter(Mandatory)] [string] $Directory, [Parameter(Mandatory)] [int[]] $ProcessIds)

    return @([IO.Directory]::GetFileSystemEntries($Directory) | ForEach-Object { [IO.Path]::GetFileName($_) } | Where-Object {
            $match = [regex]::Match($_, $script:ClaimPattern)
            $match.Success -and [int] $match.Groups[1].Value -in $ProcessIds
        })
}

if (Test-Selected 'Removal') {
    $scratch = New-ScratchCompanionRoot -Prefix 'scratch-removal'

    # A creator counts as exited only when no process has its id at the moment of the check.
    $exitedProcess = Start-ExitedProcess
    Assert-True -Condition (& $script:TestSupport { param($Id) Test-ScratchCreatorExited -ProcessId $Id } $exitedProcess.Id) -Message 'An exited creator counts as exited.'
    Assert-False -Condition (& $script:TestSupport { param($Id) Test-ScratchCreatorExited -ProcessId $Id } $PID) -Message 'A running creator does not count as exited.'

    # The default removal claims the root and deletes the claimed tree completely.
    $plain = Join-Path $scratch 'plain'
    New-ScratchTree -Root $plain -Directories 2 -FilesPerDirectory 2
    Invoke-StaleRootRemoval -Path $plain
    Assert-False -Condition ([IO.Directory]::Exists($plain)) -Message 'A swept root is gone.'
    Assert-Equal -Actual @(Get-ClaimNames -Directory $scratch -ProcessIds @($PID)).Count -Expected 0 -Message 'A swept root leaves no claimed tree behind.'

    # The claim is an atomic rename beside the root to a scratch-shaped name carrying this
    # process id, done before any removal starts.
    $named = Join-Path $scratch 'named'
    New-ScratchTree -Root $named -Directories 1 -FilesPerDirectory 1
    $seen = @{ target = $null; rootGone = $false }
    Invoke-StaleRootRemoval -Path $named -Remove { param($Target) $seen.target = $Target; $seen.rootGone = -not [IO.Directory]::Exists($named); [IO.Directory]::Delete($Target, $true) }.GetNewClosure()
    Assert-True -Condition $seen.rootGone -Message 'The root is renamed away before removal starts.'
    Assert-OrdinalEqual -Actual ([IO.Path]::GetDirectoryName($seen.target)) -Expected $scratch -Message 'The claim stays beside the root.'
    $claimMatch = [regex]::Match([IO.Path]::GetFileName($seen.target), $script:ClaimPattern)
    Assert-True -Condition ($claimMatch.Success -and [int] $claimMatch.Groups[1].Value -eq $PID) -Message "The claim name carries this live process id ($($seen.target))."

    # A root another sweeper already claimed or removed is skipped without any removal.
    $lostCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path (Join-Path $scratch 'already-gone') -Remove { param($Target) $lostCalls.count++ }.GetNewClosure()
    Assert-Equal -Actual $lostCalls.count -Expected 0 -Message 'A root that is already gone is not removed.'

    # An attempt that returns normally but leaves the claimed tree (a suppressed partial
    # removal) is repeated until the tree is gone.
    $lingering = Join-Path $scratch 'lingering'
    New-ScratchTree -Root $lingering -Directories 1 -FilesPerDirectory 1
    $lingeringCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Path $lingering -Remove { param($Target) $lingeringCalls.count++; if ($lingeringCalls.count -ge 2) { [IO.Directory]::Delete($Target, $true) } }.GetNewClosure()
    Assert-Equal -Actual $lingeringCalls.count -Expected 2 -Message 'A tree left by a normally returning attempt is removed again once.'
    Assert-Equal -Actual @(Get-ClaimNames -Directory $scratch -ProcessIds @($PID)).Count -Expected 0 -Message 'A tree left by a normally returning attempt is gone after the retry.'

    # A claimed tree that every attempt leaves in place surfaces after the bound and stays
    # for inspection.
    $survivor = Join-Path $scratch 'survivor'
    New-ScratchTree -Root $survivor -Directories 1 -FilesPerDirectory 1
    $survivorSeen = @{ count = 0; target = $null }
    $survivorError = $null
    try { Invoke-StaleRootRemoval -Path $survivor -Remove { param($Target) $survivorSeen.count++; $survivorSeen.target = $Target }.GetNewClosure() }
    catch { $survivorError = $_.Exception }
    Assert-True -Condition ($null -ne $survivorError) -Message 'A tree no attempt removes is reported.'
    Assert-Equal -Actual $survivorSeen.count -Expected 3 -Message 'A tree no attempt removes is attempted exactly three times.'
    Assert-True -Condition ([IO.Directory]::Exists($survivorSeen.target)) -Message 'A tree no attempt removes is left for inspection.'
    Assert-True -Condition ($survivorError.Message.Contains($survivorSeen.target, [StringComparison]::Ordinal) -and $survivorError.Message.Contains($survivor, [StringComparison]::Ordinal)) -Message "A surviving tree's error names the claim and the original root ($($survivorError.Message))."
    [IO.Directory]::Delete($survivorSeen.target, $true)

    # A removal failure surfaces at once.
    $failing = Join-Path $scratch 'failing'
    New-ScratchTree -Root $failing -Directories 1 -FilesPerDirectory 1
    $failingSeen = @{ count = 0; target = $null }
    $failingError = $null
    try { Invoke-StaleRootRemoval -Path $failing -Remove { param($Target) $failingSeen.count++; $failingSeen.target = $Target; throw [ComponentModel.Win32Exception]::new(5) }.GetNewClosure() }
    catch { $failingError = $_.Exception }
    $failingException = $failingError
    while ($null -ne $failingException -and $failingException -isnot [ComponentModel.Win32Exception]) { $failingException = $failingException.InnerException }
    Assert-True -Condition ($null -ne $failingException -and $failingException.NativeErrorCode -eq 5) -Message 'A removal failure is rethrown.'
    Assert-True -Condition ($failingError -is [IO.IOException] -and $failingError.Message.Contains($failingSeen.target, [StringComparison]::Ordinal) -and $failingError.Message.Contains($failing, [StringComparison]::Ordinal)) -Message "A removal failure names the claim and the original root ($($failingError.Message))."
    Assert-True -Condition ($null -ne $failingException -and $failingError.Message.Contains($failingException.Message, [StringComparison]::Ordinal)) -Message "A removal failure keeps its cause in the message ($($failingError.Message))."
    Assert-Equal -Actual $failingSeen.count -Expected 1 -Message 'A removal failure is not retried.'
    [IO.Directory]::Delete($failingSeen.target, $true)

    # A claimed path that stops being an ordinary directory is left alone.
    $replaced = Join-Path $scratch 'replaced'
    New-ScratchTree -Root $replaced -Directories 1 -FilesPerDirectory 1
    $replacedSeen = @{ count = 0; target = $null }
    Invoke-StaleRootRemoval -Path $replaced -Remove { param($Target) $replacedSeen.count++; $replacedSeen.target = $Target; [IO.Directory]::Delete($Target, $true); [IO.File]::WriteAllText($Target, 'not a directory') }.GetNewClosure()
    Assert-Equal -Actual $replacedSeen.count -Expected 1 -Message 'A claimed path replaced by a file is not removed again.'
    Assert-True -Condition ([IO.File]::Exists($replacedSeen.target)) -Message 'A file that replaced a claimed path is left in place.'

    # A harness removes a root it created explicitly and learns that it is gone.
    $owned = New-ScratchCompanionRoot -Prefix 'scratch-owned-removal'
    New-ScratchTree -Root (Join-Path $owned 'tree') -Directories 2 -FilesPerDirectory 2
    Remove-ScratchCompanionRoot -Path $owned
    Assert-False -Condition ([IO.Directory]::Exists($owned)) -Message 'An explicitly removed owned root is gone.'

    # Only a root this process created can be removed explicitly; a tree it did not create survives the refusal.
    $foreign = Join-Path $scratch 'foreign'
    New-ScratchTree -Root $foreign -Directories 1 -FilesPerDirectory 1
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Remove-ScratchCompanionRoot -Path $foreign }
    Assert-True -Condition ([IO.File]::Exists((Join-Path $foreign 'd0/a/b/c/f0.txt'))) -Message 'A tree this process did not create survives an explicit removal request.'

    # An owned root replaced by a reparse point is refused, and the reparse target keeps its content.
    $sentinel = Join-Path $scratch 'sentinel'
    New-ScratchTree -Root $sentinel -Directories 1 -FilesPerDirectory 1
    $linked = New-ScratchCompanionRoot -Prefix 'scratch-owned-junction'
    [IO.Directory]::Delete($linked)
    $null = New-Item -ItemType Junction -Path $linked -Target $sentinel
    try {
        Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Remove-ScratchCompanionRoot -Path $linked }
        Assert-True -Condition ([IO.File]::Exists((Join-Path $sentinel 'd0/a/b/c/f0.txt'))) -Message 'A junction standing at an owned root is never followed by an explicit removal.'
    }
    finally {
        # Deleting the junction without recursion removes only the link.
        [IO.Directory]::Delete($linked)
    }
    Assert-True -Condition ([IO.File]::Exists((Join-Path $sentinel 'd0/a/b/c/f0.txt'))) -Message 'Removing the junction leaves its target intact.'

    # An owned root that every attempt leaves surfaces with its root-relative residue and stays.
    $stubborn = New-ScratchCompanionRoot -Prefix 'scratch-owned-survivor'
    New-ScratchTree -Root (Join-Path $stubborn 'tree') -Directories 1 -FilesPerDirectory 2
    $stubbornCalls = @{ count = 0 }
    $stubbornError = $null
    try { Remove-ScratchCompanionRoot -Path $stubborn -Remove { param($Target) $stubbornCalls.count++ }.GetNewClosure() }
    catch { $stubbornError = $_.Exception }
    Assert-True -Condition ($stubbornError -is [IO.IOException]) -Message "A surviving owned root is reported as an IOException ($stubbornError)."
    Assert-Equal -Actual $stubbornCalls.count -Expected 3 -Message 'A surviving owned root is attempted exactly three times.'
    $residue = $stubbornError.Data['ScratchResidue']
    # tree, d0, a, b and c, then f0.txt and f1.txt.
    Assert-Equal -Actual $residue.remaining -Expected 7 -Message 'The residue counts every directory and file left under the root.'
    Assert-OrdinalEqual -Actual $residue.listing -Expected 'complete' -Message 'The residue listing is complete.'
    Assert-True -Condition ($residue.sample -ccontains 'tree/d0/a/b/c/f1.txt') -Message "The residue sample holds root-relative forward-slash paths ($($residue.sample -join ', '))."
    Assert-False -Condition (@($residue.sample | Where-Object { $_.Contains($stubborn, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) -Message 'The residue sample never names the root itself.'
    Assert-True -Condition ([IO.Directory]::Exists($stubborn)) -Message 'A surviving owned root is left for inspection.'
    Remove-ScratchCompanionRoot -Path $stubborn
    Assert-False -Condition ([IO.Directory]::Exists($stubborn)) -Message 'A surviving owned root stays owned and can be removed once released.'

    # An owned root replaced by a file during removal is residue, not a removed root: the file stays, and so does ownership.
    $occupied = New-ScratchCompanionRoot -Prefix 'scratch-owned-occupied'
    $occupiedCalls = @{ count = 0 }
    $occupiedError = $null
    try { Remove-ScratchCompanionRoot -Path $occupied -Remove { param($Target) $occupiedCalls.count++; [IO.Directory]::Delete($Target, $true); [IO.File]::WriteAllText($Target, 'occupied') }.GetNewClosure() }
    catch { $occupiedError = $_.Exception }
    Assert-True -Condition ($occupiedError -is [IO.IOException]) -Message "An owned root replaced by a file is reported as residue ($occupiedError)."
    Assert-Equal -Actual $occupiedCalls.count -Expected 1 -Message 'An owned root replaced by a file is not removed again.'
    Assert-OrdinalEqual -Actual $occupiedError.Data['ScratchResidue'].kind -Expected 'not-a-directory' -Message 'The residue names an entry that is not a directory.'
    Assert-True -Condition ([IO.File]::Exists($occupied)) -Message 'The file standing at the owned root is left in place.'
    [IO.File]::Delete($occupied)
    Remove-ScratchCompanionRoot -Path $occupied
    Assert-False -Condition (Test-Path -LiteralPath $occupied) -Message 'An owned root reported as residue stays owned and can be removed once cleared.'
}

if (Test-Selected 'FileSweep') {
    $fileScratch = New-ScratchCompanionRoot -Prefix 'scratch-file-removal'

    # The sweep reaps a scratch-shaped file whose creator has exited, as a crashed harness leaves when a file stands at
    # its root's path, and an abandoned claim of one; it keeps a file whose creator is alive, a live sweeper's claim, a
    # file whose name is not scratch-shaped and a file held open with no sharing. The real sweep runs against a private
    # boundary inside this harness's own scratch, standing in for the project .tmp for that one call, so no concurrent
    # harness can take or add its inputs.
    $deadProcess = Start-ExitedProcess
    $deadId = $deadProcess.Id
    # A separate live process stands in for another harness and its sweeper, so the kept entries depend on the liveness
    # lookup and not on matching the sweeping process's own id.
    $boundary = Join-Path $fileScratch 'sweep-boundary'
    [void] [IO.Directory]::CreateDirectory($boundary)
    $projectTmpRoot = & $script:TestSupport { $script:ProjectTmpRoot }
    $liveOwner = Start-BoundedPwsh -Arguments @('-Command', 'Start-Sleep -Seconds 120')
    $holder = $null
    try {
        $liveId = $liveOwner.Process.Id
        $deadFile = Join-Path $boundary "scratch-file-dead-$deadId-$([guid]::NewGuid().ToString('N'))"
        $abandonedClaim = Join-Path $boundary "scratch-sweep-claim-$deadId-$([guid]::NewGuid().ToString('N'))"
        $liveFile = Join-Path $boundary "scratch-file-live-$liveId-$([guid]::NewGuid().ToString('N'))"
        $liveClaim = Join-Path $boundary "scratch-sweep-claim-$liveId-$([guid]::NewGuid().ToString('N'))"
        $unshapedFile = Join-Path $boundary "scratch-file-unshaped-$deadId-$([guid]::NewGuid().ToString('N')).txt"
        $heldFile = Join-Path $boundary "scratch-file-held-$deadId-$([guid]::NewGuid().ToString('N'))"
        foreach ($file in @($deadFile, $abandonedClaim, $liveFile, $liveClaim, $unshapedFile, $heldFile)) { [IO.File]::WriteAllText($file, 'residue', $script:Utf8) }
        $holder = [IO.File]::Open($heldFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        & $script:TestSupport { param($Boundary) $script:ProjectTmpRoot = $Boundary; $script:StaleScratchSwept = $false; Clear-StaleScratchRoots } $boundary
    }
    finally {
        & $script:TestSupport { param($Root) $script:ProjectTmpRoot = $Root } $projectTmpRoot
        if ($null -ne $holder) { $holder.Dispose() }
        Stop-BoundedPwsh -Child $liveOwner
    }
    Assert-False -Condition (Test-Path -LiteralPath $deadFile) -Message 'A scratch-shaped file whose creator exited is reaped.'
    Assert-False -Condition (Test-Path -LiteralPath $abandonedClaim) -Message 'An abandoned claim of a file, whose sweeper exited, is reaped.'
    Assert-True -Condition ([IO.File]::Exists($liveFile)) -Message 'A scratch-shaped file whose creator is alive is kept.'
    Assert-True -Condition ([IO.File]::Exists($liveClaim)) -Message 'A claim carrying another live sweeper''s process id is kept.'
    Assert-True -Condition ([IO.File]::Exists($unshapedFile)) -Message 'A file whose name is not scratch-shaped is kept.'
    Assert-True -Condition ([IO.File]::Exists($heldFile)) -Message 'A file held open with no sharing is skipped, not failed, and kept for a later sweep.'
    Assert-Equal -Actual @(Get-ClaimNames -Directory $boundary -ProcessIds @($PID)).Count -Expected 0 -Message 'The sweep leaves no claim of its own behind.'

    # The claim is an atomic rename beside the file to a scratch-shaped name carrying this process id, done before the deletion.
    $named = Join-Path $fileScratch 'named'
    [IO.File]::WriteAllText($named, 'residue', $script:Utf8)
    $namedSeen = @{ target = $null; fileGone = $false }
    Invoke-StaleRootRemoval -Command 'Remove-StaleScratchFile' -Path $named -Remove { param($Target) $namedSeen.target = $Target; $namedSeen.fileGone = -not [IO.File]::Exists($named); [IO.File]::Delete($Target) }.GetNewClosure()
    Assert-True -Condition $namedSeen.fileGone -Message 'The file is renamed away before its deletion.'
    Assert-OrdinalEqual -Actual ([IO.Path]::GetDirectoryName($namedSeen.target)) -Expected $fileScratch -Message 'The file claim stays beside the file.'
    $fileClaimMatch = [regex]::Match([IO.Path]::GetFileName($namedSeen.target), $script:ClaimPattern)
    Assert-True -Condition ($fileClaimMatch.Success -and [int] $fileClaimMatch.Groups[1].Value -eq $PID) -Message "The file claim name carries this live process id ($($namedSeen.target))."
    Assert-False -Condition (Test-Path -LiteralPath $namedSeen.target) -Message 'A claimed file is gone after its deletion.'

    # A file another sweeper already claimed or removed is skipped without any deletion.
    $lostFileCalls = @{ count = 0 }
    Invoke-StaleRootRemoval -Command 'Remove-StaleScratchFile' -Path (Join-Path $fileScratch 'already-gone') -Remove { param($Target) $lostFileCalls.count++ }.GetNewClosure()
    Assert-Equal -Actual $lostFileCalls.count -Expected 0 -Message 'A file that is already gone is not deleted.'

    # A deletion failure surfaces at once, naming the claim and the original file and keeping its cause.
    $failingFile = Join-Path $fileScratch 'failing'
    [IO.File]::WriteAllText($failingFile, 'residue', $script:Utf8)
    $failingFileSeen = @{ count = 0; target = $null }
    $failingFileError = $null
    try { Invoke-StaleRootRemoval -Command 'Remove-StaleScratchFile' -Path $failingFile -Remove { param($Target) $failingFileSeen.count++; $failingFileSeen.target = $Target; throw [ComponentModel.Win32Exception]::new(5) }.GetNewClosure() }
    catch { $failingFileError = $_.Exception }
    $failingFileCause = $failingFileError
    while ($null -ne $failingFileCause -and $failingFileCause -isnot [ComponentModel.Win32Exception]) { $failingFileCause = $failingFileCause.InnerException }
    Assert-True -Condition ($null -ne $failingFileCause -and $failingFileCause.NativeErrorCode -eq 5) -Message 'A file deletion failure is rethrown.'
    Assert-True -Condition ($failingFileError -is [IO.IOException] -and $failingFileError.Message.Contains($failingFileSeen.target, [StringComparison]::Ordinal) -and $failingFileError.Message.Contains($failingFile, [StringComparison]::Ordinal)) -Message "A file deletion failure names the claim and the original file ($($failingFileError.Message))."
    Assert-True -Condition ($null -ne $failingFileCause -and $failingFileError.Message.Contains($failingFileCause.Message, [StringComparison]::Ordinal)) -Message "A file deletion failure keeps its cause in the message ($($failingFileError.Message))."
    Assert-Equal -Actual $failingFileSeen.count -Expected 1 -Message 'A file deletion failure is not retried.'
    [IO.File]::Delete($failingFileSeen.target)

    # A claimed file the deletion leaves in place surfaces, naming the claim and the original file, and stays for inspection.
    $survivingFile = Join-Path $fileScratch 'surviving'
    [IO.File]::WriteAllText($survivingFile, 'residue', $script:Utf8)
    $survivingFileSeen = @{ target = $null }
    $survivingFileError = $null
    try { Invoke-StaleRootRemoval -Command 'Remove-StaleScratchFile' -Path $survivingFile -Remove { param($Target) $survivingFileSeen.target = $Target }.GetNewClosure() }
    catch { $survivingFileError = $_.Exception }
    Assert-True -Condition ($survivingFileError -is [IO.IOException] -and $survivingFileError.Message.Contains($survivingFileSeen.target, [StringComparison]::Ordinal) -and $survivingFileError.Message.Contains($survivingFile, [StringComparison]::Ordinal)) -Message "A surviving claimed file is reported, naming the claim and the original file ($survivingFileError)."
    Assert-True -Condition ([IO.File]::Exists($survivingFileSeen.target)) -Message 'A surviving claimed file is left for inspection.'
    [IO.File]::Delete($survivingFileSeen.target)
}

if (Test-Selected 'HarnessCleanup') {
    $harnessScratch = New-ScratchCompanionRoot -Prefix 'scratch-harness-cleanup'

    # A named removal attempts every root, keeps a survivor owned and reports it on stderr instead of throwing.
    $first = New-ScratchCompanionRoot -Prefix 'scratch-path-first'
    $held = New-ScratchCompanionRoot -Prefix 'scratch-path-held'
    $last = New-ScratchCompanionRoot -Prefix 'scratch-path-last'
    New-ScratchTree -Root $first -Directories 1 -FilesPerDirectory 1
    New-ScratchTree -Root $last -Directories 1 -FilesPerDirectory 1
    $handle = [IO.File]::Open((Join-Path $held 'held.txt'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $capture = [IO.StringWriter]::new()
    $originalError = [Console]::Error
    [Console]::SetError($capture)
    try {
        Remove-OwnedScratchRoots -Path $first, $held, $last
    }
    finally {
        [Console]::SetError($originalError)
        $handle.Dispose()
    }
    Assert-False -Condition ([IO.Directory]::Exists($first) -or [IO.Directory]::Exists($last)) -Message 'A named removal removes the roots on either side of a survivor.'
    Assert-True -Condition ([IO.Directory]::Exists($held)) -Message 'A root held open survives the named removal.'
    $reports = @(Get-ScratchResidueReports -StdErr $capture.ToString())
    Assert-Equal -Actual $reports.Count -Expected 1 -Message "Only the survivor is reported ($($capture.ToString().Trim()))."
    Assert-OrdinalEqual -Actual $reports[0].root -Expected $held -Message 'The report names the surviving root.'
    Assert-True -Condition (@($reports[0].residue.sample) -ccontains 'held.txt') -Message "The report carries the survivor's residue ($($capture.ToString().Trim()))."
    Assert-True -Condition (Test-OwnedScratchRoot -Path $held) -Message 'A survivor stays owned.'
    Assert-False -Condition (Test-OwnedScratchRoot -Path $first) -Message 'A removed root is no longer owned.'
    Remove-OwnedScratchRoots -Path $held
    Assert-False -Condition ([IO.Directory]::Exists($held) -or (Test-OwnedScratchRoot -Path $held)) -Message 'A survivor is removed by a later attempt once released.'

    # Naming a root this process did not create throws before any named root is removed.
    $kept = New-ScratchCompanionRoot -Prefix 'scratch-path-kept'
    $foreign = Join-Path $harnessScratch 'foreign'
    [void] [IO.Directory]::CreateDirectory($foreign)
    Assert-ThrowsType -TypeName 'System.InvalidOperationException' -Action { Remove-OwnedScratchRoots -Path $kept, $foreign }
    Assert-True -Condition ([IO.Directory]::Exists($kept) -and [IO.Directory]::Exists($foreign)) -Message 'A refused named removal removes nothing.'
    Remove-OwnedScratchRoots -Path $kept

    # A child harness built on the shared template exits 0 only when its body passed and none of its scratch is left.
    $childHarness = Join-Path $harnessScratch 'child-harness.ps1'
    $childScript = @'
param([Parameter(Mandatory)] [string] $SupportPath, [Parameter(Mandatory)] [string] $Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module $SupportPath -Force
try {
    $roots = @(foreach ($name in 'first', 'held', 'last') { New-ScratchCompanionRoot -Prefix "scratch-child-$name" })
    [IO.File]::WriteAllText((Join-Path $roots[0] 'f.txt'), 'x')
    [IO.File]::WriteAllText((Join-Path $roots[2] 'f.txt'), 'x')
    $handle = $null
    if ($Mode -cne 'Clean') {
        $handle = [IO.File]::Open((Join-Path $roots[1] 'held.txt'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($roots) -Compress))
    if ($Mode -ceq 'Failure') {
        throw 'injected child body failure'
    }
    if ($Mode -ceq 'EarlyExit') {
        exit 0
    }
    Write-Output 'PASS: child harness'
}
catch {
    Exit-HarnessFailure -ErrorRecord $_
}
finally {
    Complete-ScratchHarness
}
'@
    [IO.File]::WriteAllText($childHarness, $childScript, $script:Utf8)
    $supportPath = Join-Path $PSScriptRoot 'TestSupport.psm1'
    foreach ($mode in 'Clean', 'Residue', 'Failure', 'EarlyExit') {
        $run = Invoke-BoundedPwsh -Arguments @('-File', $childHarness, '-SupportPath', $supportPath, '-Mode', $mode) -TimeoutMilliseconds 60000
        $childRoots = @(($run.StdOut -split '\r?\n')[0] | ConvertFrom-Json)
        try {
            Assert-Equal -Actual $childRoots.Count -Expected 3 -Message "The $mode child announces its roots (stdout: $($run.StdOut.Trim()); stderr: $($run.StdErr.Trim()))."
            Assert-False -Condition ([IO.Directory]::Exists($childRoots[0]) -or [IO.Directory]::Exists($childRoots[2])) -Message "The $mode child removes the roots it can."
            $childReports = @(Get-ScratchResidueReports -StdErr $run.StdErr)
            if ($mode -ceq 'Clean') {
                Assert-Equal -Actual $run.ExitCode -Expected 0 -Message "A clean child harness exits 0 (stderr: $($run.StdErr.Trim()))."
                Assert-False -Condition ([IO.Directory]::Exists($childRoots[1])) -Message 'A clean child harness leaves no scratch.'
                Assert-Equal -Actual $childReports.Count -Expected 0 -Message 'A clean child harness reports no residue.'
                continue
            }
            Assert-Equal -Actual $run.ExitCode -Expected 1 -Message "A $mode child harness with residue exits 1."
            Assert-True -Condition ([IO.Directory]::Exists($childRoots[1])) -Message "The $mode child's held root survives."
            Assert-Equal -Actual $childReports.Count -Expected 1 -Message "The $mode child reports its one survivor ($($run.StdErr.Trim()))."
            Assert-OrdinalEqual -Actual $childReports[0].root -Expected $childRoots[1] -Message "The $mode child's report names the held root."
            Assert-True -Condition $run.StdErr.Contains('FAIL: 1 scratch root(s) survived removal', [StringComparison]::Ordinal) -Message "The $mode child names its residue failure ($($run.StdErr.Trim()))."
            if ($mode -ceq 'Residue') {
                Assert-True -Condition $run.StdOut.Contains('PASS: child harness', [StringComparison]::Ordinal) -Message 'Residue fails a child harness whose body passed.'
            }
            if ($mode -ceq 'Failure') {
                Assert-True -Condition $run.StdErr.Contains('injected child body failure', [StringComparison]::Ordinal) -Message "A body failure stays visible beside the residue report ($($run.StdErr.Trim()))."
            }
        }
        finally {
            foreach ($childRoot in $childRoots) { Remove-ChildScratchRoot -Path $childRoot }
        }
    }

    # The fixture host removes a root whose staging failed before it announced the root.
    $fixtureHost = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../runtime/test/fixtures/companion-root.ps1'))
    $fixtureChild = Start-BoundedPwsh -Arguments @('-File', $fixtureHost, '-StagingFault')
    $fixtureId = $fixtureChild.Process.Id
    $fixtureRun = Complete-BoundedPwsh -Child $fixtureChild -TimeoutMilliseconds 60000
    Assert-True -Condition ($fixtureRun.ExitCode -ne 0) -Message 'A fixture host whose staging fails exits nonzero.'
    Assert-True -Condition $fixtureRun.StdErr.Contains('Injected fixture staging fault', [StringComparison]::Ordinal) -Message "The staging failure reaches stderr ($($fixtureRun.StdErr.Trim()))."
    Assert-OrdinalEqual -Actual $fixtureRun.StdOut.Trim() -Expected '' -Message 'A fixture host whose staging fails announces no root.'
    $fixtureLeft = @([IO.Directory]::GetDirectories($script:ProjectTmp) | Where-Object { [IO.Path]::GetFileName($_) -match "^runtime-fixture-$fixtureId-[0-9a-f]{32}$" })
    Assert-Equal -Actual $fixtureLeft.Count -Expected 0 -Message "A fixture host whose staging fails leaves no root ($($fixtureLeft -join ', '))."
}

if (Test-Selected 'ConcurrentSweep') {
    # Several real sweepers start together against one large dead-process root, the shape
    # the shared helper reaps when parallel harnesses start in the same checkout.
    $sweeper = Join-Path $PSScriptRoot 'Invoke-ScratchSweep.ps1'
    $deadProcess = Start-ExitedProcess
    $deadId = $deadProcess.Id
    Assert-True -Condition ($null -eq (Get-Process -Id $deadId -ErrorAction SilentlyContinue)) -Message 'The dead creator process has exited.'
    $control = New-ScratchCompanionRoot -Prefix 'scratch-sweep-control'
    [void] [IO.Directory]::CreateDirectory($script:ProjectTmp)

    for ($round = 1; $round -le $Rounds; $round++) {
        $root = Join-Path $script:ProjectTmp "scratch-sweep-$deadId-$([guid]::NewGuid().ToString('N'))"
        New-ScratchTree -Root $root
        $go = Join-Path $control "go-$round"
        $children = @()
        $sweeperIds = @()
        try {
            for ($index = 0; $index -lt $Sweepers; $index++) {
                $child = Start-BoundedPwsh -Arguments @('-File', $sweeper, '-GoFile', $go)
                $children += $child
                $sweeperIds += $child.Process.Id
            }
            # Every sweeper imports its module before the go file appears.
            Start-Sleep -Milliseconds 2500
            [IO.File]::WriteAllText($go, 'go', $script:Utf8)
            foreach ($child in $children) {
                $result = Complete-BoundedPwsh -Child $child -TimeoutMilliseconds 120000
                Assert-Equal -Actual $result.ExitCode -Expected 0 -Message "Round $round sweeper exits cleanly (stderr: $($result.StdErr.Trim()))"
            }
            Assert-False -Condition ([IO.Directory]::Exists($root)) -Message "Round $round leaves no part of the dead root."
            Assert-Equal -Actual @(Get-ClaimNames -Directory $script:ProjectTmp -ProcessIds $sweeperIds).Count -Expected 0 -Message "Round $round leaves no claimed tree."
        }
        finally {
            # Every sweeper still running is killed before the root is cleaned up.
            foreach ($child in $children) { Stop-BoundedPwsh -Child $child }
            if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
        }
    }
}

if (Test-Selected 'StaggeredSweep') {
    # A second sweeper starts while the first is still sweeping many dead roots, so it is
    # absent from any liveness view the first took earlier. Entries sort as the early roots,
    # the fillers, the second sweeper's claims and then the late roots, so the first sweeper
    # reaches the second's in-progress claims after its own start.
    $sweeper = Join-Path $PSScriptRoot 'Invoke-ScratchSweep.ps1'
    $deadProcess = Start-ExitedProcess
    $deadId = $deadProcess.Id
    Assert-True -Condition ($null -eq (Get-Process -Id $deadId -ErrorAction SilentlyContinue)) -Message 'The dead creator process has exited.'
    $control = New-ScratchCompanionRoot -Prefix 'scratch-stagger-control'
    $go = Join-Path $control 'go'
    [IO.File]::WriteAllText($go, 'go', $script:Utf8)
    # Fillers keep .tmp larger than one enumeration buffer. They are ordinary scratch roots of
    # this live process, so sweepers skip them now and a later sweep reaps them after a crash.
    $fillers = @(for ($index = 0; $index -lt 80; $index++) { New-ScratchCompanionRoot -Prefix ('m-scratch-stagger-filler-{0:D3}' -f $index) })

    try {
        for ($round = 1; $round -le $StaggerRounds; $round++) {
            $roots = @(foreach ($index in 0..11) { Join-Path $script:ProjectTmp ('a{0:D2}-{1}-{2}' -f $index, $deadId, [guid]::NewGuid().ToString('N')) })
            $roots += @(foreach ($index in 0..5) { Join-Path $script:ProjectTmp ('z{0:D2}-{1}-{2}' -f $index, $deadId, [guid]::NewGuid().ToString('N')) })
            foreach ($root in $roots) { New-ScratchTree -Root $root -Directories 40 -FilesPerDirectory 25 }
            $children = @()
            $sweeperIds = @()
            try {
                $first = Start-BoundedPwsh -Arguments @('-File', $sweeper, '-GoFile', $go)
                $children += $first
                $sweeperIds += $first.Process.Id
                $deadline = [DateTime]::UtcNow.AddSeconds(60)
                while ([IO.Directory]::Exists($roots[0]) -and [DateTime]::UtcNow -lt $deadline) { [Threading.Thread]::Sleep(2) }
                Assert-False -Condition ([IO.Directory]::Exists($roots[0])) -Message "Round $round first sweeper claims its first root."
                $second = Start-BoundedPwsh -Arguments @('-File', $sweeper, '-GoFile', $go)
                $children += $second
                $sweeperIds += $second.Process.Id
                foreach ($child in $children) {
                    $result = Complete-BoundedPwsh -Child $child -TimeoutMilliseconds 120000
                    Assert-Equal -Actual $result.ExitCode -Expected 0 -Message "Round $round staggered sweeper exits cleanly (stderr: $($result.StdErr.Trim()))"
                }
                Assert-Equal -Actual @($roots | Where-Object { [IO.Directory]::Exists($_) }).Count -Expected 0 -Message "Round $round leaves no dead root."
                Assert-Equal -Actual @(Get-ClaimNames -Directory $script:ProjectTmp -ProcessIds $sweeperIds).Count -Expected 0 -Message "Round $round leaves no claimed tree."
            }
            finally {
                foreach ($child in $children) { Stop-BoundedPwsh -Child $child }
                foreach ($root in $roots) { if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) } }
                foreach ($name in @(Get-ClaimNames -Directory $script:ProjectTmp -ProcessIds $sweeperIds)) { [IO.Directory]::Delete((Join-Path $script:ProjectTmp $name), $true) }
            }
        }
    }
    finally {
        foreach ($filler in $fillers) { if ([IO.Directory]::Exists($filler)) { [IO.Directory]::Delete($filler, $true) } }
    }
}

Write-Output 'PASS: scratch cleanup'
}
catch {
    Exit-HarnessFailure -ErrorRecord $_
}
finally {
    Complete-ScratchHarness
}
