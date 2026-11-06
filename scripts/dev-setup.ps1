<#
.SYNOPSIS
  Get LookyLooky onto this Windows PC (or bring it up to date), run it in
  Docker Desktop, and optionally run the browser tests against a throwaway
  copy.

.DESCRIPTION
  Safe to run again at any time. Steps:
    1. Checks git and Docker (starts Docker Desktop if it isn't running).
    2. Clones the repository, or fetches it, and checks out the newest work:
       an unmerged branch named by -Branch, or by default "auto" (main, unless
       the per-pane-speakers branch is still unmerged, in which case that).
    3. Copies your real camera files (cameras.xml, camera-layouts.xml) into
       config\ from -ConfigFrom, if they aren't there already.
    4. Writes docker-compose.override.yml (git-ignored) with this PC's LAN IP
       and time zone, if it doesn't exist yet.
    5. Adds the Windows Firewall rule for ports 8080/8443 (when run as admin).
    6. Builds and starts the real instance (docker compose up -d --build) and
       waits until it answers.
    7. Unless -SkipTests: starts a separate throwaway instance
       (docker-compose.dev.yml, ports 18080/18443, test pattern only), runs
       test\e2e.js and test\features.js against it in Playwright Chromium,
       then removes it. The tests add cameras and layouts, which is why they
       never run against the real instance.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1 -ConfigFrom "C:\Users\me\Downloads\lookylooky\config"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1 -SkipTests
#>
[CmdletBinding()]
param(
    [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
    [string]$RepoUrl = "https://github.com/skylarz1/LookyLooky.git",
    [string]$Branch = "auto",
    [string]$ConfigFrom = "",
    [string]$LanIp = "",
    [string]$TimeZone = "",
    [switch]$SkipTests,
    [switch]$SkipProduction,
    [switch]$KeepDevInstance
)

$ErrorActionPreference = "Stop"
# When run from a downloaded copy outside the repo, default to C:\LookyLooky.
if (-not (Test-Path (Join-Path $RepoDir "docker-compose.yml")) -and -not (Test-Path (Join-Path $RepoDir ".git"))) {
    if ($PSBoundParameters.ContainsKey("RepoDir") -eq $false) { $RepoDir = "C:\LookyLooky" }
}

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Ok($text)   { Write-Host "    OK $text" -ForegroundColor Green }

# Run a native command; throw if it fails. Its output is shown as it runs.
function Exec {
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$File $($Arguments -join ' ')' failed (exit $LASTEXITCODE)" }
}

# Run a native command and return its output (stderr discarded); $null on failure.
# Windows PowerShell 5.1 turns redirected stderr into terminating errors while
# $ErrorActionPreference is Stop, so relax it for the duration.
function Capture {
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $File @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return $out
    } catch { return $null } finally { $ErrorActionPreference = $saved }
}

# Exit code of a native command, nothing else.
function ExitCode {
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $File @Arguments 2>$null | Out-Null; return $LASTEXITCODE }
    catch { return 1 } finally { $ErrorActionPreference = $saved }
}

function Wait-Http($url, $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

# ---------------------------------------------------------------------------
Step "Checking tools"
foreach ($tool in @("git", "docker")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed (or not on PATH). Install it, open a new terminal, and run this again."
    }
}
Ok "git and docker found"

if (-not (Capture "docker" @("info"))) {
    Warn "Docker Desktop isn't running - starting it"
    $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dd) { Start-Process $dd } else { throw "Start Docker Desktop, wait for 'Engine running', then run this again." }
    $deadline = (Get-Date).AddSeconds(180)
    while (-not (Capture "docker" @("info"))) {
        if ((Get-Date) -gt $deadline) { throw "Docker Desktop did not start within 3 minutes." }
        Start-Sleep -Seconds 5
    }
}
Ok "Docker engine is running"

# ---------------------------------------------------------------------------
Step "Getting the newest code into $RepoDir"
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
    if ((Test-Path $RepoDir) -and (Get-ChildItem -Force $RepoDir | Select-Object -First 1)) {
        throw "$RepoDir exists and is not a git clone (an extracted zip?). Rename it, or pass -RepoDir with an empty folder. Copy your config\cameras.xml out of it first."
    }
    Exec "git" @("clone", $RepoUrl, $RepoDir)
}
Set-Location $RepoDir
Exec "git" @("fetch", "origin", "--prune")

$dirty = Capture "git" @("status", "--porcelain", "--untracked-files=no")
if ($dirty) {
    throw "There are uncommitted changes in $RepoDir. Commit or stash them (git stash) and run this again."
}

if ($Branch -eq "auto") {
    $Branch = "main"
    $hasPr = Capture "git" @("rev-parse", "--verify", "--quiet", "origin/per-pane-speakers")
    if ($hasPr) {
        if ((ExitCode "git" @("merge-base", "--is-ancestor", "origin/per-pane-speakers", "origin/main")) -ne 0) {
            $Branch = "per-pane-speakers"
            Warn "Pull request 'per-pane-speakers' is not merged yet - using that branch (it contains main plus the newest work)."
        }
    }
}
$local = Capture "git" @("rev-parse", "--verify", "--quiet", $Branch)
if ($local) { Exec "git" @("checkout", $Branch) } else { Exec "git" @("checkout", "-b", $Branch, "--track", "origin/$Branch") }
Exec "git" @("pull", "--ff-only", "origin", $Branch)
Ok ("On branch {0} at {1}" -f $Branch, (Capture "git" @("log", "-1", "--format=%h %s")))

# ---------------------------------------------------------------------------
Step "Camera configuration"
$cfg = Join-Path $RepoDir "config"
foreach ($name in @("cameras.xml", "camera-layouts.xml")) {
    $dest = Join-Path $cfg $name
    if (Test-Path $dest) { Ok "config\$name is present"; continue }
    if ($ConfigFrom -and (Test-Path (Join-Path $ConfigFrom $name))) {
        Copy-Item (Join-Path $ConfigFrom $name) $dest
        Ok "copied $name from $ConfigFrom"
    } else {
        Warn "config\$name is missing - the first boot will only have the Test Pattern camera. Pass -ConfigFrom <folder with your files>, or import later in Settings -> System."
    }
}

# ---------------------------------------------------------------------------
Step "Per-machine settings (docker-compose.override.yml)"
$override = Join-Path $RepoDir "docker-compose.override.yml"
if (Test-Path $override) {
    Ok "docker-compose.override.yml already exists - leaving it as it is:"
    Get-Content $override | ForEach-Object { Info $_ }
} else {
    if (-not $LanIp) {
        $conf = Get-NetIPConfiguration |
            Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq "Up" -and $_.InterfaceAlias -notmatch "vEthernet|WSL|Docker|VirtualBox|VMware" } |
            Select-Object -First 1
        if ($conf) { $LanIp = @($conf.IPv4Address)[0].IPAddress }
    }
    if (-not $LanIp) { throw "Couldn't work out this PC's LAN IP. Run again with -LanIp 192.168.x.y (see ipconfig)." }
    if (-not $TimeZone) {
        $TimeZone = "America/Chicago"
        try {
            $iana = $null
            if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId([System.TimeZoneInfo]::Local.Id, [ref]$iana)) { $TimeZone = $iana }
        } catch { Warn "Couldn't map the Windows time zone (needs PowerShell 7) - using $TimeZone. Pass -TimeZone to change it." }
    }
    $hostNames = "$LanIp,localhost,$($env:COMPUTERNAME.ToLower())"
    @(
        "# Per-machine settings, merged over docker-compose.yml. Git-ignored.",
        "services:",
        "  lookylooky:",
        "    environment:",
        "      LOOKY_HOSTNAMES: `"$hostNames`"",
        "      TZ: `"$TimeZone`"",
        "      # LOOKY_ADMIN_PASSWORD: `"change-me`""
    ) | Set-Content -Path $override -Encoding ASCII
    Ok "wrote docker-compose.override.yml (LAN IP $LanIp, time zone $TimeZone)"
    Warn "Give this PC a reserved IP on the router - the iPads' certificate is issued for $LanIp."
}

# ---------------------------------------------------------------------------
Step "Windows Firewall (ports 8080, 8443)"
if (Get-NetFirewallRule -DisplayName "LookyLooky" -ErrorAction SilentlyContinue) {
    Ok "rule 'LookyLooky' exists"
} else {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
        New-NetFirewallRule -DisplayName "LookyLooky" -Direction Inbound -Protocol TCP -LocalPort 8080,8443 -Action Allow -Profile Private | Out-Null
        Ok "added inbound rule for 8080/8443 (Private networks)"
    } else {
        Warn "Not running as administrator, so the firewall rule was not added. In an admin PowerShell run:"
        Info 'New-NetFirewallRule -DisplayName "LookyLooky" -Direction Inbound -Protocol TCP -LocalPort 8080,8443 -Action Allow -Profile Private'
    }
}

# ---------------------------------------------------------------------------
if (-not $SkipProduction) {
    Step "Building and starting LookyLooky (first build takes a few minutes)"
    $volume = Capture "docker" @("volume", "ls", "-q", "--filter", "name=lookylooky-data")
    if ($volume) { Info "Existing data volume found - config\ files are NOT re-imported (that only happens on first boot)." }
    Exec "docker" @("compose", "up", "-d", "--build")
    if (Wait-Http "http://localhost:8080/api/health" 120) {
        Ok "LookyLooky is up"
        $ip = $LanIp
        if (-not $ip) { $ip = "<this PC's IP>" }
        Info "This PC:     http://localhost:8080/"
        Info "Other devices: https://${ip}:8443/   (first: https://${ip}:8443/setup.html to install the certificate)"
    } else {
        Warn "It did not answer within 2 minutes. Last log lines:"
        & docker compose logs --tail 40
        throw "LookyLooky did not start."
    }
}

# ---------------------------------------------------------------------------
if (-not $SkipTests) {
    Step "Browser tests against a throwaway instance (ports 18080/18443)"
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Warn "Node.js isn't installed - skipping the tests. Install Node 20+ (https://nodejs.org) to run them."
    } else {
        Exec "npm" @("ci", "--no-audit", "--no-fund")
        Exec "npx" @("playwright", "install", "chromium")
        Exec "docker" @("compose", "-f", "docker-compose.dev.yml", "-p", "lookylooky-dev", "up", "-d", "--build")
        $failed = $false
        try {
            if (-not (Wait-Http "http://localhost:18080/api/health" 120)) { throw "The test instance did not start." }
            & node test/e2e.js https://localhost:18443
            if ($LASTEXITCODE -ne 0) { $failed = $true }
            & node test/features.js https://localhost:18443 http://localhost:18080
            if ($LASTEXITCODE -ne 0) { $failed = $true }
        } finally {
            if (-not $KeepDevInstance) {
                & docker compose -f docker-compose.dev.yml -p lookylooky-dev down -v
            }
        }
        if ($failed) { Warn "Some tests failed - see above (screenshots in test\out)." } else { Ok "all browser tests passed" }
    }
}

Step "Done"
