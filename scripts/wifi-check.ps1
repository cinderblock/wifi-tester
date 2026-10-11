# wifi-check.ps1 - read-only Wi-Fi and network diagnostic.
#
#   irm http://<this site>/ps1 | iex     (the server fills in its own address)
#
# What it does: reads this computer's Wi-Fi and network settings, runs a few
# reachability and speed tests, prints what looks wrong in plain language, and
# (after asking) sends a report to the network team.
#
# What it never does: change anything. No settings, adapters, DNS caches,
# profiles or files are touched. The only thing it may write is its own report,
# saved to your Downloads folder when it can't reach the server, so you can
# upload it later.
#
# Options (environment variables, since `irm | iex` can't take parameters):
#   $env:WIFI_CHECK_NO_UPLOAD = 1   never send; save the report to a file
#   $env:WIFI_CHECK_YES = 1         send without asking (for unattended use)
#
# Works on Windows PowerShell 5.1 and PowerShell 7+. Keep this file ASCII: 5.1
# decodes `irm` text without a charset as Latin-1.

& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BaseUrl = __WIFI_BASE_URL__
$FallbackUrls = @(__WIFI_FALLBACK_URLS__)
$KnownSsids = @(__WIFI_KNOWN_SSIDS__)
$ToolVersion = __WIFI_VERSION__
$NoUpload = [bool]$env:WIFI_CHECK_NO_UPLOAD
$AssumeYes = [bool]$env:WIFI_CHECK_YES

$UserAgent = "wifi-check/$ToolVersion (PowerShell $($PSVersionTable.PSVersion); Windows)"
$BaseHost = ([Uri]$BaseUrl).Host

# Process-local: lets 5.1 talk TLS 1.2 to https endpoints. Not a system change.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$checks = New-Object System.Collections.ArrayList
# Shared state the checks write to. A plain variable assigned inside a check
# would land in that check's own scope and vanish.
$state = @{ serverDate = $null }
$raw = [ordered]@{}
$RawLimit = 100000

# ---------------------------------------------------------------- output ----

function Write-Line([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Add-Check {
    param([string]$Id, [string]$Title, [string]$Status, [string]$Detail, [string]$Advice, $Data)
    $c = [ordered]@{ id = $Id; title = $Title; status = $Status }
    if ($Detail) { $c.detail = $Detail }
    if ($Advice) { $c.advice = $Advice }
    if ($null -ne $Data) { $c.data = $Data }
    [void]$checks.Add($c)
    $tag = @{ ok = '[ OK ]'; info = '[INFO]'; warn = '[WARN]'; fail = '[FAIL]'; error = '[ERR ]'; skip = '[SKIP]' }[$Status]
    $color = @{ ok = 'Green'; info = 'Cyan'; warn = 'Yellow'; fail = 'Red'; error = 'Magenta'; skip = 'DarkGray' }[$Status]
    Write-Host ("  $tag ") -ForegroundColor $color -NoNewline
    Write-Host $Title -NoNewline
    if ($Detail) { Write-Host (" - " + $Detail) -ForegroundColor Gray } else { Write-Host '' }
    if ($Advice -and $Status -ne 'ok') { Write-Host ("         -> " + $Advice) -ForegroundColor DarkGray }
}

# Run one check; an unexpected exception becomes an "error" check, visible in
# the output and the report, instead of stopping everything after it.
function Invoke-Check([string]$Id, [string]$Title, [scriptblock]$Body) {
    try { & $Body }
    catch { Add-Check $Id $Title 'error' ("check failed: " + $_.Exception.Message) }
}

function Save-Raw([string]$Name, [string]$Text) {
    if ($null -eq $Text) { $Text = '' }
    if ($Text.Length -gt $RawLimit) { $Text = $Text.Substring(0, $RawLimit) + "`n...[truncated]" }
    $raw[$Name] = $Text
}

function Invoke-Capture([string]$Name, [string]$Exe, [string[]]$Arguments) {
    try {
        $out = (& $Exe @Arguments 2>&1 | Out-String -Width 400)
    } catch {
        $out = "failed to run: " + $_.Exception.Message
    }
    Save-Raw $Name $out
    return $out
}

# ----------------------------------------------------------- measurement ----

# HTTP via HttpWebRequest: same on 5.1 and 7, with real timeouts, and with a
# time cap for speed tests so a slow link costs seconds, not minutes.
function Invoke-Http {
    param(
        [string]$Url, [string]$Method = 'GET', [byte[]]$Body, [string]$ContentType = 'application/json',
        [int]$TimeoutMs = 10000, [switch]$Direct, [switch]$Discard,
        [int]$MaxMs = 0, [long]$UploadBytes = 0
    )
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = $Method
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.UserAgent = $UserAgent
    $req.KeepAlive = $false
    if ($Direct) { $req.Proxy = $null }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $sent = 0
    if ($Body) {
        $req.ContentType = $ContentType
        $req.ContentLength = $Body.Length
        $s = $req.GetRequestStream(); $s.Write($Body, 0, $Body.Length); $s.Close()
        $sent = $Body.Length
    } elseif ($UploadBytes -gt 0) {
        $req.ContentType = 'application/octet-stream'
        $req.SendChunked = $true
        $req.AllowWriteStreamBuffering = $false
        $chunk = New-Object byte[] 65536
        (New-Object Random).NextBytes($chunk)
        $s = $req.GetRequestStream()
        while ($sent -lt $UploadBytes -and ($MaxMs -le 0 -or $sw.ElapsedMilliseconds -lt $MaxMs)) {
            $s.Write($chunk, 0, $chunk.Length); $sent += $chunk.Length
        }
        $s.Close()
    }
    $uploadMs = $sw.Elapsed.TotalMilliseconds
    try { $resp = $req.GetResponse() }
    catch [Net.WebException] { $resp = $_.Exception.Response; if ($null -eq $resp) { throw } }
    $firstByteMs = $sw.Elapsed.TotalMilliseconds
    $stream = $resp.GetResponseStream()
    $buf = New-Object byte[] 65536
    $total = 0
    $mem = New-Object IO.MemoryStream
    $capped = $false
    while ($true) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $total += $n
        if (-not $Discard) { $mem.Write($buf, 0, $n) }
        if ($MaxMs -gt 0 -and $sw.ElapsedMilliseconds -ge $MaxMs) { $capped = $true; break }
    }
    $elapsed = $sw.Elapsed.TotalMilliseconds
    if ($capped) { $req.Abort() } else { $stream.Close() }
    $text = $null
    if (-not $Discard) { $text = [Text.Encoding]::UTF8.GetString($mem.ToArray()) }
    $status = [int]$resp.StatusCode
    $date = $resp.Headers['Date']
    $resp.Close()
    return [pscustomobject]@{
        Status = $status; Bytes = $total; Sent = $sent; Ms = $elapsed; UploadMs = $uploadMs
        FirstByteMs = $firstByteMs; Date = $date; Text = $text
    }
}

function Get-Mbps([double]$Bytes, [double]$Ms) { if ($Ms -le 0) { return 0 } return [math]::Round($Bytes * 8 / $Ms / 1000, 1) }

# Download $Url over and over for about $MaxMs; Mbps over the whole time.
# Repeats rather than asking for one huge file, because some servers cap the
# size (Cloudflare refuses __down above ~100 MB with a 403).
function Measure-Download([string]$Url, [int]$MaxMs, [switch]$Direct) {
    $bytes = 0; $ms = 0; $n = 0
    while ($ms -lt $MaxMs -and $n -lt 50) {
        $r = Invoke-Http $Url -Direct:$Direct -Discard -MaxMs ($MaxMs - $ms) -TimeoutMs 10000
        if ($r.Status -ne 200) { throw "HTTP $($r.Status) from $Url" }
        $bytes += $r.Bytes; $ms += $r.Ms; $n++
    }
    return [ordered]@{ mbps = (Get-Mbps $bytes $ms); bytes = $bytes; ms = [int]$ms; requests = $n }
}

function Test-Pinger([string]$Target, [int]$Count = 10, [int]$TimeoutMs = 1000) {
    $p = New-Object Net.NetworkInformation.Ping
    $times = New-Object System.Collections.ArrayList
    $lost = 0
    $lastError = $null
    for ($i = 0; $i -lt $Count; $i++) {
        try {
            $r = $p.Send($Target, $TimeoutMs)
            if ($r.Status -eq 'Success') { [void]$times.Add([double]$r.RoundtripTime) } else { $lost++; $lastError = [string]$r.Status }
        } catch { $lost++; $lastError = $_.Exception.InnerException.Message; if (-not $lastError) { $lastError = $_.Exception.Message } }
        Start-Sleep -Milliseconds 100
    }
    $res = [ordered]@{ target = $Target; sent = $Count; received = $times.Count; lossPct = [math]::Round(100 * $lost / $Count) }
    if ($times.Count) {
        $m = $times | Measure-Object -Average -Minimum -Maximum
        $res.minMs = $m.Minimum; $res.avgMs = [math]::Round($m.Average, 1); $res.maxMs = $m.Maximum
    }
    if ($lastError) { $res.lastError = $lastError }
    return $res
}

# "Key : Value" blocks from netsh, split where each new "Name" starts.
function ConvertFrom-NetshBlocks([string]$Text) {
    $blocks = New-Object System.Collections.ArrayList
    $cur = $null
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s{0,8}([^:]+?)\s*:\s(.*)$') {
            $k = $Matches[1].Trim(); $v = $Matches[2].Trim()
            if ($k -eq 'Name' -or $null -eq $cur) { $cur = [ordered]@{}; [void]$blocks.Add($cur) }
            if (-not $cur.Contains($k)) { $cur[$k] = $v }
        }
    }
    return , $blocks
}

function Get-Num($s) {
    if ($null -eq $s) { return $null }
    $m = [regex]::Match([string]$s, '-?\d+(\.\d+)?')
    if ($m.Success) { return [double]::Parse($m.Value, [Globalization.CultureInfo]::InvariantCulture) }
    return $null
}

# ------------------------------------------------------------------- run ----

Write-Line ''
Write-Line '  Wi-Fi check' 'White'
Write-Line "  Reading this computer's network settings. Nothing will be changed." 'DarkGray'
Write-Line ''

# --- Host -------------------------------------------------------------------
$osName = $null
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $osName = "$($os.Caption) $($os.Version) (build $($os.BuildNumber))"
} catch { $osName = [Environment]::OSVersion.VersionString }
$hostInfo = [ordered]@{ hostname = $env:COMPUTERNAME; platform = 'windows'; os = $osName }

# --- Raw captures (for the network team) -----------------------------------
$wlanIf = Invoke-Capture 'netsh wlan show interfaces' 'netsh' @('wlan', 'show', 'interfaces')
$wlanDrv = Invoke-Capture 'netsh wlan show drivers' 'netsh' @('wlan', 'show', 'drivers')
$wlanNet = Invoke-Capture 'netsh wlan show networks mode=bssid' 'netsh' @('wlan', 'show', 'networks', 'mode=bssid')
[void](Invoke-Capture 'ipconfig /all' 'ipconfig' @('/all'))
[void](Invoke-Capture 'route print -4' 'route' @('print', '-4'))
$winhttp = Invoke-Capture 'netsh winhttp show proxy' 'netsh' @('winhttp', 'show', 'proxy')

# --- Adapters ---------------------------------------------------------------
$adapters = @()
$interfaces = New-Object System.Collections.ArrayList
try {
    $adapters = @(Get-NetAdapter)
    Save-Raw 'Get-NetAdapter' ($adapters | Format-Table -AutoSize Name, InterfaceDescription, Status, LinkSpeed, MacAddress, PermanentAddress, PhysicalMediaType, DriverVersion, DriverDate | Out-String -Width 400)
    foreach ($a in ($adapters | Where-Object { $_.Status -eq 'Up' })) {
        $idx = $a.ifIndex
        $ipv4 = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
        $ipv6 = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv6 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
        $gw = @(Get-NetRoute -InterfaceIndex $idx -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object { $_.NextHop })
        $dns = @(Get-DnsClientServerAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses })
        $ipIf = Get-NetIPInterface -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue
        [void]$interfaces.Add([ordered]@{
            name        = $a.Name
            description = $a.InterfaceDescription
            type        = [string]$a.PhysicalMediaType
            mac         = ($a.MacAddress -replace '-', ':').ToLower()
            ipv4        = $ipv4
            ipv6        = $ipv6
            gateway     = $gw
            dns         = $dns
            dhcp        = ($null -ne $ipIf -and [string]$ipIf.Dhcp -eq 'Enabled')
        })
    }
} catch {
    Add-Check 'net.adapters' 'Network adapters' 'error' ("couldn't list adapters: " + $_.Exception.Message)
}

# --- Wi-Fi state from netsh -------------------------------------------------
$wifi = $null
$wifiAdapter = $adapters | Where-Object { [string]$_.PhysicalMediaType -match '802\.11' } | Select-Object -First 1
$wlanBlocks = ConvertFrom-NetshBlocks $wlanIf
# One block per interface, each starting at "Name". (The preamble line
# "There is 1 interface on the system:" parses as a block of its own.)
$ifBlocks = @($wlanBlocks | Where-Object { $_.Contains('Name') })
$conn = $ifBlocks | Where-Object { $_['State'] -eq 'connected' } | Select-Object -First 1
if ($null -eq $conn -and $ifBlocks.Count) { $conn = $ifBlocks[0] }
# netsh output is localized. Plenty of "key : value" lines but none of the
# English keys means we can't read it; say so rather than misreport, and leave
# the raw text for the network team.
$wlanUnreadable = $ifBlocks.Count -eq 0 -and $wlanBlocks.Count -gt 0 -and $wlanBlocks[0].Count -gt 3
if ($conn) {
    $bssid = $conn['AP BSSID']; if (-not $bssid) { $bssid = $conn['BSSID'] }
    $wifi = [ordered]@{
        interface     = $conn['Name']
        state         = $conn['State']
        ssid          = $conn['SSID']
        bssid         = $bssid
        mac           = $conn['Physical address']
        band          = $conn['Band']
        channel       = Get-Num $conn['Channel']
        radioType     = $conn['Radio type']
        signalPercent = Get-Num $conn['Signal']
        rssi          = Get-Num $conn['Rssi']
        rxMbps        = Get-Num $conn['Receive rate (Mbps)']
        txMbps        = Get-Num $conn['Transmit rate (Mbps)']
        auth          = $conn['Authentication']
        driver        = $conn['Description']
    }
    # Older builds have no Rssi line; estimate from signal quality (q = 2 * (dBm + 100)).
    if ($null -eq $wifi.rssi -and $null -ne $wifi.signalPercent) { $wifi.rssi = [math]::Round($wifi.signalPercent / 2 - 100) }
}
$drv = (ConvertFrom-NetshBlocks $wlanDrv) | Select-Object -First 1
$radioTypes = if ($drv) { [string]$drv['Radio types supported'] } else { '' }
$supports5 = $radioTypes -match '802\.11(a|ac|ax|be)\b'

# region band-verdict -------------------------------------------------------
# Pure: no I/O, no script state. test/band.test.ts extracts this region and
# runs it on its own, against the same cases as the sh version.
# Bands as ranks: 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz.
function Get-BandRank([string]$b) {
    if ($b -match '^\s*2\.4') { return 1 }
    if ($b -match '^\s*5') { return 2 }
    if ($b -match '^\s*6') { return 3 }
    return $null
}
function Get-BandName([int]$r) { return @{ 1 = '2.4 GHz'; 2 = '5 GHz'; 3 = '6 GHz' }[$r] }
# $SsidBands: @{ ssid = @('2.4 GHz', '5 GHz', ...) } from the controller, or
# $null when unknown. Returns @{ status; detail; advice } or $null.
function Get-BandVerdict([string]$Current, [string[]]$DeviceBands, $SsidBands, [string]$Ssid, [string[]]$KnownSsids) {
    $cur = Get-BandRank $Current
    if (-not $cur) { return $null }
    $dev = @($DeviceBands | ForEach-Object { Get-BandRank $_ } | Where-Object { $_ })
    # Whatever it's on, it can do, whatever the driver listed.
    $devMax = (@($dev) + @($cur) | Measure-Object -Maximum).Maximum
    $net = $null
    if ($SsidBands -and $SsidBands.ContainsKey($Ssid)) { $net = @($SsidBands[$Ssid] | ForEach-Object { Get-BandRank $_ }) }
    # Best band both ends can do. Without the network's list, never claim
    # 6 GHz: plenty of networks (and some of ours) don't broadcast it.
    if ($net) { $best = (@($dev | Where-Object { $net -contains $_ }) + @($cur) | Measure-Object -Maximum).Maximum }
    else { $best = [math]::Max($cur, [math]::Min($devMax, 2)) }
    $other6 = $null
    if ($devMax -ge 3 -and $net -and -not ($net -contains 3)) {
        $other6 = $KnownSsids | Where-Object { $SsidBands.ContainsKey($_) -and (@($SsidBands[$_]) -contains '6 GHz') } | Select-Object -First 1
    }
    if ($cur -eq 1 -and $best -gt 1) {
        return @{ status = 'warn'; detail = "on 2.4 GHz, though this computer and this network both do $(Get-BandName $best)"; advice = '2.4 GHz is slower and very crowded here. Turning Wi-Fi off and on often moves it up; the network team can look at band steering.' }
    }
    if ($cur -eq 2 -and $best -eq 3) {
        return @{ status = 'info'; detail = 'on 5 GHz; this computer and this network also do 6 GHz, which is usually far less crowded'; advice = '6 GHz reaches less far than 5 GHz. Near an access point, turning Wi-Fi off and on may move it to 6 GHz.' }
    }
    if ($other6) {
        return @{ status = 'info'; detail = "this computer supports 6 GHz, but `"$Ssid`" isn't broadcast there; `"$other6`" is"; advice = "Joining `"$other6`" would let it use 6 GHz, which is usually far less crowded." }
    }
    if ($cur -eq 1 -and $devMax -le 1) {
        return @{ status = 'info'; detail = 'on 2.4 GHz, the only band this adapter supports'; advice = 'A newer USB Wi-Fi adapter with 5 or 6 GHz would be much faster.' }
    }
    return @{ status = 'ok'; detail = $Current; advice = $null }
}
# endregion band-verdict -----------------------------------------------------

# Windows 11 lists the adapter's bands under "Number of supported bands"
# ("2.4 GHz [ 0 MHz - 0 MHz]" ...). Older builds don't; fall back to the radio
# types, which can show 5 GHz but never 6.
$devBands = @([regex]::Matches($wlanDrv, '(?m)^\s+(2\.4|5|6) GHz \[') | ForEach-Object { "$($_.Groups[1].Value) GHz" } | Select-Object -Unique)
$devBandsKnown = $devBands.Count -gt 0
if (-not $devBandsKnown) { $devBands = @('2.4 GHz'); if ($supports5) { $devBands += '5 GHz' } }

# Which bands each SSID is on air in, from the network controller via this
# site ("<bands>\t<ssid>" per line). Unavailable just means we don't know.
$ssidBands = $null
$ssidBandsError = $null
try {
    $r = Invoke-Http "$BaseUrl/api/network/ssids.txt" -Direct -TimeoutMs 5000
    if ($r.Status -eq 200) {
        $ssidBands = @{}
        foreach ($line in ($r.Text -split "`n")) {
            $parts = $line.TrimEnd("`r").Split("`t", 2)
            if ($parts.Count -eq 2) { $ssidBands[$parts[1]] = @($parts[0].Split(',')) }
        }
    } else { $ssidBandsError = "HTTP $($r.Status): $($r.Text)" }
} catch { $ssidBandsError = $_.Exception.Message }

# Which adapter carries traffic: the one with the lowest-metric default route.
$primary = $null
try {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    if ($route) { $primary = $interfaces | Where-Object { $_.name -eq $route.InterfaceAlias } | Select-Object -First 1 }
} catch { }
if (-not $primary) { $primary = $interfaces | Where-Object { $_.gateway.Count } | Select-Object -First 1 }
$gateway = if ($primary -and $primary.gateway.Count) { $primary.gateway[0] } else { $null }

Write-Line '  This computer' 'White'

Invoke-Check 'wifi.connected' 'Wi-Fi connection' {
    if ($wlanIf -match 'wlansvc|AutoConfig Service') {
        Add-Check 'wifi.connected' 'Wi-Fi connection' 'info' 'the Windows Wi-Fi service is not running (wired-only computer?)'
    } elseif ($wlanUnreadable) {
        Add-Check 'wifi.connected' 'Wi-Fi connection' 'skip' 'could not read Wi-Fi details (Windows not in English?); the raw output is in the report'
    } elseif (-not $wifi) {
        Add-Check 'wifi.connected' 'Wi-Fi connection' 'info' 'no Wi-Fi adapter found'
    } elseif ($wifi.state -ne 'connected') {
        # Name the adapter that actually carries traffic, not just any wired one.
        $wired = if ($primary -and $primary.type -notmatch '802\.11') { $primary } else { $null }
        if ($wired) { Add-Check 'wifi.connected' 'Wi-Fi connection' 'info' "Wi-Fi is $($wifi.state); using $($wired.name)" }
        else { Add-Check 'wifi.connected' 'Wi-Fi connection' 'fail' "Wi-Fi is $($wifi.state)" 'Click the network icon in the taskbar and connect to the Wi-Fi network.' }
    } else {
        Add-Check 'wifi.connected' 'Wi-Fi connection' 'ok' "connected to `"$($wifi.ssid)`" via $($wifi.driver)"
    }
}

$onWifi = $wifi -and $wifi.state -eq 'connected'

if ($onWifi) {
    Invoke-Check 'wifi.ssid' 'Network name' {
        if ($KnownSsids.Count -eq 0) { return }
        if ($KnownSsids -contains $wifi.ssid) {
            Add-Check 'wifi.ssid' 'Network name' 'ok' $wifi.ssid
        } else {
            Add-Check 'wifi.ssid' 'Network name' 'warn' "`"$($wifi.ssid)`" is not one of this site's networks ($($KnownSsids -join ', '))" 'Connect to one of the networks listed; a phone hotspot or a neighbour''s network behaves differently.'
        }
    }

    Invoke-Check 'wifi.signal' 'Signal strength' {
        $r = $wifi.rssi
        $d = "$r dBm ($($wifi.signalPercent)%), $($wifi.band) channel $($wifi.channel)"
        if ($r -ge -65) { Add-Check 'wifi.signal' 'Signal strength' 'ok' $d }
        elseif ($r -ge -72) { Add-Check 'wifi.signal' 'Signal strength' 'info' "$d - fair" }
        elseif ($r -ge -80) { Add-Check 'wifi.signal' 'Signal strength' 'warn' "$d - weak" 'Move closer to an access point, or away from metal and walls between you and it.' }
        else { Add-Check 'wifi.signal' 'Signal strength' 'fail' "$d - very weak" 'The connection will be slow and drop out. Move closer to an access point.' }
    }

    Invoke-Check 'wifi.band' 'Wi-Fi band' {
        $v = Get-BandVerdict $wifi.band $devBands $ssidBands $wifi.ssid $KnownSsids
        if (-not $v) { return }
        $data = [ordered]@{ current = $wifi.band; deviceBands = @($devBands); deviceBandsFromDriver = $devBandsKnown }
        if ($ssidBands -and $ssidBands.ContainsKey($wifi.ssid)) { $data.networkBands = @($ssidBands[$wifi.ssid]) }
        if ($ssidBandsError) { $data.networkBandsError = $ssidBandsError }
        $detail = $v.detail
        if ($v.status -eq 'ok') { $detail = "$($wifi.band), $($wifi.radioType)" }
        Add-Check 'wifi.band' 'Wi-Fi band' $v.status $detail $v.advice $data
    }

    Invoke-Check 'wifi.rate' 'Wi-Fi link rate' {
        if ($null -eq $wifi.rxMbps) { return }
        $d = "$($wifi.rxMbps) Mbps down / $($wifi.txMbps) Mbps up (negotiated, not measured)"
        if ($wifi.rxMbps -lt 20) { Add-Check 'wifi.rate' 'Wi-Fi link rate' 'warn' $d 'A rate this low usually means weak signal or interference.' }
        else { Add-Check 'wifi.rate' 'Wi-Fi link rate' 'ok' $d }
    }

    Invoke-Check 'wifi.roam' 'Nearest access point' {
        if ($wlanNet -match 'location') {
            Add-Check 'wifi.roam' 'Nearest access point' 'skip' 'Windows needs Location turned on to list nearby access points' 'Optional: Settings > Privacy & security > Location, then run this again.'
            return
        }
        $aps = New-Object System.Collections.ArrayList
        $ssid = $null; $cur = $null
        foreach ($line in ($wlanNet -split "`r?`n")) {
            if ($line -match '^SSID \d+\s*:\s?(.*)$') { $ssid = $Matches[1].Trim(); $cur = $null }
            elseif ($line -match '^\s+BSSID \d+\s*:\s*(\S+)') { $cur = [ordered]@{ ssid = $ssid; bssid = $Matches[1].ToLower(); signal = $null; channel = $null; band = $null }; [void]$aps.Add($cur) }
            elseif ($cur -and $line -match '^\s+Signal\s*:\s*(\d+)%') { $cur.signal = [int]$Matches[1] }
            elseif ($cur -and $line -match '^\s+Channel\s*:\s*(\d+)') { $cur.channel = [int]$Matches[1] }
            elseif ($cur -and $line -match '^\s+Band\s*:\s*(.+)$') { $cur.band = $Matches[1].Trim() }
        }
        $same = @($aps | Where-Object { $_.ssid -eq $wifi.ssid } | Sort-Object { - $_.signal })
        $data = [ordered]@{ visibleNetworks = @($aps | ForEach-Object { $_.ssid } | Sort-Object -Unique).Count; sameSsid = $same }
        if ($same.Count -lt 2) { Add-Check 'wifi.roam' 'Nearest access point' 'ok' "$($same.Count) access point(s) for `"$($wifi.ssid)`" in range" $null $data; return }
        $best = $same[0]
        $mine = $same | Where-Object { $_.bssid -eq ([string]$wifi.bssid).ToLower() } | Select-Object -First 1
        if ($mine -and $best.signal - $mine.signal -ge 25) {
            Add-Check 'wifi.roam' 'Nearest access point' 'warn' "connected at $($mine.signal)% while another access point for this network is at $($best.signal)%" 'Turn Wi-Fi off and on to reconnect to the closer access point.' $data
        } else {
            Add-Check 'wifi.roam' 'Nearest access point' 'ok' "$($same.Count) access points for `"$($wifi.ssid)`" in range; on a strong one" $null $data
        }
    }

    Invoke-Check 'wifi.mac' 'Hardware address' {
        if (-not $wifiAdapter -or -not $wifi.mac) { return }
        $perm = ([string]$wifiAdapter.PermanentAddress -replace '[-:]', '').ToLower()
        $cur = ([string]$wifi.mac -replace '[-:]', '').ToLower()
        if ($perm -and $cur -and $perm -ne $cur) {
            Add-Check 'wifi.mac' 'Hardware address' 'info' "random hardware address in use for this network ($($wifi.mac))" 'Fine on its own; tell the network team if this computer needs a fixed address or reservation.'
        }
    }

    Invoke-Check 'wifi.driver' 'Wi-Fi driver' {
        if (-not $wifiAdapter -or -not $wifiAdapter.DriverDate) { return }
        $date = [datetime]$wifiAdapter.DriverDate
        $age = ((Get-Date) - $date).TotalDays / 365
        $d = "$($wifiAdapter.InterfaceDescription), driver $($wifiAdapter.DriverVersion) from $($date.ToString('yyyy-MM-dd'))"
        if ($age -gt 3) { Add-Check 'wifi.driver' 'Wi-Fi driver' 'info' "$d - over 3 years old" 'An updated driver from the PC or chip maker (Intel, Realtek, MediaTek) can fix drop-outs.' }
        else { Add-Check 'wifi.driver' 'Wi-Fi driver' 'ok' $d }
    }
}

Invoke-Check 'ip.address' 'IP address' {
    if (-not $primary) { Add-Check 'ip.address' 'IP address' 'fail' 'no network adapter has a default gateway' 'Not connected to any network. Check Wi-Fi or the cable.'; return }
    $v4 = @($primary.ipv4 | Where-Object { $_ -notmatch '^169\.254\.' })
    $apipa = @($primary.ipv4 | Where-Object { $_ -match '^169\.254\.' })
    if ($v4.Count) { Add-Check 'ip.address' 'IP address' 'ok' "$($v4 -join ', ') on $($primary.name)" }
    elseif ($apipa.Count) { Add-Check 'ip.address' 'IP address' 'fail' "$($apipa[0]) - the network never gave this computer an address" 'Turn Wi-Fi off and on, or forget the network and rejoin. If it keeps happening, report it: the network may be out of addresses.' }
    else { Add-Check 'ip.address' 'IP address' 'fail' "no IPv4 address on $($primary.name)" }
}

Invoke-Check 'net.vpn' 'VPN / tunnels' {
    $vpn = @($adapters | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'VPN|TAP-|Tunnel|WireGuard|Wintun|Tailscale|ZeroTier|AnyConnect|Fortinet|GlobalProtect|PANGP|Juniper|Pulse|OpenVPN|NordLynx|Zscaler' -or $_.Name -match 'VPN') })
    if ($vpn.Count) {
        $names = ($vpn | ForEach-Object { $_.InterfaceDescription }) -join '; '
        $carries = $primary -and ($vpn | Where-Object { $_.Name -eq $primary.name })
        $status = if ($carries) { 'warn' } else { 'info' }
        $what = if ($carries) { 'and it carries this computer''s internet traffic' } else { 'but it doesn''t carry the default route' }
        Add-Check 'net.vpn' 'VPN / tunnels' $status "active: $names, $what" 'A VPN can block local names (.tsl) and slow everything down. Try again with it disconnected.'
    } else {
        Add-Check 'net.vpn' 'VPN / tunnels' 'ok' 'none active'
    }
}

Invoke-Check 'net.proxy' 'Proxy' {
    $found = @()
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($ie -and $ie.ProxyEnable -eq 1) { $found += "manual proxy $($ie.ProxyServer)" }
    if ($ie -and $ie.AutoConfigURL) { $found += "auto-config $($ie.AutoConfigURL)" }
    if ($winhttp -notmatch 'Direct access') { $found += 'WinHTTP proxy set' }
    if ($found.Count) { Add-Check 'net.proxy' 'Proxy' 'warn' ($found -join '; ') 'A proxy is unusual here and can break local sites. Ask whoever set it up.' }
    else { Add-Check 'net.proxy' 'Proxy' 'ok' 'none' }
}

Invoke-Check 'net.hosts' 'Hosts file' {
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    # [string] strips the PSPath/PSProvider notes Get-Content attaches to each
    # line; ConvertTo-Json in 5.1 would otherwise walk the whole provider graph.
    $lines = @(Get-Content -LiteralPath $path -ErrorAction Stop | Where-Object { $_ -match '^\s*[^#\s]' } | ForEach-Object { [string]$_ })
    $names = @($BaseHost) + @($FallbackUrls | ForEach-Object { ([Uri]$_).Host })
    $ours = @($lines | Where-Object { $l = $_; @($names | Where-Object { $l -match ('(^|\s)' + [regex]::Escape($_) + '(\s|$)') }).Count })
    if ($ours.Count) { Add-Check 'net.hosts' 'Hosts file' 'warn' "overrides for this site's names: $($ours -join ' | ')" 'These lines override the network''s own names and are a common cause of "works for everyone but me".' @{ lines = $lines } }
    elseif ($lines.Count) { Add-Check 'net.hosts' 'Hosts file' 'info' "$($lines.Count) custom entries (none for this site)" $null @{ lines = $lines } }
}

Invoke-Check 'net.profile' 'Windows network type' {
    if (-not $primary) { return }
    $p = Get-NetConnectionProfile -InterfaceAlias $primary.name -ErrorAction Stop | Select-Object -First 1
    if ($p.NetworkCategory -eq 'Public') { Add-Check 'net.profile' 'Windows network type' 'info' "Windows treats `"$($p.Name)`" as a Public network" 'That hides this PC from others and can stop printers and shared folders being found. Only matters if those are what''s failing.' }
    else { Add-Check 'net.profile' 'Windows network type' 'ok' "$($p.NetworkCategory)" }
}

Write-Line ''
Write-Line '  Reaching the network' 'White'

Invoke-Check 'lan.gateway' 'Router (gateway) ping' {
    if (-not $gateway) { Add-Check 'lan.gateway' 'Router (gateway) ping' 'skip' 'no gateway'; return }
    $p = Test-Pinger $gateway 20 1000
    $d = "$gateway - $($p.lossPct)% lost, avg $($p.avgMs) ms, worst $($p.maxMs) ms"
    if ($p.received -eq 0) { Add-Check 'lan.gateway' 'Router (gateway) ping' 'fail' "$gateway - no replies" 'The Wi-Fi link itself isn''t passing traffic. Turn Wi-Fi off and on.' $p }
    elseif ($p.lossPct -ge 20) { Add-Check 'lan.gateway' 'Router (gateway) ping' 'fail' $d 'Heavy loss right next to you means a bad Wi-Fi link: weak signal or interference.' $p }
    elseif ($p.lossPct -gt 0 -or $p.avgMs -gt 30) { Add-Check 'lan.gateway' 'Router (gateway) ping' 'warn' $d 'Some loss or delay on the local link; usually crowding or weak signal.' $p }
    else { Add-Check 'lan.gateway' 'Router (gateway) ping' 'ok' $d $null $p }
}

Invoke-Check 'dns.servers' 'DNS servers' {
    if (-not $primary) { return }
    $dns = @($primary.dns)
    $private = @($dns | Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' })
    if ($dns.Count -eq 0) { Add-Check 'dns.servers' 'DNS servers' 'fail' 'none configured' }
    elseif ($private.Count -eq 0) { Add-Check 'dns.servers' 'DNS servers' 'warn' "$($dns -join ', ') - set by hand or by a VPN, not by this network" "Names like $BaseHost only resolve through the network's own DNS. Set DNS back to automatic." }
    else { Add-Check 'dns.servers' 'DNS servers' 'ok' ($dns -join ', ') }
}

Invoke-Check 'dns.local' "Local name ($BaseHost)" {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $addrs = @([Net.Dns]::GetHostAddresses($BaseHost) | ForEach-Object { $_.IPAddressToString })
        Add-Check 'dns.local' "Local name ($BaseHost)" 'ok' "$($addrs -join ', ') in $([int]$sw.ElapsedMilliseconds) ms"
    } catch {
        $viaGw = $null
        if ($gateway) { try { $viaGw = @(Resolve-DnsName -Name $BaseHost -Server $gateway -DnsOnly -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress }) } catch { } }
        if ($viaGw) { Add-Check 'dns.local' "Local name ($BaseHost)" 'fail' "this computer can't resolve it, but the router can ($($viaGw -join ', '))" 'This computer is using the wrong DNS server (a VPN or a manual setting). Set DNS to automatic.' }
        else { Add-Check 'dns.local' "Local name ($BaseHost)" 'fail' "can't resolve: $($_.Exception.InnerException.Message)" }
    }
}

Invoke-Check 'dns.public' 'Internet name (www.cloudflare.com)' {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $addrs = @([Net.Dns]::GetHostAddresses('www.cloudflare.com') | ForEach-Object { $_.IPAddressToString })
    $ms = [int]$sw.ElapsedMilliseconds
    $status = if ($ms -gt 500) { 'warn' } else { 'ok' }
    Add-Check 'dns.public' 'Internet name (www.cloudflare.com)' $status "$($addrs.Count) addresses in $ms ms"
}

Invoke-Check 'lan.http' "This site ($BaseUrl)" {
    $r = Invoke-Http "$BaseUrl/api/health" -Direct -TimeoutMs 8000
    $state.serverDate = $r.Date
    if ($r.Status -eq 200) { Add-Check 'lan.http' "This site ($BaseUrl)" 'ok' "answered in $([int]$r.Ms) ms" }
    else { Add-Check 'lan.http' "This site ($BaseUrl)" 'fail' "HTTP $($r.Status)" }
}

Invoke-Check 'lan.speed' 'Speed to this site (your Wi-Fi)' {
    $down = Measure-Download "$BaseUrl/api/download?bytes=209715200" 6000 -Direct
    $up = Invoke-Http "$BaseUrl/api/upload" -Method POST -Direct -UploadBytes 104857600 -MaxMs 5000 -TimeoutMs 15000
    if ($up.Status -ne 200) { throw "upload: HTTP $($up.Status)" }
    $dm = $down.mbps
    $um = Get-Mbps $up.Sent $up.UploadMs
    $data = [ordered]@{ downMbps = $dm; upMbps = $um; downBytes = $down.bytes; upBytes = $up.Sent }
    $d = "$dm Mbps down, $um Mbps up"
    if ($dm -lt 5) { Add-Check 'lan.speed' 'Speed to this site (your Wi-Fi)' 'fail' $d 'Very slow on the local network itself, so the Wi-Fi link is the problem, not the internet.' $data }
    elseif ($dm -lt 25) { Add-Check 'lan.speed' 'Speed to this site (your Wi-Fi)' 'warn' $d 'Slower than this network should manage; weak signal, 2.4 GHz, or a crowded channel.' $data }
    else { Add-Check 'lan.speed' 'Speed to this site (your Wi-Fi)' 'ok' $d $null $data }
}

Invoke-Check 'inet.ping' 'Internet ping (1.1.1.1)' {
    $p = Test-Pinger '1.1.1.1' 10 2000
    $d = "$($p.lossPct)% lost, avg $($p.avgMs) ms, worst $($p.maxMs) ms"
    if ($p.received -eq 0) { Add-Check 'inet.ping' 'Internet ping (1.1.1.1)' 'fail' 'no replies' $null $p }
    elseif ($p.lossPct -ge 10 -or $p.avgMs -gt 100) { Add-Check 'inet.ping' 'Internet ping (1.1.1.1)' 'warn' $d $null $p }
    else { Add-Check 'inet.ping' 'Internet ping (1.1.1.1)' 'ok' $d $null $p }
}

Invoke-Check 'inet.http' 'Internet (https)' {
    $r = Invoke-Http 'https://www.cloudflare.com/cdn-cgi/trace' -TimeoutMs 10000
    if ($r.Status -ne 200) { Add-Check 'inet.http' 'Internet (https)' 'fail' "HTTP $($r.Status) from Cloudflare"; return }
    $kv = @{}
    foreach ($l in ($r.Text -split "`n")) { if ($l -match '^(\w+)=(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim() } }
    Add-Check 'inet.http' 'Internet (https)' 'ok' "reached Cloudflare ($($kv['colo'])) in $([int]$r.Ms) ms as $($kv['ip'])" $null @{ ip = $kv['ip']; colo = $kv['colo']; ms = [int]$r.Ms }
}

Invoke-Check 'inet.speed' 'Internet download speed' {
    try { $r = Measure-Download 'https://speed.cloudflare.com/__down?bytes=25000000' 6000 }
    catch {
        # Everyone here shares one public address, so Cloudflare's per-address
        # limit is shared too. That's not a fault on this computer.
        if ("$_" -match 'HTTP 429') { Add-Check 'inet.speed' 'Internet download speed' 'skip' 'Cloudflare''s speed test is rate-limiting this network right now (HTTP 429)'; return }
        throw
    }
    $status = if ($r.mbps -lt 10) { 'warn' } else { 'ok' }
    Add-Check 'inet.speed' 'Internet download speed' $status "$($r.mbps) Mbps" $null $r
}

Invoke-Check 'clock' 'Clock' {
    if (-not $state.serverDate) { return }
    $skew = ((Get-Date).ToUniversalTime() - ([datetime]::Parse($state.serverDate)).ToUniversalTime()).TotalSeconds
    if ([math]::Abs($skew) -gt 120) { Add-Check 'clock' 'Clock' 'warn' "this computer's clock is off by $([int]$skew) seconds" 'A wrong clock breaks secure websites. Settings > Time & language > Sync now.' }
    else { Add-Check 'clock' 'Clock' 'ok' 'in sync' }
}

# ---------------------------------------------------------------- summary ---

$bad = @($checks | Where-Object { $_.status -eq 'fail' -or $_.status -eq 'error' })
$warn = @($checks | Where-Object { $_.status -eq 'warn' })
Write-Line ''
if ($bad.Count) { Write-Line "  Found $($bad.Count) problem(s) and $($warn.Count) warning(s)." 'Red' }
elseif ($warn.Count) { Write-Line "  No hard failures; $($warn.Count) thing(s) worth a look." 'Yellow' }
else { Write-Line '  Everything checked looks healthy.' 'Green' }
Write-Line ''

$report = [ordered]@{
    schema      = 1
    kind        = 'diagnostic'
    tool        = [ordered]@{ name = 'wifi-check.ps1'; version = $ToolVersion }
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    host        = $hostInfo
    wifi        = $wifi
    interfaces  = @($interfaces)
    checks      = @($checks)
    raw         = $raw
}

$description = $null
$send = -not $NoUpload
if ($send -and -not $AssumeYes) {
    try {
        Write-Line '  The report contains this computer''s name, network settings and the results above.' 'DarkGray'
        Write-Line '  No files, passwords or browsing history.' 'DarkGray'
        $description = Read-Host '  What''s going wrong? (a few words, or just press Enter)'
        $answer = Read-Host "  Send this report to the network team at $BaseHost? [Y/n]"
        if ($answer -match '^\s*n') { $send = $false }
    } catch {
        # No console to ask on (e.g. -NonInteractive). Don't send without consent.
        $send = $false
    }
}
if ($description) { $report.description = $description }

$json = $report | ConvertTo-Json -Depth 12 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)

function Save-Report {
    $dir = Join-Path $env:USERPROFILE 'Downloads'
    if (-not (Test-Path -LiteralPath $dir)) { $dir = $env:TEMP }
    $file = Join-Path $dir ("wifi-check-{0}-{1}.json" -f $env:COMPUTERNAME, (Get-Date).ToString('yyyyMMdd-HHmmss'))
    [IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
    return $file
}

if ($send) {
    $sent = $null
    $errors = @()
    foreach ($u in (@($BaseUrl) + $FallbackUrls)) {
        try {
            $r = Invoke-Http "$u/api/reports" -Method POST -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutMs 60000 -Direct
            if ($r.Status -eq 201) { $sent = $r.Text | ConvertFrom-Json; break }
            $errors += "$u -> HTTP $($r.Status): $($r.Text)"
        } catch { $errors += "$u -> $($_.Exception.Message)" }
    }
    if ($sent) {
        Write-Line ''
        Write-Line "  Sent. Your report code is $($sent.code) - give this to whoever is helping you." 'Green'
        Write-Line "  View it at $($sent.url)" 'Gray'
    } else {
        $file = Save-Report
        Write-Line ''
        Write-Line "  Couldn't reach the server to send the report:" 'Yellow'
        foreach ($e in $errors) { Write-Line "    $e" 'DarkGray' }
        Write-Line "  Saved it to $file" 'Yellow'
        Write-Line "  When you're back online, upload it at $BaseUrl (Upload a saved report)." 'Yellow'
    }
} else {
    $file = Save-Report
    Write-Line "  Not sent. Saved the report to $file" 'Yellow'
}
Write-Line ''
}
