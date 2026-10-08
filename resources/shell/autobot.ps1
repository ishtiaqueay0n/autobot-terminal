# Autobot Terminal shell integration for PowerShell 5.1 and 7 (loaded as a script block by a short -Command).
# The GUI owns the input line; this hook only reports state back to it via OSC 7777 markers:
#   ESC]7777;A;<exit>;<cwd>BEL   prompt ready
#   ESC]7777;P;<Key>=<Value>BEL  session property

# The GUI is the line editor, so PSReadLine is not needed (and 2.0 breaks on multi-line input via ConPTY).
Remove-Module PSReadLine -ErrorAction SilentlyContinue

function global:prompt {
    $ok = $?
    $code = 0
    if (-not $ok) {
        $code = 1
        if ($global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0) {
            $code = $global:LASTEXITCODE
        }
    }
    # If output did not end with a newline, mark it with a dim % and start a fresh line.
    if ([Console]::CursorLeft -ne 0) {
        [Console]::Write("$([char]27)[2;7m%$([char]27)[0m`n")
    }
    $cwd = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
    "$([char]27)]7777;A;$code;$cwd$([char]7)"
}

# Aliases and functions from the user's profile, for completion (Autobot reads and deletes the file).
try {
    $__ab = Join-Path ([IO.Path]::GetTempPath()) "autobot-$PID.commands"
    @(Get-Alias | ForEach-Object Name) + @(Get-ChildItem function: | ForEach-Object Name) |
        Set-Content -LiteralPath $__ab -Encoding UTF8
    [Console]::Write("$([char]27)]7777;P;Commands=$__ab$([char]7)")
} catch {}
Remove-Variable __ab -ErrorAction SilentlyContinue

[Console]::Write("$([char]27)]7777;P;Home=$HOME$([char]7)")
[Console]::Write("$([char]27)]7777;P;Shell=PowerShell $($PSVersionTable.PSVersion)$([char]7)")

# Suggestions inside ssh sessions: the same wrapper as resources/shell/ssh.sh, which explains the approach.
# AUTOBOT_SSH is ask, on or off; AUTOBOT_SSH_CMDFILE holds the command that starts a hooked shell remotely.
function global:__autobot_ssh_login([string[]]$list) {
    $target = $null
    $i = 0
    while ($i -lt $list.Count) {
        $a = $list[$i]
        $i++
        if ($a -eq '--') { return ($null -eq $target -and $i -eq $list.Count - 1) }
        if ($a.Length -gt 1 -and $a.StartsWith('-')) {
            $rest = $a.Substring(1)
            while ($rest.Length -gt 0) {
                $c = $rest[0]
                $rest = $rest.Substring(1)
                if ('NfnTsVGOQW'.IndexOf($c) -ge 0) { return $false }
                if ('BbcDEeFIiJLlmoPpRSw'.IndexOf($c) -ge 0) {
                    if ($rest.Length -eq 0) {
                        if ($i -ge $list.Count) { return $false }
                        $i++
                    }
                    $rest = ''
                }
            }
        } else {
            if ($target) { return $false }
            $target = $a
        }
    }
    return [bool]$target
}

function global:ssh {
    $exe = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { throw "ssh : The term 'ssh' is not recognized as the name of a cmdlet, function, script file, or operable program." }
    $mode = if ($env:AUTOBOT_SSH) { $env:AUTOBOT_SSH } else { 'ask' }
    $plain = $mode -eq 'off' -or -not $env:AUTOBOT_SSH_CMDFILE -or -not (Test-Path -LiteralPath $env:AUTOBOT_SSH_CMDFILE) `
        -or $MyInvocation.PipelineLength -gt 1 -or [Console]::IsInputRedirected `
        -or -not (__autobot_ssh_login ([string[]]$args))
    if (-not $plain) {
        $config = & $exe.Source -G @args 2>$null
        # Also left alone: the git account and git hosting services, which refuse a command and only greet you.
        if ($config -match '^(remotecommand |sessiontype (none|subsystem)|requesttty no$|user git$|hostname (.+\.)?(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com)$)') { $plain = $true }
    }
    if (-not $plain -and $mode -eq 'ask') {
        [Console]::Error.WriteLine('Autobot can suggest commands inside this ssh session. It sends a small helper along with the login,')
        [Console]::Error.WriteLine('which lives only as long as the session; nothing is installed on the other machine.')
        $answer = Read-Host '  [y] yes   [n] not this time   [a] always   [v] never'
        $esc = [char]27
        if ($answer -match '^[vV]') {
            $env:AUTOBOT_SSH = 'off'
            [Console]::Write("$esc]7777;P;SshChoice=off:$($env:AUTOBOT_SSH_TOKEN)$([char]7)")
            $plain = $true
        } elseif ($answer -match '^[aA]') {
            $env:AUTOBOT_SSH = 'on'
            [Console]::Write("$esc]7777;P;SshChoice=on:$($env:AUTOBOT_SSH_TOKEN)$([char]7)")
        } elseif ($answer -notmatch '^[yY]') {
            $plain = $true
        }
    }
    if ($plain) {
        & $exe.Source @args
    } else {
        $remote = (Get-Content -LiteralPath $env:AUTOBOT_SSH_CMDFILE -Raw).Trim()
        & $exe.Source -t -o "RemoteCommand=$remote" @args
    }
}
