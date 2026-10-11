# wifi-tester

A small LAN site for answering "why is the Wi-Fi bad?". It runs at Tom Sawyer
Labs as **http://wifi.tsl/**, on steamboat.

- **Browser speed test.** It measures to this server (your Wi-Fi) and to the
  internet (Cloudflare, plus an optional LibreSpeed server), either at the same
  time or one after the other. It reports idle latency, jitter, download,
  upload, and **latency under load**, which is the number people actually feel.
- **A one-line diagnostic** for Windows, macOS and Linux. It reads the
  computer's Wi-Fi and network state, tells the person what looks wrong in plain
  language, and (after asking) uploads a report. **It changes nothing on the
  machine.**
- **Reports for agents.** Each report is enriched when it arrives with what the
  UniFi controller sees for that machine: AP, band, channel, signal, retries,
  that radio's channel utilization, and recent roam and disconnect events.
  Agents can watch for new reports by long-poll or SSE, and triage them.

## For people on the LAN

Open http://wifi.tsl/ and press **Start test**, or run the check:

| OS            | Run this                              | Or download                                    |
| ------------- | ------------------------------------- | ---------------------------------------------- |
| Windows       | `irm http://wifi.tsl/ps1 \| iex`      | `wifi-check.cmd`, double-click (works offline) |
| macOS / Linux | `curl -fsSL http://wifi.tsl/sh \| sh` | `wifi-check.sh`, then `sh wifi-check.sh`       |

`irm … | iex` works over plain HTTP on Windows PowerShell 5.1 and 7. Execution
policy doesn't apply to `iex`. A bare `iex <url>` would not fetch anything,
which is why the `irm` is there.

If the computer can't reach the server, the script saves its report to
`~/Downloads/wifi-check-*.json`. Upload that file from the page once the
computer is back online.

Options are environment variables, because `irm | iex` can't pass parameters:

- `WIFI_CHECK_NO_UPLOAD=1`: never send; save to a file instead.
- `WIFI_CHECK_YES=1`: send without asking (unattended use).

### What the diagnostic looks at

| Check                                       | Windows | macOS/Linux |
| ------------------------------------------- | :-----: | :---------: |
| Wi-Fi connected, SSID is one of ours        |    ✓    |      ✓      |
| Signal (dBm), band, negotiated rate         |    ✓    |      ✓      |
| Best band available (2.4 / 5 / 6 GHz)²      |    ✓    |     ✓³      |
| A stronger AP for the same SSID nearby      |   ✓¹    |             |
| Random hardware address, driver age         |    ✓    |             |
| IP address / DHCP failure (169.254.x.x)     |    ✓    |      ✓      |
| VPN carrying the default route, proxies     |    ✓    |      ✓      |
| Hosts-file overrides for this site's names  |    ✓    |      ✓      |
| Windows "Public" network profile            |    ✓    |             |
| Gateway ping (loss and latency on the link) |    ✓    |      ✓      |
| DNS servers, local name, public name        |    ✓    |      ✓      |
| HTTP to this site, LAN down/up throughput   |    ✓    |      ✓      |
| Internet ping, HTTPS, download throughput   |    ✓    |      ✓      |
| Clock skew                                  |    ✓    |      ✓      |

¹ Needs Location turned on in Windows 11 24H2 and later, otherwise it is skipped.

² The script compares the bands the adapter supports with the bands this SSID
is actually broadcast in, which it gets from `GET /api/network/ssids.txt` (UniFi's
live VAP table). It flags 2.4 GHz when 5 or 6 GHz would work, notes 5 GHz when
6 GHz would work, and suggests a sibling SSID when this one isn't on 6 GHz but
the adapter is. Without the network's list it never claims 6 GHz. The rules
exist once per script, in a marked pure `band-verdict` region, and
`test/band.test.ts` runs both versions against the same cases.

³ The adapter's bands come from `iw list` on Linux (not `nmcli`-only systems) and
`system_profiler`'s supported channels on macOS. On Windows they come from
`netsh wlan show drivers` (Windows 11 lists them).

It also attaches raw output for the network team: `ipconfig /all`,
`netsh wlan show …`, `route print` on Windows; `ip`, `iw`/`nmcli`, `resolvectl`
on Linux; `system_profiler SPAirPortDataType`, `scutil` on macOS.

## For agents

`GET /llms.txt` has the whole guide. In short, with
`Authorization: Bearer $WIFI_AGENT_TOKEN`:

```sh
# Follow new reports (long-poll; loop on the returned cursor)
curl -s -H "Authorization: Bearer $WIFI_AGENT_TOKEN" "http://wifi.tsl/api/reports?since=0&wait=60&kind=diagnostic"

# Or stream them
curl -sN -H "Authorization: Bearer $WIFI_AGENT_TOKEN" "http://wifi.tsl/api/reports/stream?since=0"

# Read one (no token needed; the id is unguessable)
curl -s http://wifi.tsl/api/reports/<id>

# Triage
curl -s -X PATCH -H "Authorization: Bearer $WIFI_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"ack","note":"…","by":"claude"}' http://wifi.tsl/api/reports/<id>

# AP radios: channel, utilization, clients, retries
curl -s -H "Authorization: Bearer $WIFI_AGENT_TOKEN" http://wifi.tsl/api/unifi/aps

# Which bands each SSID is on air in (public; SSIDs are broadcast anyway)
curl -s http://wifi.tsl/api/network/ssids
```

## Configuration

Everything is environment. Deployment-specific values have no defaults, so a
missing one fails at boot.

| Variable           | Example                                  | Notes                                                    |
| ------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `PORT`             | `3000`                                   | The image sets it                                        |
| `DATABASE_PATH`    | `/data/wifi.db`                          | The image sets it; SQLite                                |
| `PUBLIC_BASE_URLS` | `http://wifi.tsl`                        | Comma-separated; the first is canonical                  |
| `AGENT_TOKEN`      | (secret, 24+ chars)                      | Bearer token for the agent API                           |
| `TRUST_PROXY`      | `true`                                   | Read the client IP from `X-Real-IP`; only behind Caddy   |
| `UNIFI_ENABLED`    | `true`                                   | `false` turns the controller lookup off explicitly       |
| `UNIFI_HOST`       | `https://unifi.example.com`              | Controller base URL                                      |
| `UNIFI_SITE`       | `default`                                | Site internal reference                                  |
| `UNIFI_API_KEY`    | (secret)                                 | Use a key from a **View Only** admin; the app only reads |
| `LIBRESPEED_URL`   | `https://speedtest.example.com` or empty | Extra internet target; must be set, empty to disable¹    |
| `KNOWN_SSIDS`      | `Office,Office IoT`                      | Must be set, empty to skip the SSID check                |

¹ The browser calls `<LIBRESPEED_URL>/garbage`, `/empty` (with `?cors`), so
the server must answer LibreSpeed's endpoints by their bare names:
[caddy-librespeed](https://github.com/cinderblock/caddy-librespeed) or
LibreSpeed's Go backend. The PHP backend only answers `backend/*.php`.

The UniFi calls are `GET stat/sta`, `GET stat/device`, and
`POST v2/…/system-log/all` (a query whose body is only a time window). Nothing
writes, and a test asserts that.

## Development

```sh
bun install
bun test
bun run typecheck
PORT=3999 DATABASE_PATH=./data/dev.db PUBLIC_BASE_URLS=http://localhost:3999 \
  AGENT_TOKEN=dev-agent-token-0123456789abcdef TRUST_PROXY=false UNIFI_ENABLED=false \
  LIBRESPEED_URL= KNOWN_SSIDS= bun run dev
```

`scripts/wifi-check.ps1` and `scripts/wifi-check.sh` are templates. The server
fills in `__WIFI_*__` placeholders, quoted for each language, and serves `.sh`
with LF, `.cmd` with CRLF. Keep the PowerShell script **ASCII**, because 5.1
decodes `irm` text as Latin-1. A test enforces this.

## Deployment

The image is built by `.github/workflows/build.yml` on push to `master` and
published to `ghcr.io/cinderblock/wifi-tester`. This repo never deploys.
What runs on steamboat is pinned in `cinderblock/ops` at
`servers/steamboat/stacks/wifi-tsl/pin.json`. Ship a build by pasting the pin
from the CI run summary there and pushing ops.
