<#
    Pull the agent's saved state off the server onto this PC.

    .\tools\backup-from-server.ps1            # normal run
    .\tools\backup-from-server.ps1 -List      # just show what is already kept

    Why pull rather than push. The server could push a backup somewhere, but
    then it has to hold a credential for wherever that is, and a machine that
    runs unattended on the public internet is the worst place to keep one. This
    PC already has the ssh key, so pulling adds no secret anywhere: the server
    stays able only to answer, never to reach out.

    What is NOT here: .secrets/. The identity keys are irreplaceable — a did:key
    cannot be rotated without abandoning every bit of reputation bound to it —
    and the operator keeps his own copy of those, deliberately outside any
    automation. Leaving them out of this file means a stolen backup costs
    history, not the agent itself.

    What is worth the trouble: data/local/tclk-payers.json above all. /r/tclk-offers
    is a ring roughly six hours deep, so that file is not a snapshot anybody can
    re-take — it was accumulated window by window over days, and losing it costs
    days, not minutes.
#>
param(
    [string]$ServerIp  = '204.168.174.111',
    [string]$KeyPath   = "$env:USERPROFILE\.ssh\id_ed25519",
    [string]$BackupDir = "$env:USERPROFILE\TriAgent-backups",
    [int]$Keep         = 14,
    [switch]$List
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }

if ($List) {
    Get-ChildItem $BackupDir -Filter 'busena-*.tar.gz' | Sort-Object Name -Descending |
        ForEach-Object { '{0}  {1,8:N1} MB' -f $_.Name, ($_.Length / 1MB) }
    return
}

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$out   = Join-Path $BackupDir "busena-$stamp.tar.gz"

# Packed on the server and fetched with scp, rather than streamed into a local
# redirect. `& ssh ... > $out` looks like the tidier one-liner and silently
# ruins the file: PowerShell treats a native command's stdout as text and
# re-encodes it, so the gzip arrives the right size and unreadable. Cost an
# archive on 2026-09-04 before the verify step below caught it.
#
# The excludes keep the rebuildable bulk out: chats/ is a learning corpus the
# agent regenerates, and the console log already lives in journald.
# `;` after tar, not `&&`, and the warning silenced on purpose. This packs a
# directory the agent is actively writing to, so GNU tar regularly notices a
# file changed under it, prints "file changed as we read it" and exits 1. That
# is a warning about one file, not a failed archive — but chained with `&&` it
# stopped `stat` from ever running, and the size check then compared 22 MB
# against nothing. Consistency is not worth stopping the daemon for: these are
# small JSON files, and a backup missing one mid-write still holds the payer
# history that took days to build.
$remote = 'cd /root/TriAgent && tar czf /tmp/busena.tar.gz ' +
          '--warning=no-file-changed ' +
          '--exclude=data/local/chats ' +
          '--exclude=data/local/archive ' +
          '--exclude=data/local/daemon-console.log ' +
          'data/local 2>/dev/null; ' +
          'stat -c %s /tmp/busena.tar.gz; tar -tzf /tmp/busena.tar.gz 2>/dev/null | wc -l'

Write-Host "Imu busena is $ServerIp ..."
# The server reports both numbers, because it is the side with a dependable
# tar. Counting `tar -tzf` output here first returned 0 for an archive that
# opened perfectly by hand — native-command output through Measure-Object is
# not something to hang a backup's verdict on.
$report = @(& ssh -o ConnectTimeout=20 -o BatchMode=yes -i $KeyPath "root@$ServerIp" $remote) |
          Where-Object { $_ -match '^\s*\d+\s*$' }
if ($report.Count -lt 2) { throw "Serveris negrazino dydzio ir kiekio - gavau: $($report -join '|')" }
$remoteSize  = [int64]$report[0].Trim()
$remoteCount = [int]$report[1].Trim()
if ($remoteSize -lt 10240) { throw "Serveryje supakuotas archyvas per mazas: $remoteSize B." }

& scp -q -o ConnectTimeout=20 -o BatchMode=yes -i $KeyPath "root@${ServerIp}:/tmp/busena.tar.gz" $out
& ssh -o ConnectTimeout=20 -o BatchMode=yes -i $KeyPath "root@$ServerIp" 'rm -f /tmp/busena.tar.gz'

if (-not (Test-Path $out)) { throw "Kopija neatkeliavo - scp nieko neirase." }

# Byte-for-byte against what the server packed. This is the check that actually
# proves the transfer, and it is why the earlier streaming version was caught:
# a re-encoded gzip arrives the wrong length.
$localSize = (Get-Item $out).Length
if ($localSize -ne $remoteSize) {
    Remove-Item -LiteralPath $out -Force
    throw "Perdavimas nepilnas: serveryje $remoteSize B, atkeliavo $localSize B."
}

# Proof this PC can open what it just stored, not merely that a file appeared.
# A backup nobody has ever unpacked is a guess about the future rather than a
# fact about it.
#
# Done in .NET rather than by shelling out to tar, after two different failures
# doing the latter. `tar` on this machine is whichever one PATH happens to
# offer: run from a Bash-launched shell it is Git's GNU tar, which reads
# `C:\Users\...` as a remote host and fails with "resolve failed"; run from a
# plain PowerShell it is Windows bsdtar and works. A check whose answer depends
# on how the script was started is not a check. This decompresses the first
# block and looks for the `ustar` magic every tar header carries at offset 257.
try {
    $fs = [System.IO.File]::OpenRead($out)
    $gz = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
    $buf = New-Object byte[] 512
    $read = $gz.Read($buf, 0, 512)
    $magic = [System.Text.Encoding]::ASCII.GetString($buf, 257, 5)
} catch {
    $magic = "(nuskaityti nepavyko: $($_.Exception.Message))"
} finally {
    if ($gz) { $gz.Dispose() }
    if ($fs) { $fs.Dispose() }
}
if ($read -ne 512 -or $magic -ne 'ustar') {
    Remove-Item -LiteralPath $out -Force
    throw "Kopija atsisiunte, bet neatsidaro (antraste: '$magic') - istrinta, kad neapgautu."
}

$mb = [math]::Round($localSize / 1MB, 1)
Write-Host "OK: $out  ($mb MB, $remoteCount irasai)"

# Keep a fortnight. Old copies matter for the case where a fault is noticed
# late — yesterday's backup of an already-broken state helps nobody.
$old = Get-ChildItem $BackupDir -Filter 'busena-*.tar.gz' | Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName -Force; Write-Host "istrinta sena: $($f.Name)" }
