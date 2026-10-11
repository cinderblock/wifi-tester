#!/bin/sh
# wifi-check.sh - read-only Wi-Fi and network diagnostic for macOS and Linux.
#
#   curl -fsSL http://<this site>/sh | sh     (the server fills in its own address)
#
# What it does: reads this computer's Wi-Fi and network settings, runs a few
# reachability and speed tests, prints what looks wrong in plain language, and
# (after asking) sends a report to the network team.
#
# What it never does: change anything. No sudo, no settings, no interfaces, no
# caches. The only file it may leave behind is its own report, saved to
# ~/Downloads when it can't reach the server, so you can upload it later.
#
# Options (environment variables):
#   WIFI_CHECK_NO_UPLOAD=1   never send; save the report to a file
#   WIFI_CHECK_YES=1         send without asking (for unattended use)
#
# Plain POSIX sh: runs under dash, bash, and macOS /bin/sh. Needs curl.

BASE_URL=__WIFI_BASE_URL__
FALLBACK_URLS=__WIFI_FALLBACK_URLS__
KNOWN_SSIDS=__WIFI_KNOWN_SSIDS__
TOOL_VERSION=__WIFI_VERSION__

# Everything is inside main, called on the last line, so a download cut off
# halfway through `curl | sh` runs nothing at all.
main() {
	set -u
	LC_ALL=C
	export LC_ALL
	TMP=$(mktemp -d 2>/dev/null || mktemp -d -t wifi-check)
	trap 'rm -rf "$TMP"' EXIT INT TERM
	: >"$TMP/checks"
	: >"$TMP/raw"
	BASE_HOST=$(printf '%s' "$BASE_URL" | sed -e 's#^[a-z]*://##' -e 's#[:/].*$##')
	UA="wifi-check/$TOOL_VERSION (sh; $(uname -s))"

	if [ -t 1 ]; then
		C_OK=$(printf '\033[32m') C_INFO=$(printf '\033[36m') C_WARN=$(printf '\033[33m')
		C_FAIL=$(printf '\033[31m') C_DIM=$(printf '\033[90m') C_B=$(printf '\033[1m') C_0=$(printf '\033[0m')
	else
		C_OK='' C_INFO='' C_WARN='' C_FAIL='' C_DIM='' C_B='' C_0=''
	fi

	if ! command -v curl >/dev/null 2>&1; then
		echo "wifi-check needs curl, which isn't installed." >&2
		exit 1
	fi

	case "$(uname -s)" in
	Darwin) PLATFORM=macos ;;
	Linux) PLATFORM=linux ;;
	*) PLATFORM=other ;;
	esac

	say ""
	say "  ${C_B}Wi-Fi check${C_0}"
	say "  ${C_DIM}Reading this computer's network settings. Nothing will be changed.${C_0}"
	say ""

	# Pings take ~10 s each; start them now and collect the results later.
	gather_basics
	if [ -n "$GATEWAY" ]; then ping_bg "$GATEWAY" 20 "$TMP/ping-gw" & fi
	ping_bg 1.1.1.1 10 "$TMP/ping-inet" &

	say "  ${C_B}This computer${C_0}"
	check_wifi
	check_ip
	check_vpn
	check_proxy
	check_hosts

	say ""
	say "  ${C_B}Reaching the network${C_0}"
	wait
	check_ping_gateway
	check_dns_servers
	check_dns_local
	check_dns_public
	check_lan_http
	check_lan_speed
	check_ping_inet
	check_inet_http
	check_inet_speed
	check_clock

	summarize
	build_report
	deliver
}

# ---------------------------------------------------------------- output ----

say() { printf '%s\n' "$*"; }

# JSON string literal for arbitrary text: escapes \ " tab, drops other control
# characters, joins lines with \n.
json_str() {
	printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | awk '
		BEGIN { ORS = ""; printf "\"" }
		{ gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "")
		  if (NR > 1) printf "\\n"; printf "%s", $0 }
		END { printf "\"" }'
}

# Number or null, for JSON.
json_num() {
	case "$1" in
	'' | *[!0-9.-]* | -) printf 'null' ;;
	*) printf '%s' "$1" ;;
	esac
}

# add_check ID TITLE STATUS DETAIL [ADVICE] [DATA_JSON]
add_check() {
	_id=$1 _title=$2 _status=$3 _detail=${4:-} _advice=${5:-} _data=${6:-}
	case $_status in
	ok) _tag="[ OK ]" _c=$C_OK ;;
	info) _tag="[INFO]" _c=$C_INFO ;;
	warn) _tag="[WARN]" _c=$C_WARN ;;
	fail) _tag="[FAIL]" _c=$C_FAIL ;;
	error) _tag="[ERR ]" _c=$C_FAIL ;;
	*) _tag="[SKIP]" _c=$C_DIM ;;
	esac
	if [ -n "$_detail" ]; then
		say "  ${_c}${_tag}${C_0} ${_title} - ${_detail}"
	else
		say "  ${_c}${_tag}${C_0} ${_title}"
	fi
	if [ -n "$_advice" ] && [ "$_status" != ok ]; then say "         ${C_DIM}-> ${_advice}${C_0}"; fi
	{
		printf '{"id":%s,"title":%s,"status":"%s"' "$(json_str "$_id")" "$(json_str "$_title")" "$_status"
		[ -n "$_detail" ] && printf ',"detail":%s' "$(json_str "$_detail")"
		[ -n "$_advice" ] && printf ',"advice":%s' "$(json_str "$_advice")"
		[ -n "$_data" ] && printf ',"data":%s' "$_data"
		printf '}\n'
	} >>"$TMP/checks"
}

# capture NAME CMD...: run a command, keep its output for the report, print it.
capture() {
	_name=$1
	shift
	_out=$("$@" 2>&1 | head -c 100000) || true
	printf '%s' "$(json_str "$_name"):$(json_str "$_out")" >>"$TMP/raw"
	printf ',' >>"$TMP/raw"
	printf '%s' "$_out"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ----------------------------------------------------------- measurement ----

# ping_bg HOST COUNT OUTFILE -> "sent recv loss_pct min avg max" (blank fields if none)
ping_bg() {
	if [ "$PLATFORM" = linux ]; then
		_o=$(ping -n -c "$2" -i 0.2 -W 1 "$1" 2>&1)
	else
		_o=$(ping -n -c "$2" -i 0.2 -t $(($2 + 3)) "$1" 2>&1 || ping -n -c "$2" "$1" 2>&1)
	fi
	printf '%s\n' "$_o" | awk '
		# macOS: "20 packets transmitted, 20 packets received, ..."
		# Linux: "20 packets transmitted, 20 received, ..."
		/packets transmitted/ { for (i = 1; i < NF; i++) {
		                          if ($(i+1) == "packets" && $(i+2) ~ /^transmitted/) s = $i
		                          if ($(i+1) ~ /^received/ || ($(i+1) == "packets" && $(i+2) ~ /^received/)) r = $i } }
		/min\/avg\/max/ { split($0, a, "="); split(a[2], v, "/"); gsub(/ /, "", v[1]); mn = v[1]; av = v[2]; mx = v[3] }
		# Always six fields, "-" when unknown, so `read` never shifts them.
		END { if (s == "") s = 0; if (r == "") r = 0
		      loss = (s > 0) ? int(100 * (s - r) / s + 0.5) : 100
		      printf "%s %s %s %s %s %s\n", s, r, loss, (mn == "" ? "-" : mn), (av == "" ? "-" : av), (mx == "" ? "-" : mx) }' >"$3"
}

# Mbps from bytes and seconds.
mbps() { awk -v b="$1" -v t="$2" 'BEGIN { if (t > 0) printf "%.1f", b * 8 / t / 1e6; else printf "0" }'; }

# ---------------------------------------------------------------- gather ----

gather_basics() {
	HOSTNAME_=$(hostname 2>/dev/null || uname -n)
	GATEWAY='' PRIMARY_IF='' WIFI_IF='' IPV4='' MAC='' DNS='' DHCP=false
	WIFI_STATE='' SSID='' BSSID='' CHANNEL='' BAND='' RSSI='' NOISE='' TXRATE='' RXRATE='' PHY='' SUPPORTED_PHY='' DEV_BANDS='' WIFI_MAC=''

	if [ "$PLATFORM" = macos ]; then
		OS="macOS $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
		capture 'route -n get default' route -n get default >"$TMP/route"
		GATEWAY=$(awk '/gateway:/ { print $2; exit }' "$TMP/route")
		PRIMARY_IF=$(awk '/interface:/ { print $2; exit }' "$TMP/route")
		WIFI_IF=$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: (Wi-Fi|AirPort)/ { getline; print $2; exit }')
		capture 'ifconfig' ifconfig >/dev/null
		if [ -n "$PRIMARY_IF" ]; then
			IPV4=$(ipconfig getifaddr "$PRIMARY_IF" 2>/dev/null || true)
			MAC=$(ifconfig "$PRIMARY_IF" 2>/dev/null | awk '/ether/ { print $2; exit }')
			ipconfig getpacket "$PRIMARY_IF" >/dev/null 2>&1 && DHCP=true
		fi
		capture 'scutil --dns' scutil --dns >"$TMP/dns"
		# The first resolver is the one ordinary lookups use.
		DNS=$(awk '/^resolver #1/ { f = 1; next } /^resolver #/ { f = 0 } f && /nameserver\[/ { print $3 }' "$TMP/dns" | sort -u | tr '\n' ' ')
		capture 'scutil --proxy' scutil --proxy >"$TMP/proxy"
		if [ -n "$WIFI_IF" ]; then
			capture 'system_profiler SPAirPortDataType' system_profiler SPAirPortDataType >"$TMP/airport"
			WIFI_MAC=$(ifconfig "$WIFI_IF" 2>/dev/null | awk '/ether/ { print $2; exit }')
			# Indentation-free parse of the "Current Network Information" block.
			eval "$(awk '
				function q(s) { gsub(/'\''/, "'\''\\'\'''\''", s); return "'\''" s "'\''" }
				/Status:/ && !st { sub(/.*Status: */, ""); print "WIFI_STATE=" q($0); st = 1 }
				/Supported PHY Modes:/ { sub(/.*Supported PHY Modes: */, ""); print "SUPPORTED_PHY=" q($0) }
				# e.g. "1 (2GHz), 2 (2GHz), ... 36 (5GHz), ... 1 (6GHz), ..." on a 6E Mac.
				/Supported Channels:/ { b = ""; if ($0 ~ /2GHz/) b = b " 1"; if ($0 ~ /5GHz/) b = b " 2"; if ($0 ~ /6GHz/) b = b " 3"; print "DEV_BANDS=" q(b) }
				/Current Network Information:/ { cur = 1; getline; s = $0; sub(/^ */, "", s); sub(/:$/, "", s); print "SSID=" q(s); next }
				/Other Local Wi-Fi Networks:/ { cur = 0 }
				cur && /PHY Mode:/ { sub(/.*PHY Mode: */, ""); print "PHY=" q($0) }
				cur && /Channel:/ { sub(/.*Channel: */, ""); c = $0; ch = c; sub(/ .*/, "", ch); print "CHANNEL=" q(ch)
				                    b = c; if (b ~ /2GHz|2\.4/) b = "2.4 GHz"; else if (b ~ /6GHz/) b = "6 GHz"; else if (b ~ /5GHz/) b = "5 GHz"; else b = ""; print "BAND=" q(b) }
				cur && /Signal \/ Noise:/ { sub(/.*Noise: */, ""); split($0, a, " "); print "RSSI=" q(a[1]); print "NOISE=" q(a[4]) }
				cur && /Transmit Rate:/ { sub(/.*Rate: */, ""); print "TXRATE=" q($0) }
			' "$TMP/airport")"
			[ "$WIFI_STATE" = Connected ] && WIFI_STATE=connected
		fi
	elif [ "$PLATFORM" = linux ]; then
		OS=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-Linux}") || OS=Linux
		OS="$OS ($(uname -r))"
		if have ip; then
			capture 'ip route' ip route >"$TMP/route"
			capture 'ip addr' ip addr >/dev/null
			GATEWAY=$(awk '$1 == "default" { for (i = 1; i < NF; i++) if ($i == "via") { print $(i+1); exit } }' "$TMP/route")
			PRIMARY_IF=$(awk '$1 == "default" { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i+1); exit } }' "$TMP/route")
			grep -q '^default .*proto dhcp' "$TMP/route" && DHCP=true
			[ -n "$PRIMARY_IF" ] && IPV4=$(ip -o -4 addr show dev "$PRIMARY_IF" 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4; exit }')
		fi
		[ -n "$PRIMARY_IF" ] && [ -r "/sys/class/net/$PRIMARY_IF/address" ] && MAC=$(cat "/sys/class/net/$PRIMARY_IF/address")
		for d in /sys/class/net/*; do [ -d "$d/wireless" ] && { WIFI_IF=${d##*/}; break; }; done
		if have resolvectl && resolvectl status >/dev/null 2>&1; then
			capture 'resolvectl status' resolvectl status >/dev/null
			[ -n "$PRIMARY_IF" ] && DNS=$(resolvectl dns "$PRIMARY_IF" 2>/dev/null | sed -e 's/^[^:]*://' -e 's/^ *//' -e 's/ *$//' | tr -s ' ' ' ')
		fi
		[ -z "$DNS" ] && DNS=$(awk '/^nameserver/ { printf "%s%s", s, $2; s = " " }' /etc/resolv.conf 2>/dev/null)
		capture '/etc/resolv.conf' cat /etc/resolv.conf >/dev/null
		if [ -n "$WIFI_IF" ]; then
			WIFI_MAC=$(cat "/sys/class/net/$WIFI_IF/address" 2>/dev/null)
			if have iw; then
				capture "iw dev $WIFI_IF link" iw dev "$WIFI_IF" link >"$TMP/iw"
				if grep -q '^Connected to' "$TMP/iw"; then
					WIFI_STATE=connected
					BSSID=$(awk '/^Connected to/ { print $3; exit }' "$TMP/iw")
					SSID=$(sed -n 's/^[[:space:]]*SSID: //p' "$TMP/iw" | head -n 1)
					freq=$(awk '/freq:/ { print int($2); exit }' "$TMP/iw")
					RSSI=$(awk '/signal:/ { print $2; exit }' "$TMP/iw")
					RXRATE=$(awk '/rx bitrate:/ { print $3; exit }' "$TMP/iw")
					TXRATE=$(awk '/tx bitrate:/ { print $3; exit }' "$TMP/iw")
					PHY=$(awk '/tx bitrate:/ { if ($0 ~ /EHT/) print "802.11be"; else if ($0 ~ /HE-/) print "802.11ax"; else if ($0 ~ /VHT/) print "802.11ac"; else if ($0 ~ /MCS/) print "802.11n"; exit }' "$TMP/iw")
				else
					WIFI_STATE=disconnected
				fi
				capture 'iw list (bands)' sh -c "iw list 2>/dev/null | grep -E '^[[:space:]]*Band [0-9]+:'" >"$TMP/iwlist"
				# nl80211 band numbers: 1 = 2.4 GHz, 2 = 5 GHz, 4 = 6 GHz.
				grep -q 'Band 1:' "$TMP/iwlist" && DEV_BANDS="$DEV_BANDS 1"
				grep -q 'Band 2:' "$TMP/iwlist" && DEV_BANDS="$DEV_BANDS 2"
				grep -q 'Band 4:' "$TMP/iwlist" && DEV_BANDS="$DEV_BANDS 3"
			elif have nmcli; then
				capture 'nmcli dev wifi' nmcli -t -f ACTIVE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL dev wifi list --rescan no >"$TMP/nm"
				line=$(grep '^yes:' "$TMP/nm" | head -n 1)
				if [ -n "$line" ]; then
					WIFI_STATE=connected
					# nmcli -t escapes the colons inside BSSIDs as \: ; unescape after splitting.
					eval "$(printf '%s\n' "$line" | sed 's/\\:/%/g' | awk -F: '
						function q(s) { gsub(/%/, ":", s); gsub(/'\''/, "'\''\\'\'''\''", s); return "'\''" s "'\''" }
						{ print "SSID=" q($2); print "BSSID=" q($3); print "CHANNEL=" q($4); f = $5; sub(/ .*/, "", f)
						  print "freq=" q(f); r = $6; sub(/ .*/, "", r); print "RXRATE=" q(r); print "TXRATE=" q(r)
						  print "SIGNAL_PCT=" q($7) }')"
					[ -n "${SIGNAL_PCT:-}" ] && RSSI=$((SIGNAL_PCT / 2 - 100))
				else
					WIFI_STATE=disconnected
				fi
			fi
			if [ -n "${freq:-}" ]; then
				if [ "$freq" -lt 3000 ]; then BAND="2.4 GHz"; elif [ "$freq" -lt 5925 ]; then BAND="5 GHz"; else BAND="6 GHz"; fi
				[ -z "$CHANNEL" ] && CHANNEL=$(awk -v f="$freq" 'BEGIN { if (f == 2484) print 14; else if (f < 3000) print (f - 2407) / 5; else if (f < 5925) print (f - 5000) / 5; else print (f - 5950) / 5 }')
			fi
		fi
	else
		OS="$(uname -s) $(uname -r)"
	fi
	case "$BAND" in 2.4*) : ;; *) [ -n "$CHANNEL" ] && [ -z "$BAND" ] && [ "$CHANNEL" -le 14 ] 2>/dev/null && BAND="2.4 GHz" ;; esac
	case "$RXRATE" in '') RXRATE=$TXRATE ;; esac
	DNS=$(printf '%s' "$DNS" | sed -e 's/^ *//' -e 's/ *$//')
}

# ---------------------------------------------------------------- checks ----

check_wifi() {
	if [ -z "$WIFI_IF" ]; then
		add_check wifi.connected 'Wi-Fi connection' info 'no Wi-Fi adapter found'
		return
	fi
	if [ "$WIFI_STATE" != connected ]; then
		if [ -n "$GATEWAY" ] && [ "$PRIMARY_IF" != "$WIFI_IF" ]; then
			add_check wifi.connected 'Wi-Fi connection' info "Wi-Fi ($WIFI_IF) is not connected; using $PRIMARY_IF"
		else
			add_check wifi.connected 'Wi-Fi connection' fail "Wi-Fi ($WIFI_IF) is not connected" 'Connect to the Wi-Fi network from the menu bar / system tray.'
		fi
		return
	fi
	add_check wifi.connected 'Wi-Fi connection' ok "connected to \"$SSID\" on $WIFI_IF"

	if [ -n "$KNOWN_SSIDS" ]; then
		case "$SSID" in
		'' | '<redacted>')
			add_check wifi.ssid 'Network name' skip 'hidden by the system (needs Location permission for Terminal)' ;;
		*)
			if printf '%s\n' "$KNOWN_SSIDS" | grep -Fxq -- "$SSID"; then
				add_check wifi.ssid 'Network name' ok "$SSID"
			else
				add_check wifi.ssid 'Network name' warn "\"$SSID\" is not one of this site's networks ($(printf '%s' "$KNOWN_SSIDS" | tr '\n' ',' | sed 's/,/, /g'))" "Connect to one of the networks listed; a phone hotspot or a neighbour's network behaves differently."
			fi ;;
		esac
	fi

	if [ -n "$RSSI" ]; then
		d="$RSSI dBm${BAND:+, $BAND}${CHANNEL:+ channel $CHANNEL}"
		if [ "$RSSI" -ge -65 ]; then add_check wifi.signal 'Signal strength' ok "$d"
		elif [ "$RSSI" -ge -72 ]; then add_check wifi.signal 'Signal strength' info "$d - fair"
		elif [ "$RSSI" -ge -80 ]; then add_check wifi.signal 'Signal strength' warn "$d - weak" 'Move closer to an access point, or away from metal and walls between you and it.'
		else add_check wifi.signal 'Signal strength' fail "$d - very weak" 'The connection will be slow and drop out. Move closer to an access point.'
		fi
	fi

	check_band

	if [ -n "$TXRATE" ]; then
		r=${TXRATE%%.*}
		if [ "$r" -lt 20 ] 2>/dev/null; then add_check wifi.rate 'Wi-Fi link rate' warn "$TXRATE Mbps (negotiated, not measured)" 'A rate this low usually means weak signal or interference.'
		else add_check wifi.rate 'Wi-Fi link rate' ok "$TXRATE Mbps (negotiated, not measured)"; fi
	fi
}

# region band-verdict -------------------------------------------------------
# Pure: reads only its arguments and the file it is given. test/band.test.ts
# extracts this region and runs it on its own, against the same cases as the
# PowerShell version.
# Bands as ranks: 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz.
band_rank() { case "$1" in 2.4*) echo 1 ;; 5*) echo 2 ;; 6*) echo 3 ;; *) echo 0 ;; esac; }
rank_name() { case "$1" in 1) echo '2.4 GHz' ;; 2) echo '5 GHz' ;; 3) echo '6 GHz' ;; esac; }

# band_verdict CURRENT_BAND DEVICE_RANKS SSID SSIDS_FILE KNOWN_SSIDS
#   DEVICE_RANKS: e.g. "1 2 3"; SSIDS_FILE: "<bands>\t<ssid>" lines, empty if
#   unknown; KNOWN_SSIDS: newline-separated.
# Prints "status<TAB>detail<TAB>advice", or nothing when the band is unknown.
band_verdict() {
	_cur=$(band_rank "$1")
	[ "$_cur" -gt 0 ] || return 0
	# Whatever it's on, it can do, whatever the driver listed.
	_devmax=$_cur
	for _r in $2; do [ "$_r" -gt "$_devmax" ] && _devmax=$_r; done
	_net=$(awk -F '\t' -v s="$3" '$2 == s { print $1; exit }' "$4" 2>/dev/null)
	# Best band both ends can do. Without the network's list, never claim
	# 6 GHz: plenty of networks (and some of ours) don't broadcast it.
	_best=$_cur
	if [ -n "$_net" ]; then
		for _r in $2; do
			case ",$_net," in *",$(rank_name "$_r"),"*) [ "$_r" -gt "$_best" ] && _best=$_r ;; esac
		done
	else
		_m=$_devmax
		[ "$_m" -gt 2 ] && _m=2
		[ "$_m" -gt "$_best" ] && _best=$_m
	fi
	_other6=''
	if [ "$_devmax" -ge 3 ] && [ -n "$_net" ]; then
		case ",$_net," in
		*",6 GHz,"*) ;;
		*) _other6=$(printf '%s
' "$5" | while IFS= read -r _k; do
			[ -n "$_k" ] && awk -F '\t' -v s="$_k" '$2 == s && $1 ~ /6 GHz/ { print s; exit }' "$4"
		done | head -n 1) ;;
		esac
	fi
	_t=$(printf '\t')
	if [ "$_cur" -eq 1 ] && [ "$_best" -gt 1 ]; then
		echo "warn${_t}on 2.4 GHz, though this computer and this network both do $(rank_name "$_best")${_t}2.4 GHz is slower and very crowded here. Turning Wi-Fi off and on often moves it up; the network team can look at band steering."
	elif [ "$_cur" -eq 2 ] && [ "$_best" -eq 3 ]; then
		echo "info${_t}on 5 GHz; this computer and this network also do 6 GHz, which is usually far less crowded${_t}6 GHz reaches less far than 5 GHz. Near an access point, turning Wi-Fi off and on may move it to 6 GHz."
	elif [ -n "$_other6" ]; then
		echo "info${_t}this computer supports 6 GHz, but \"$3\" isn't broadcast there; \"$_other6\" is${_t}Joining \"$_other6\" would let it use 6 GHz, which is usually far less crowded."
	elif [ "$_cur" -eq 1 ] && [ "$_devmax" -le 1 ]; then
		echo "info${_t}on 2.4 GHz, the only band this adapter supports${_t}A newer USB Wi-Fi adapter with 5 or 6 GHz would be much faster."
	else
		echo "ok${_t}$1${_t}"
	fi
}
# endregion band-verdict -----------------------------------------------------

check_band() {
	[ "$(band_rank "$BAND")" -gt 0 ] || return 0
	devbands=$DEV_BANDS
	if [ -z "$devbands" ]; then
		# Unknown adapter bands (e.g. nmcli only): infer 5 GHz from the PHY modes.
		case "$SUPPORTED_PHY" in *ac* | *ax* | *be* | */a/*) devbands='1 2' ;; esac
	fi
	# Which bands each SSID is on air in, from the network controller via this
	# site. Unavailable means unknown, and the report says why.
	neterr=''
	code=$(curl -s --noproxy '*' -A "$UA" --max-time 5 -o "$TMP/ssids" -w '%{http_code}' "$BASE_URL/api/network/ssids.txt" 2>/dev/null) || true
	if [ "$code" != 200 ]; then
		neterr="HTTP ${code:-000}"
		: >"$TMP/ssids"
	fi
	net=$(awk -F '\t' -v s="$SSID" '$2 == s { print $1; exit }' "$TMP/ssids")

	v=$(band_verdict "$BAND" "$devbands" "$SSID" "$TMP/ssids" "$KNOWN_SSIDS")
	[ -n "$v" ] || return 0
	st=$(printf '%s' "$v" | cut -f1)
	detail=$(printf '%s' "$v" | cut -f2)
	advice=$(printf '%s' "$v" | cut -f3)
	[ "$st" = ok ] && detail="$BAND${PHY:+, $PHY}"

	dl='' sep=''
	for r in $devbands; do dl="$dl$sep$(json_str "$(rank_name "$r")")"; sep=','; done
	data="{\"current\":$(json_str "$BAND"),\"deviceBands\":[$dl],\"networkBands\":$(json_str "$net")${neterr:+,\"networkBandsError\":$(json_str "$neterr")}}"
	add_check wifi.band 'Wi-Fi band' "$st" "$detail" "$advice" "$data"
}

check_ip() {
	if [ -z "$GATEWAY" ]; then
		add_check ip.address 'IP address' fail 'no default gateway: not connected to any network' 'Check Wi-Fi or the cable.'
		return
	fi
	case "$IPV4" in
	'') add_check ip.address 'IP address' fail "no IPv4 address on $PRIMARY_IF" ;;
	169.254.*) add_check ip.address 'IP address' fail "$IPV4 - the network never gave this computer an address" 'Turn Wi-Fi off and on, or forget the network and rejoin. If it keeps happening, report it.' ;;
	*) add_check ip.address 'IP address' ok "$IPV4 on $PRIMARY_IF" ;;
	esac
}

check_vpn() {
	case "$PRIMARY_IF" in
	utun* | tun* | tap* | wg* | ppp* | ipsec* | tailscale* | zt* | nordlynx* | gpd*)
		add_check net.vpn 'VPN / tunnels' warn "internet traffic goes through $PRIMARY_IF (a VPN)" 'A VPN can block local names and slow everything down. Try again with it disconnected.' ;;
	*)
		add_check net.vpn 'VPN / tunnels' ok "default route is $PRIMARY_IF" ;;
	esac
}

check_proxy() {
	p="${http_proxy:-}${HTTP_PROXY:-}${https_proxy:-}${HTTPS_PROXY:-}${all_proxy:-}${ALL_PROXY:-}"
	if [ "$PLATFORM" = macos ] && grep -Eq '(HTTPEnable|HTTPSEnable|ProxyAutoConfigEnable) : 1' "$TMP/proxy" 2>/dev/null; then
		p="$p system-proxy"
	fi
	if [ -n "$p" ]; then add_check net.proxy 'Proxy' warn 'a proxy is configured' 'A proxy is unusual here and can break local sites.'
	else add_check net.proxy 'Proxy' ok 'none'; fi
}

check_hosts() {
	[ -r /etc/hosts ] || return 0
	# Only this site's own names: an entry for them overrides the network's DNS.
	pat=''
	for u in $BASE_URL $FALLBACK_URLS; do
		h=$(printf '%s' "$u" | sed -e 's#^[a-z]*://##' -e 's#[:/].*$##' -e 's/\./\\./g')
		pat="${pat:+$pat|}$h"
	done
	ours=$(grep -v '^[[:space:]]*#' /etc/hosts | grep -E -- "[[:space:]]($pat)([[:space:]]|\$)" || true)
	if [ -n "$ours" ]; then
		add_check net.hosts 'Hosts file' warn "overrides for this site's names: $(printf '%s' "$ours" | tr '\n' '|')" 'These lines override the network'"'"'s own names and are a common cause of "works for everyone but me".'
	fi
}

ping_check() { # ID TITLE FILE FAIL_ADVICE WARN_MS
	read -r s r loss mn av mx <"$3" || { add_check "$1" "$2" error 'ping produced no output'; return; }
	data="{\"sent\":$(json_num "$s"),\"received\":$(json_num "$r"),\"lossPct\":$(json_num "$loss"),\"minMs\":$(json_num "${mn:-}"),\"avgMs\":$(json_num "${av:-}"),\"maxMs\":$(json_num "${mx:-}")}"
	if [ "${r:-0}" = 0 ]; then add_check "$1" "$2" fail 'no replies' "$4" "$data"; return; fi
	d="${loss}% lost, avg ${av} ms, worst ${mx} ms"
	slow=$(awk -v a="$av" -v w="$5" 'BEGIN { print (a > w) ? 1 : 0 }')
	if [ "$loss" -ge 20 ]; then add_check "$1" "$2" fail "$d" "$4" "$data"
	elif [ "$loss" -gt 0 ] || [ "$slow" = 1 ]; then add_check "$1" "$2" warn "$d" '' "$data"
	else add_check "$1" "$2" ok "$d" '' "$data"; fi
}

check_ping_gateway() {
	[ -n "$GATEWAY" ] || { add_check lan.gateway 'Router (gateway) ping' skip 'no gateway'; return; }
	ping_check lan.gateway "Router (gateway) ping ($GATEWAY)" "$TMP/ping-gw" 'The Wi-Fi link itself is losing traffic: weak signal or interference.' 30
}

check_ping_inet() {
	ping_check inet.ping 'Internet ping (1.1.1.1)' "$TMP/ping-inet" '' 100
}

check_dns_servers() {
	set -- $DNS
	if [ $# -eq 0 ]; then add_check dns.servers 'DNS servers' fail 'none configured'; return; fi
	for s in "$@"; do
		case $s in 10.* | 192.168.* | 172.1[6-9].* | 172.2?.* | 172.3[01].* | 127.*) add_check dns.servers 'DNS servers' ok "$DNS"; return ;; esac
	done
	add_check dns.servers 'DNS servers' warn "$DNS - set by hand or by a VPN, not by this network" "Names like $BASE_HOST only resolve through the network's own DNS. Set DNS back to automatic."
}

resolve() {
	if [ "$PLATFORM" = macos ]; then
		dscacheutil -q host -a name "$1" 2>/dev/null | awk '/^ip_address:/ { printf "%s ", $2 }'
	elif have getent; then
		getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' '
	else
		nslookup "$1" 2>/dev/null | awk '/^Address: / { printf "%s ", $2 }'
	fi
}

check_dns_local() {
	a=$(resolve "$BASE_HOST")
	a=${a% }
	if [ -n "$a" ]; then
		add_check dns.local "Local name ($BASE_HOST)" ok "$a"
	elif [ -n "$GATEWAY" ] && have dig && [ -n "$(dig +short +time=2 +tries=1 "@$GATEWAY" "$BASE_HOST" A 2>/dev/null)" ]; then
		add_check dns.local "Local name ($BASE_HOST)" fail "this computer can't resolve it, but the router can" 'This computer is using the wrong DNS server (a VPN or a manual setting).'
	else
		add_check dns.local "Local name ($BASE_HOST)" fail "can't resolve $BASE_HOST"
	fi
}

check_dns_public() {
	a=$(resolve www.cloudflare.com)
	if [ -n "$a" ]; then add_check dns.public 'Internet name (www.cloudflare.com)' ok "$(set -- $a; echo $#) addresses"
	else add_check dns.public 'Internet name (www.cloudflare.com)' fail "can't resolve www.cloudflare.com"; fi
}

SERVER_DATE=''
check_lan_http() {
	out=$(curl -sS --noproxy '*' -A "$UA" --max-time 8 -D "$TMP/hdr" -o /dev/null -w '%{http_code} %{time_total}' "$BASE_URL/api/health" 2>&1) || true
	SERVER_DATE=$(awk 'tolower($1) == "date:" { sub(/^[^:]*: */, ""); sub(/\r$/, ""); print; exit }' "$TMP/hdr" 2>/dev/null)
	set -- $out
	if [ "${1:-}" = 200 ]; then add_check lan.http "This site ($BASE_URL)" ok "answered in $(awk -v t="$2" 'BEGIN { printf "%d", t * 1000 }') ms"
	else add_check lan.http "This site ($BASE_URL)" fail "$out"; fi
}

# measure_download URL SECONDS DIRECT(0|1): fetch URL repeatedly for about
# SECONDS. Repeats rather than asking for one huge file, because some servers
# cap the size (Cloudflare 403s __down above ~100 MB). Sets DL_MBPS, DL_ERR.
measure_download() {
	_url=$1 _max=$2 _direct=$3 _tb=0 _tt=0 _n=0 DL_ERR=''
	while [ "$_n" -lt 50 ]; do
		_left=$(awk -v t="$_tt" -v m="$_max" 'BEGIN { printf "%.2f", m - t }')
		case $_left in -* | 0.0*) break ;; esac
		if [ "$_direct" = 1 ]; then
			_r=$(curl -s --noproxy '*' -A "$UA" --max-time "$_left" -o /dev/null -w '%{http_code} %{size_download} %{time_total}' "$_url" 2>/dev/null)
		else
			_r=$(curl -s -A "$UA" --max-time "$_left" -o /dev/null -w '%{http_code} %{size_download} %{time_total}' "$_url" 2>/dev/null)
		fi
		set -- $_r
		if [ "${1:-000}" != 200 ]; then
			[ "$_n" -eq 0 ] && DL_ERR="HTTP ${1:-000} from $_url"
			break
		fi
		_tb=$((_tb + ${2:-0}))
		_tt=$(awk -v a="$_tt" -v b="${3:-0}" 'BEGIN { printf "%.3f", a + b }')
		_n=$((_n + 1))
	done
	DL_MBPS=$(mbps "$_tb" "$_tt")
}

check_lan_speed() {
	measure_download "$BASE_URL/api/download?bytes=209715200" 6 1
	if [ -n "$DL_ERR" ]; then add_check lan.speed 'Speed to this site (your Wi-Fi)' error "$DL_ERR"; return; fi
	down=$DL_MBPS
	# shellcheck disable=SC2046 # splitting "<bytes> <seconds>" into $1 $2 is the point
	set -- $(head -c 104857600 /dev/urandom | curl -s --noproxy '*' -A "$UA" --max-time 5 -X POST -H 'Content-Type: application/octet-stream' -T - -o /dev/null -w '%{size_upload} %{time_total}' "$BASE_URL/api/upload" 2>/dev/null || true)
	up=$(mbps "${1:-0}" "${2:-0}")
	data="{\"downMbps\":$down,\"upMbps\":$up}"
	d="$down Mbps down, $up Mbps up"
	lvl=$(awk -v m="$down" 'BEGIN { print (m < 5) ? "fail" : (m < 25) ? "warn" : "ok" }')
	case $lvl in
	fail) add_check lan.speed 'Speed to this site (your Wi-Fi)' fail "$d" 'Very slow on the local network itself, so the Wi-Fi link is the problem, not the internet.' "$data" ;;
	warn) add_check lan.speed 'Speed to this site (your Wi-Fi)' warn "$d" 'Slower than this network should manage: weak signal, 2.4 GHz, or a crowded channel.' "$data" ;;
	*) add_check lan.speed 'Speed to this site (your Wi-Fi)' ok "$d" '' "$data" ;;
	esac
}

check_inet_http() {
	body=$(curl -sS -A "$UA" --max-time 10 -w '\n__T=%{time_total}' https://www.cloudflare.com/cdn-cgi/trace 2>&1) || {
		add_check inet.http 'Internet (https)' fail "$body"
		return
	}
	ip=$(printf '%s\n' "$body" | sed -n 's/^ip=//p') colo=$(printf '%s\n' "$body" | sed -n 's/^colo=//p')
	ms=$(printf '%s\n' "$body" | sed -n 's/^__T=//p' | awk '{ printf "%d", $1 * 1000 }')
	add_check inet.http 'Internet (https)' ok "reached Cloudflare ($colo) in $ms ms as $ip" '' "{\"ip\":$(json_str "$ip"),\"colo\":$(json_str "$colo"),\"ms\":$(json_num "$ms")}"
}

check_inet_speed() {
	measure_download 'https://speed.cloudflare.com/__down?bytes=25000000' 6 0
	case "$DL_ERR" in
	'') ;;
	# Everyone here shares one public address, so Cloudflare's per-address
	# limit is shared too. That's not a fault on this computer.
	'HTTP 429'*) add_check inet.speed 'Internet download speed' skip "Cloudflare's speed test is rate-limiting this network right now (HTTP 429)"; return ;;
	*) add_check inet.speed 'Internet download speed' error "$DL_ERR"; return ;;
	esac
	m=$DL_MBPS
	lvl=$(awk -v m="$m" 'BEGIN { print (m < 10) ? "warn" : "ok" }')
	add_check inet.speed 'Internet download speed' "$lvl" "$m Mbps" '' "{\"downMbps\":$m}"
}

check_clock() {
	[ -n "$SERVER_DATE" ] || return 0
	if [ "$PLATFORM" = macos ]; then
		srv=$(date -j -u -f '%a, %d %b %Y %H:%M:%S GMT' "$SERVER_DATE" +%s 2>/dev/null)
	else
		srv=$(date -u -d "$SERVER_DATE" +%s 2>/dev/null)
	fi
	[ -n "$srv" ] || return 0
	skew=$(($(date -u +%s) - srv))
	if [ "${skew#-}" -gt 120 ]; then add_check clock 'Clock' warn "this computer's clock is off by $skew seconds" 'A wrong clock breaks secure websites. Turn on automatic date & time.'
	else add_check clock 'Clock' ok 'in sync'; fi
}

# --------------------------------------------------------------- report ----

summarize() {
	nfail=$(grep -cE '"status":"(fail|error)"' "$TMP/checks" || true)
	nwarn=$(grep -c '"status":"warn"' "$TMP/checks" || true)
	say ""
	if [ "$nfail" -gt 0 ]; then say "  ${C_FAIL}Found $nfail problem(s) and $nwarn warning(s).${C_0}"
	elif [ "$nwarn" -gt 0 ]; then say "  ${C_WARN}No hard failures; $nwarn thing(s) worth a look.${C_0}"
	else say "  ${C_OK}Everything checked looks healthy.${C_0}"; fi
	say ""
}

DESCRIPTION=''
build_report() {
	if [ -z "${WIFI_CHECK_NO_UPLOAD:-}" ] && [ -z "${WIFI_CHECK_YES:-}" ]; then
		# Under `curl | sh` stdin is the script itself, so ask on the terminal.
		# Probe in a subshell first: a failed `exec` redirection exits the shell.
		if (: </dev/tty) 2>/dev/null; then
			exec 3</dev/tty
			say "  ${C_DIM}The report contains this computer's name, network settings and the results above.${C_0}"
			say "  ${C_DIM}No files, passwords or browsing history.${C_0}"
			printf "  What's going wrong? (a few words, or just press Enter) " >/dev/tty
			IFS= read -r DESCRIPTION <&3 || DESCRIPTION=''
			printf "  Send this report to the network team at %s? [Y/n] " "$BASE_HOST" >/dev/tty
			IFS= read -r ans <&3 || ans=n
			exec 3<&-
			case "$ans" in [nN]*) WIFI_CHECK_NO_UPLOAD=1 ;; esac
		else
			# No terminal to ask on: don't send without consent.
			WIFI_CHECK_NO_UPLOAD=1
		fi
	fi

	j() { json_str "$1"; }
	sep=''
	{
		printf '{"schema":1,"kind":"diagnostic"'
		printf ',"tool":{"name":"wifi-check.sh","version":%s}' "$(j "$TOOL_VERSION")"
		printf ',"collectedAt":"%s"' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf ',"host":{"hostname":%s,"platform":"%s","os":%s}' "$(j "$HOSTNAME_")" "$PLATFORM" "$(j "$OS")"
		[ -n "$DESCRIPTION" ] && printf ',"description":%s' "$(j "$DESCRIPTION")"
		if [ -n "$WIFI_IF" ]; then
			printf ',"wifi":{"interface":%s,"state":%s,"ssid":%s,"bssid":%s,"mac":%s,"band":%s,"channel":%s,"radioType":%s,"rssi":%s,"noise":%s,"rxMbps":%s,"txMbps":%s}' \
				"$(j "$WIFI_IF")" "$(j "$WIFI_STATE")" "$(j "$SSID")" "$(j "$BSSID")" "$(j "$WIFI_MAC")" "$(j "$BAND")" \
				"$(json_num "$CHANNEL")" "$(j "$PHY")" "$(json_num "$RSSI")" "$(json_num "$NOISE")" "$(json_num "$RXRATE")" "$(json_num "$TXRATE")"
		fi
		printf ',"interfaces":[{"name":%s,"mac":%s,"ipv4":[%s],"gateway":[%s],"dns":[' \
			"$(j "$PRIMARY_IF")" "$(j "$MAC")" "$([ -n "$IPV4" ] && j "$IPV4")" "$([ -n "$GATEWAY" ] && j "$GATEWAY")"
		for s in $DNS; do printf '%s%s' "$sep" "$(j "$s")"; sep=','; done
		printf '],"dhcp":%s}]' "$DHCP"
		printf ',"checks":['
		paste -s -d, "$TMP/checks"
		printf '],"raw":{'
		sed 's/,$//' "$TMP/raw"
		printf '}}'
	} >"$TMP/report.json"
}

save_report() {
	dir="$HOME/Downloads"
	[ -d "$dir" ] || dir="$HOME"
	f="$dir/wifi-check-$(printf '%s' "$HOSTNAME_" | tr -c 'A-Za-z0-9.-' '_')-$(date +%Y%m%d-%H%M%S).json"
	cp "$TMP/report.json" "$f"
	SAVED=$f
}

deliver() {
	if [ -n "${WIFI_CHECK_NO_UPLOAD:-}" ]; then
		save_report
		say "  ${C_WARN}Not sent. Saved the report to $SAVED${C_0}"
		say ""
		return
	fi
	errs=''
	for u in $BASE_URL $FALLBACK_URLS; do
		resp=$(curl -sS --noproxy '*' -A "$UA" --max-time 60 -H 'Content-Type: application/json' --data-binary @"$TMP/report.json" -w '\n%{http_code}' "$u/api/reports" 2>&1) || {
			errs="$errs
    $u -> $resp"
			continue
		}
		code=$(printf '%s\n' "$resp" | tail -n 1)
		body=$(printf '%s\n' "$resp" | sed '$d')
		if [ "$code" = 201 ]; then
			rcode=$(printf '%s' "$body" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
			rurl=$(printf '%s' "$body" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
			say ""
			say "  ${C_OK}Sent. Your report code is $rcode - give this to whoever is helping you.${C_0}"
			say "  View it at $rurl"
			say ""
			return
		fi
		errs="$errs
    $u -> HTTP $code: $body"
	done
	save_report
	say ""
	say "  ${C_WARN}Couldn't reach the server to send the report:${C_0}$errs"
	say "  ${C_WARN}Saved it to $SAVED${C_0}"
	say "  ${C_WARN}When you're back online, upload it at $BASE_URL (Upload a saved report).${C_0}"
	say ""
}

main "$@"
