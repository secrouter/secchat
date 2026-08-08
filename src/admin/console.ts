// Server-rendered HTML for the admin / audit-review console (AU 3.3.5/6) — the one page a
// compliance reviewer opens to see whether the tamper-evident chains (src/audit/chain.ts) are
// intact and to read the audit trail. Pure presentation: `renderConsole` takes the read-only
// snapshot built by src/admin/overview.ts and produces ONE complete, self-contained HTML
// document — inline <style>, no client script, no external assets (this runs in an air-gapped
// enclave, so nothing may reach out for a font, an icon, or a stylesheet).
//
// SECURITY: channel/agent names and audit `detail`/`target` strings are user- or agent-controlled
// (a channel can be named anything; a redaction reason is free text). Every dynamic value from
// the overview is routed through `esc()` before it touches the HTML — nothing is ever
// interpolated raw. See the escaping tests in test/admin-console.test.ts.

import type { AdminOverview, Agent, AgentSession, AuditEvent, Channel, SessionStatus } from "../types.ts";

/** The one escaping primitive everything dynamic goes through. Order matters — `&` first, or
 * the entities we just inserted would themselves get escaped. */
function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MUTED_DASH = '<span class="muted">—</span>';

/** Canonical, timezone-unambiguous timestamp formatting — UTC always, no locale dependence (the
 * renderer runs server-side; the output must look identical no matter who opens it). Falls back
 * to the raw string for anything unparseable rather than printing "Invalid Date". */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** A table's empty-state: one muted "none" row spanning every column, instead of a table with a
 * header and nothing under it. */
function emptyRow(colspan: number): string {
  return `<tr><td class="empty" colspan="${colspan}">none</td></tr>`;
}

/** Session status -> pill class. A `Record` over the closed `SessionStatus` union so this stays
 * exhaustive at compile time (a new status added to types.ts fails to typecheck here until
 * styled, rather than silently rendering unstyled). */
const STATUS_CLASS: Record<SessionStatus, string> = {
  starting: "pill-info",
  active: "pill-ok",
  orphaned: "pill-warn",
  ended: "pill-muted",
};

function statusPill(status: SessionStatus): string {
  return `<span class="pill ${STATUS_CLASS[status]}">${esc(status)}</span>`;
}

/** Sub-line under the chain badge when broken — which chain(s) failed. Built only from the two
 * booleans (no overview data), so it needs no escaping of its own. */
function chainSubBroken(chains: { messagesOk: boolean; auditOk: boolean }): string {
  const msg = chains.messagesOk ? "verified" : "FAILED";
  const audit = chains.auditOk ? "verified" : "FAILED";
  return `Message chain: ${msg} · Audit chain: ${audit} — investigate before trusting this log.`;
}

// ── Table rows ───────────────────────────────────────────────────────────────────────────────
// Each row pairs a primary label with its id in small muted monospace underneath — a reviewer
// should never have to take a friendly name's word for it when the canonical id is one glance
// away.

function channelRow(c: Channel): string {
  const name = c.name ? esc(c.name) : MUTED_DASH;
  const marking = c.cuiMarking ? `<span class="pill pill-cui">${esc(c.cuiMarking)}</span>` : MUTED_DASH;
  return `              <tr>
                <td>${name}<div class="id mono">${esc(c.id)}</div></td>
                <td><span class="pill">${esc(c.kind)}</span></td>
                <td>${marking}</td>
                <td class="mono">${esc(fmtDate(c.createdAt))}</td>
              </tr>`;
}

function agentRow(a: Agent): string {
  const name = a.name ? esc(a.name) : MUTED_DASH;
  const model = a.model ? `<span class="mono">${esc(a.model)}</span>` : MUTED_DASH;
  return `              <tr>
                <td>${name}<div class="id mono">${esc(a.id)}</div></td>
                <td><span class="pill">${esc(a.kind)}</span></td>
                <td class="mono">${esc(a.ownerSub)}</td>
                <td>${model}</td>
              </tr>`;
}

function sessionRow(s: AgentSession, agentById: Map<string, Agent>): string {
  const agent = agentById.get(s.agentId);
  const agentLabel = agent?.name ? esc(agent.name) : MUTED_DASH;
  const host = s.runnerId
    ? `<span class="pill">${esc(s.hostType)}</span><div class="id mono">${esc(s.runnerId)}</div>`
    : `<span class="pill">${esc(s.hostType)}</span>`;
  return `              <tr>
                <td>${agentLabel}<div class="id mono">${esc(s.agentId)}</div></td>
                <td>${statusPill(s.status)}</td>
                <td>${host}</td>
                <td class="mono">${esc(fmtDate(s.leaseExpiresAt))}</td>
              </tr>`;
}

function auditRow(e: AuditEvent): string {
  const actAs = e.actAs ? `<span class="mono">${esc(e.actAs)}</span>` : MUTED_DASH;
  const target = e.target ? `<span class="mono">${esc(e.target)}</span>` : MUTED_DASH;
  const detail = e.detail ? esc(e.detail) : MUTED_DASH;
  return `              <tr>
                <td class="mono num">${esc(e.seq)}</td>
                <td class="mono">${esc(fmtDate(e.at))}</td>
                <td class="mono">${esc(e.actor)}</td>
                <td>${actAs}</td>
                <td><code class="action">${esc(e.action)}</code></td>
                <td>${target}</td>
                <td>${detail}</td>
              </tr>`;
}

// ── Panels (one per table) ──────────────────────────────────────────────────────────────────

function renderChannelsPanel(channels: readonly Channel[]): string {
  const body = channels.length ? channels.map(channelRow).join("\n") : `              ${emptyRow(4)}`;
  return `        <section class="panel">
          <h2>Channels</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">CUI Marking</th><th scope="col">Created</th></tr>
              </thead>
              <tbody>
${body}
              </tbody>
            </table>
          </div>
        </section>`;
}

function renderAgentsPanel(agents: readonly Agent[]): string {
  const body = agents.length ? agents.map(agentRow).join("\n") : `              ${emptyRow(4)}`;
  return `        <section class="panel">
          <h2>Agents</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Owner</th><th scope="col">Model</th></tr>
              </thead>
              <tbody>
${body}
              </tbody>
            </table>
          </div>
        </section>`;
}

function renderSessionsPanel(sessions: readonly AgentSession[], agentById: Map<string, Agent>): string {
  const body = sessions.length ? sessions.map((s) => sessionRow(s, agentById)).join("\n") : `              ${emptyRow(4)}`;
  return `        <section class="panel">
          <h2>Sessions</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Host</th><th scope="col">Lease Expires</th></tr>
              </thead>
              <tbody>
${body}
              </tbody>
            </table>
          </div>
        </section>`;
}

function renderAuditPanel(audit: readonly AuditEvent[]): string {
  const body = audit.length ? audit.map(auditRow).join("\n") : `              ${emptyRow(7)}`;
  return `        <section class="panel">
          <h2>Audit Trail</h2>
          <div class="table-wrap">
            <table class="audit-table">
              <thead>
                <tr><th scope="col">Seq</th><th scope="col">At</th><th scope="col">Actor</th><th scope="col">Act As</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
${body}
              </tbody>
            </table>
          </div>
        </section>`;
}

const STYLE = `
    :root {
      color-scheme: dark;
      --bg: #0b0d11;
      --surface: #151822;
      --surface-alt: #1b1f2b;
      --border: #262b38;
      --text: #e7e9ee;
      --text-muted: #8891a3;
      --text-faint: #5b6376;
      --accent: #aebb78;
      --accent-soft: rgba(174, 187, 120, 0.14);
      --ok: #3ddc84;
      --ok-bg: #10281c;
      --ok-border: #1f6b43;
      --bad: #ff6b6b;
      --bad-bg: #2e1414;
      --bad-border: #7a2e2e;
      --warn: #e8a33d;
      --warn-bg: #2c2110;
      --warn-border: #7a5620;
      --radius: 10px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--bg); color: var(--text);
      font-family: var(--sans); font-size: 15px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 28px 80px; }
    .mono { font-family: var(--mono); }
    .muted { color: var(--text-faint); }

    .page-header { margin-bottom: 28px; }
    .page-header h1 { margin: 0 0 6px; font-size: 26px; font-weight: 650; letter-spacing: -0.01em; }
    .page-header h1 .accent { color: var(--accent); }
    .subtitle { margin: 0; color: var(--text-muted); font-size: 14px; }

    .chain-badge {
      display: flex; align-items: center; gap: 18px;
      border-radius: var(--radius); border: 1px solid var(--border);
      padding: 20px 24px; margin-bottom: 32px;
    }
    .chain-icon {
      flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; line-height: 1;
    }
    .chain-title { font-size: 19px; font-weight: 700; letter-spacing: 0.01em; margin-bottom: 3px; }
    .chain-sub { color: var(--text-muted); font-size: 13.5px; }
    .chain-ok { background: var(--ok-bg); border-color: var(--ok-border); }
    .chain-ok .chain-icon { background: rgba(61, 220, 132, 0.15); color: var(--ok); }
    .chain-ok .chain-title { color: var(--ok); }
    .chain-broken {
      background: var(--bad-bg); border-color: var(--bad-border);
      animation: pulse-danger 2.2s ease-in-out infinite;
    }
    .chain-broken .chain-icon { background: rgba(255, 107, 107, 0.15); color: var(--bad); }
    .chain-broken .chain-title { color: var(--bad); }
    @keyframes pulse-danger {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 107, 0.35); }
      50% { box-shadow: 0 0 0 8px rgba(255, 107, 107, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .chain-broken { animation: none; }
    }

    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 40px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
    .card-label { color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 8px; }
    .card-value { font-size: 30px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }

    .panel { margin-bottom: 40px; }
    .panel h2 {
      font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text);
      margin: 0 0 12px; padding-left: 12px; border-left: 3px solid var(--accent);
    }
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    table.audit-table { min-width: 760px; }
    thead th {
      position: sticky; top: 0; background: var(--surface-alt); color: var(--text-muted);
      text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; text-align: left;
      padding: 11px 14px; border-bottom: 1px solid var(--border); white-space: nowrap;
    }
    tbody td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.015); }
    tbody tr:hover, tbody tr:nth-child(even):hover { background: var(--accent-soft); }
    td.num { text-align: right; }
    .id { color: var(--text-faint); font-size: 11.5px; margin-top: 2px; }
    .empty { text-align: center; color: var(--text-faint); font-style: italic; padding: 22px; }

    .pill {
      display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11.5px;
      border: 1px solid var(--border); color: var(--text-muted); background: var(--surface-alt);
      white-space: nowrap;
    }
    .pill-cui { border-color: var(--warn-border); background: var(--warn-bg); color: var(--warn); font-family: var(--mono); font-weight: 600; letter-spacing: 0.02em; }
    .pill-ok { border-color: var(--ok-border); background: var(--ok-bg); color: var(--ok); }
    .pill-warn { border-color: var(--warn-border); background: var(--warn-bg); color: var(--warn); }
    .pill-info { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
    .pill-muted { border-color: var(--border); background: var(--surface-alt); color: var(--text-faint); }
    code.action { font-family: var(--mono); color: var(--accent); background: var(--accent-soft); padding: 2px 6px; border-radius: 4px; font-size: 12.5px; }

    footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--text-faint); font-size: 12px; }

    @media (max-width: 560px) {
      .wrap { padding: 24px 16px 56px; }
      .chain-badge { flex-direction: column; align-items: flex-start; }
    }
`;

/** Render the full admin / audit-review console as one self-contained HTML document. Pure and
 * synchronous — no I/O, no client script required; every dynamic value is escaped via `esc()`. */
export function renderConsole(overview: AdminOverview): string {
  const chainsOk = overview.chains.messagesOk && overview.chains.auditOk;
  const agentById = new Map<string, Agent>(overview.agents.map((a): [string, Agent] => [a.id, a]));

  const badge = chainsOk
    ? `        <section class="chain-badge chain-ok" role="status">
          <div class="chain-icon" aria-hidden="true">✓</div>
          <div class="chain-copy">
            <div class="chain-title">Chains intact ✓</div>
            <div class="chain-sub">Message chain and audit chain both verified end-to-end. No tampering detected.</div>
          </div>
        </section>`
    : `        <section class="chain-badge chain-broken" role="alert">
          <div class="chain-icon" aria-hidden="true">⚠</div>
          <div class="chain-copy">
            <div class="chain-title">CHAIN BROKEN</div>
            <div class="chain-sub">${chainSubBroken(overview.chains)}</div>
          </div>
        </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>SecChat — Audit Review</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header class="page-header">
      <h1>SecChat <span class="accent">—</span> Audit Review</h1>
      <p class="subtitle">Generated <span class="mono">${esc(fmtDate(overview.generatedAt))}</span> · server-rendered snapshot</p>
    </header>

${badge}

    <section class="cards">
      <div class="card"><div class="card-label">Channels</div><div class="card-value">${esc(overview.channels.length)}</div></div>
      <div class="card"><div class="card-label">Agents</div><div class="card-value">${esc(overview.agents.length)}</div></div>
      <div class="card"><div class="card-label">Sessions</div><div class="card-value">${esc(overview.sessions.length)}</div></div>
      <div class="card"><div class="card-label">Audit Events</div><div class="card-value">${esc(overview.audit.length)}</div></div>
    </section>

${renderChannelsPanel(overview.channels)}

${renderAgentsPanel(overview.agents)}

${renderSessionsPanel(overview.sessions, agentById)}

${renderAuditPanel(overview.audit)}

    <footer>SecChat · SecRouter suite — rendered server-side, no external requests, no client script.</footer>
  </div>
</body>
</html>
`;
}
