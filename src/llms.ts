/** Plain-text API guide for agents, served at /llms.txt. */
export function llmsTxt(base: string): string {
  return `# wifi-tester: LAN wifi reports for agents

People on this LAN run a read-only diagnostic (or the browser speed test) and
it posts a report here. Each report is enriched at receipt with what the UniFi
controller saw for that machine: AP, band, channel, signal, retries, that
radio's channel utilization, and the client's recent roam/disconnect events.

Your job, as an agent watching this: notice new reports, work out what is
wrong, and record what you found. Nothing here changes anything on the
reporter's machine or on the network; recommending a change is fine, but
applying one needs a human's explicit go-ahead.

## Auth

Every endpoint below except GET /api/reports/<id> needs:

    Authorization: Bearer $WIFI_AGENT_TOKEN

## Watch for new reports

Long-poll (simplest; loop on the returned cursor):

    curl -s -H "Authorization: Bearer $WIFI_AGENT_TOKEN" \\
      "${base}/api/reports?since=<cursor>&wait=60&kind=diagnostic"

  → {"cursor": N, "reports": [summary, ...]}
  Start with since=0 to replay everything, or omit since for the newest page
  (newest first). With since, results are oldest-first and nothing is skipped.
  wait=1..120 holds the request open until a report arrives.

Server-Sent Events (event "report", id = seq; resumes via Last-Event-ID):

    curl -sN -H "Authorization: Bearer $WIFI_AGENT_TOKEN" "${base}/api/reports/stream?since=<seq>"

Filters on the list: status=new|ack|resolved|ignored, kind=diagnostic|speedtest,
code=<6-char code a person read out>, limit=1..500, full=1 for whole reports.

## Read one report

    curl -s "${base}/api/reports/<id>"

Fields: payload.checks[] (id, status ok|info|warn|fail|error|skip, detail,
advice, data), payload.wifi, payload.interfaces, payload.raw (raw command
output: ipconfig /all, netsh wlan show interfaces, ...), and unifi (the
controller snapshot: client, ap, radio, events; or {error} when the controller
couldn't be reached, which is itself worth noting).

## Triage

    curl -s -X PATCH -H "Authorization: Bearer $WIFI_AGENT_TOKEN" \\
      -H 'Content-Type: application/json' \\
      -d '{"status":"ack","note":"2.4 GHz on U7-Pro West, 73% util; see ...","by":"<your name>"}' \\
      "${base}/api/reports/<id>"

status: new → ack (looking) → resolved | ignored. Notes append, never replace.

## Network context

    curl -s -H "Authorization: Bearer $WIFI_AGENT_TOKEN" "${base}/api/unifi/aps"

Every AP with per-radio channel, width, utilization (cu_total), self rx/tx
share, client count, satisfaction, retries.

## Reading the signals

- signal ≥ -65 dBm good, -65..-75 marginal, below -75 poor.
- Radio utilizationPct well above 50% on 2.4 GHz means airtime contention;
  selfRx+selfTx small compared to total means neighbours and noise, not our clients.
- txRetriesPct above ~15% for a client means a bad link even when signal looks fine.
- A 169.254.x.x address means DHCP failed; DNS servers that aren't the gateway
  usually mean a VPN or a hand-set resolver (8.8.8.8), and .tsl names won't resolve.
- Repeated CLIENT_ROAMED / DISCONNECTED events in unifi.events: sticky or
  flapping client, or an AP edge.
`;
}
