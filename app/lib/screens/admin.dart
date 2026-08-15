import 'package:flutter/material.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/badges.dart';

/// The native admin / audit-review console (AU 3.3.5/6). Renders the same read-only snapshot the
/// server-rendered `/admin` page shows — chain integrity, channels, agents, sessions, the CUI
/// governance summary, and the audit trail — but built natively so it rides the app's
/// authenticated client (the HTML page can't carry the app's session token). Admin-only: reached
/// from an admin-only top-bar button, and the backend gates `GET /admin/api/overview` on the
/// `secchat-admins` group regardless.
class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  AdminOverview? _overview;
  PoolStatus? _pool;
  AdminSshKeys? _sshKeys;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final overview = await widget.api.getAdminOverview();
      // The pool + SSH-key panels are best-effort: a hiccup on either endpoint must not blank the
      // whole console, which is the primary audit-review surface. Null ⇒ that panel is simply omitted.
      PoolStatus? pool;
      try {
        pool = await widget.api.getPoolStatus();
      } catch (_) {
        pool = null;
      }
      AdminSshKeys? sshKeys;
      try {
        sshKeys = await widget.api.getAdminSshKeys();
      } catch (_) {
        sshKeys = null;
      }
      if (!mounted) return;
      setState(() {
        _overview = overview;
        _pool = pool;
        _sshKeys = sshKeys;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error is ApiException ? error.message : 'Failed to load the admin console.';
        _loading = false;
      });
    }
  }

  /// Admin-revoke a user's git SSH key: confirm, call the API, then reload the roster. Failures
  /// surface as a snackbar; the console isn't blanked.
  Future<void> _revokeKey(String sub, String label) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Revoke git SSH key?', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: Text(
          "This drops $label's git key so it stops being injected into future coding sessions. "
          'The public key should also be removed from the git host. This cannot be undone.',
          style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted))),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Revoke', style: TextStyle(color: AppColors.bad))),
        ],
      ),
    );
    if (confirmed != true) return;
    String? failure;
    try {
      await widget.api.revokeAdminSshKey(sub);
    } catch (error) {
      failure = error is ApiException ? error.message : 'Failed to revoke the key.';
    }
    if (!mounted) return;
    if (failure != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(failure)));
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.surface,
        elevation: 0,
        shape: const Border(bottom: BorderSide(color: AppColors.border)),
        title: const Text(
          'Admin console',
          style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w600),
        ),
        iconTheme: const IconThemeData(color: AppColors.textMuted),
        actions: [
          IconButton(
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh, size: 18),
            tooltip: 'Refresh',
            color: AppColors.textMuted,
          ),
          const SizedBox(width: 6),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: AppColors.accent));
    }
    if (_error != null) {
      return _ErrorState(message: _error!, onRetry: _load);
    }
    final overview = _overview!;
    final agentById = {for (final a in overview.agents) a.id: a};
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 24, 24, 64),
      children: [
        _ChainBadge(overview: overview),
        const SizedBox(height: 24),
        _SummaryCards(overview: overview),
        const SizedBox(height: 28),
        _GovernancePanel(audit: overview.audit),
        const SizedBox(height: 28),
        _ChannelsPanel(channels: overview.channels),
        const SizedBox(height: 28),
        _AgentsPanel(agents: overview.agents),
        const SizedBox(height: 28),
        _SessionsPanel(sessions: overview.sessions, agentById: agentById),
        if (_pool != null) ...[
          const SizedBox(height: 28),
          _PoolPanel(pool: _pool!),
        ],
        if (_sshKeys != null) ...[
          const SizedBox(height: 28),
          _SshKeysPanel(sshKeys: _sshKeys!, onRevoke: _revokeKey),
        ],
        const SizedBox(height: 28),
        _AuditPanel(audit: overview.audit),
        const SizedBox(height: 20),
        if (overview.generatedAt.isNotEmpty)
          Text(
            'Snapshot generated ${_fmtDate(overview.generatedAt)}',
            style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint),
          ),
      ],
    );
  }
}

/// UTC, timezone-unambiguous — matches the server-rendered console's formatting. Falls back to the
/// raw string for anything unparseable rather than printing garbage.
String _fmtDate(String iso) {
  final d = DateTime.tryParse(iso);
  if (d == null) return iso;
  final u = d.toUtc();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${u.year}-${two(u.month)}-${two(u.day)} ${two(u.hour)}:${two(u.minute)}:${two(u.second)} UTC';
}

class _ChainBadge extends StatelessWidget {
  const _ChainBadge({required this.overview});

  final AdminOverview overview;

  @override
  Widget build(BuildContext context) {
    final ok = overview.chainsOk;
    final sub = ok
        ? 'Message chain and audit chain both verified end-to-end. No tampering detected.'
        : 'Message chain: ${overview.messagesChainOk ? "verified" : "FAILED"} · '
              'Audit chain: ${overview.auditChainOk ? "verified" : "FAILED"} — investigate before trusting this log.';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      decoration: BoxDecoration(
        color: ok ? AppColors.okBg : AppColors.badBg,
        border: Border.all(color: ok ? AppColors.okBorder : AppColors.badBorder),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(ok ? Icons.verified_user : Icons.gpp_bad, color: ok ? AppColors.ok : AppColors.bad, size: 26),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  ok ? 'Chains intact' : 'CHAIN BROKEN',
                  style: TextStyle(
                    color: ok ? AppColors.ok : AppColors.bad,
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.2,
                  ),
                ),
                const SizedBox(height: 4),
                Text(sub, style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SummaryCards extends StatelessWidget {
  const _SummaryCards({required this.overview});

  final AdminOverview overview;

  @override
  Widget build(BuildContext context) {
    final activeSessions = overview.sessions.where((s) => s.status == 'active' || s.status == 'starting').length;
    final cards = [
      ('Channels', overview.channels.length.toString()),
      ('Agents', overview.agents.length.toString()),
      ('Live sessions', activeSessions.toString()),
      ('Audit events', overview.audit.length.toString()),
    ];
    return Wrap(
      spacing: 14,
      runSpacing: 14,
      children: [
        for (final (label, value) in cards)
          Container(
            width: 168,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            decoration: BoxDecoration(
              color: AppColors.surface,
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label.toUpperCase(),
                  style: const TextStyle(
                    color: AppColors.textMuted,
                    fontSize: 11,
                    letterSpacing: 0.6,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  value,
                  style: const TextStyle(color: AppColors.accent, fontSize: 28, fontWeight: FontWeight.w700),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// The CUI-lifecycle governance summary — the compliance headline, mirroring the server console's
/// tiles + counts (redactions, DLP flags, classification changes, message edits).
class _GovernancePanel extends StatelessWidget {
  const _GovernancePanel({required this.audit});

  final List<AuditEvent> audit;

  static const _categories = [
    ('message.redact', 'Redactions', AppColors.bad),
    ('message.dlp_flag', 'DLP spillage flags', AppColors.warn),
    ('channel.mark', 'Classification changes', AppColors.accent),
    ('message.edit', 'Message edits', AppColors.accent),
  ];

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Governance & CUI controls',
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          for (final (action, label, color) in _categories)
            Container(
              width: 190,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(
                color: AppColors.surfaceAlt,
                border: Border(left: BorderSide(color: color, width: 3)),
                borderRadius: BorderRadius.circular(AppRadius.sm),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    audit.where((e) => e.action == action).length.toString(),
                    style: TextStyle(color: color, fontSize: 26, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Text(label, style: const TextStyle(color: AppColors.text, fontSize: 13, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ChannelsPanel extends StatelessWidget {
  const _ChannelsPanel({required this.channels});

  final List<AdminChannel> channels;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Channels',
      child: _DataTable(
        minWidth: 540,
        headers: const ['Name', 'Kind', 'CUI Marking', 'Created'],
        widths: const [3, 1, 2, 2],
        rows: [
          for (final c in channels)
            [
              _cellWithId(c.name ?? '—', c.id),
              _pill(c.kind),
              c.cuiMarking == null ? _muted() : _pill(c.cuiMarking!, tone: AppColors.warn),
              _mono(_fmtDate(c.createdAt)),
            ],
        ],
      ),
    );
  }
}

class _AgentsPanel extends StatelessWidget {
  const _AgentsPanel({required this.agents});

  final List<AdminAgent> agents;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Agents',
      child: _DataTable(
        minWidth: 540,
        headers: const ['Name', 'Kind', 'Owner', 'Model'],
        widths: const [3, 1, 2, 2],
        rows: [
          for (final a in agents)
            [
              _cellWithId(a.name ?? '—', a.id),
              _pill(a.kind),
              _mono(a.ownerSub),
              a.model == null ? _muted() : _mono(a.model!),
            ],
        ],
      ),
    );
  }
}

class _SessionsPanel extends StatelessWidget {
  const _SessionsPanel({required this.sessions, required this.agentById});

  final List<AdminSession> sessions;
  final Map<String, AdminAgent> agentById;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Sessions',
      child: _DataTable(
        minWidth: 540,
        headers: const ['Agent', 'Status', 'Host', 'Lease expires'],
        widths: const [3, 1, 2, 2],
        rows: [
          for (final s in sessions)
            [
              _cellWithId(agentById[s.agentId]?.name ?? '—', s.agentId),
              _statusPill(s.status),
              s.runnerId == null ? _pill(s.hostType) : _cellWithId(s.hostType, s.runnerId!, pillLabel: true),
              _mono(_fmtDate(s.leaseExpiresAt)),
            ],
        ],
      ),
    );
  }
}

/// The Kubernetes agent-pool panel: the deployment's caps + the live pooled sessions (metadata
/// only). Shows an informational note when no pool is configured, so an admin can tell "off" apart
/// from "on with zero sessions". Read-only — the limits come from the deploy config
/// (SECCHAT_POOL_* / secsite.toml [secchat.pool]); changing them is a redeploy, not a GUI action.
class _PoolPanel extends StatelessWidget {
  const _PoolPanel({required this.pool});

  final PoolStatus pool;

  @override
  Widget build(BuildContext context) {
    if (!pool.configured) {
      return const _Panel(
        title: 'Agent pool',
        child: Text(
          'No Kubernetes agent pool is configured for this deployment.',
          style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic, fontSize: 13),
        ),
      );
    }
    final limits = pool.limits;
    final live = pool.live ?? pool.sessions.length;
    final meta = [
      if (pool.namespace != null && pool.namespace!.isNotEmpty) 'namespace ${pool.namespace}',
      if (pool.image != null && pool.image!.isNotEmpty) 'image ${pool.image}',
    ].join(' · ');
    return _Panel(
      title: 'Agent pool',
      note: meta.isEmpty ? null : meta,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 14,
            runSpacing: 14,
            children: [
              _poolCard('Live / max pods', limits == null ? '$live' : '$live / ${limits.maxPods}',
                  emphasize: limits != null && limits.maxPods > 0 && live >= limits.maxPods),
              _poolCard('Per-owner cap', limits == null ? '—' : '${limits.maxPerOwner}'),
              _poolCard('Pod TTL', limits == null ? '—' : _fmtDuration(limits.ttlSeconds)),
              _poolCard('Attach timeout', limits == null ? '—' : _fmtDuration((limits.attachTimeoutMs / 1000).round())),
            ],
          ),
          const SizedBox(height: 16),
          _DataTable(
            minWidth: 540,
            headers: const ['Owner', 'Pod', 'State', 'Age'],
            widths: const [2, 3, 1, 1],
            rows: [
              for (final s in pool.sessions)
                [
                  _mono(s.ownerSub),
                  _mono(s.podName),
                  s.attached ? _statusPill('active') : _pill('starting', tone: AppColors.warn),
                  _mono(_fmtAge(s.ageMs)),
                ],
            ],
          ),
        ],
      ),
    );
  }
}

/// A small labeled metric card (mirrors _SummaryCards' style). `emphasize` colours the value as a
/// warning — used when the pool is at its global cap (new sessions will be rejected).
Widget _poolCard(String label, String value, {bool emphasize = false}) => Container(
  width: 168,
  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
  decoration: BoxDecoration(
    color: AppColors.surface,
    border: Border.all(color: AppColors.border),
    borderRadius: BorderRadius.circular(AppRadius.sm),
  ),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label.toUpperCase(),
        style: const TextStyle(color: AppColors.textMuted, fontSize: 11, letterSpacing: 0.6, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 8),
      Text(
        value,
        style: TextStyle(color: emphasize ? AppColors.warn : AppColors.accent, fontSize: 22, fontWeight: FontWeight.w700),
      ),
    ],
  ),
);

/// A whole-seconds duration as a compact "1h 0m" / "5m 30s" / "45s".
String _fmtDuration(int seconds) {
  if (seconds >= 3600) return '${seconds ~/ 3600}h ${(seconds % 3600) ~/ 60}m';
  if (seconds >= 60) return '${seconds ~/ 60}m ${seconds % 60}s';
  return '${seconds}s';
}

/// A pod's age (ms since start) as a compact duration.
String _fmtAge(int ms) => _fmtDuration((ms / 1000).round());

/// The git SSH key roster (admin-only, `GET /admin/api/ssh-keys`): who has a git identity registered
/// — public metadata only (owner, fingerprint, added-at), never the private key — with an admin
/// revoke action per row (offboarding / compromise). Shows a note when the feature isn't enabled.
class _SshKeysPanel extends StatelessWidget {
  const _SshKeysPanel({required this.sshKeys, required this.onRevoke});

  final AdminSshKeys sshKeys;
  final Future<void> Function(String sub, String label) onRevoke;

  @override
  Widget build(BuildContext context) {
    if (!sshKeys.enabled && sshKeys.keys.isEmpty) {
      return const _Panel(
        title: 'Git SSH keys',
        child: Text(
          "Git SSH identities aren't enabled for this deployment.",
          style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic, fontSize: 13),
        ),
      );
    }
    return _Panel(
      title: 'Git SSH keys',
      note: sshKeys.enabled ? null : 'Feature disabled — existing keys are shown so they can be revoked.',
      child: _DataTable(
        minWidth: 540,
        headers: const ['User', 'Fingerprint', 'Added', ''],
        widths: const [2, 3, 2, 1],
        rows: [
          for (final k in sshKeys.keys)
            [
              _cellWithId(k.displayName ?? k.sub, k.sub),
              _mono(k.fingerprint),
              _mono(_fmtDate(k.createdAt)),
              // An icon (not a text button): on a 390pt phone this table renders full-width and the
              // flex-1 trailing column gets ~43pt — a "Revoke" TextButton (~60pt intrinsic) overflows
              // it. The icon fits any width and is a proper touch target.
              Align(
                alignment: Alignment.centerRight,
                child: IconButton(
                  onPressed: () => onRevoke(k.sub, k.displayName ?? k.sub),
                  icon: const Icon(Icons.delete_outline, size: 18),
                  tooltip: 'Revoke',
                  color: AppColors.bad,
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                ),
              ),
            ],
        ],
      ),
    );
  }
}

class _AuditPanel extends StatelessWidget {
  const _AuditPanel({required this.audit});

  final List<AuditEvent> audit;

  static const _maxRows = 200;

  @override
  Widget build(BuildContext context) {
    // Newest first, capped — a full trail can be long; the count note flags any truncation.
    final events = audit.reversed.take(_maxRows).toList();
    final truncated = audit.length > _maxRows;
    return _Panel(
      title: 'Audit trail',
      note: truncated ? 'Showing the $_maxRows most recent of ${audit.length} events.' : null,
      // minWidth (not a fixed 900 wrapper): fills a wide admin window, scrolls sideways on a phone.
      child: _DataTable(
        minWidth: 900,
        headers: const ['Seq', 'At', 'Actor', 'Act as', 'Action', 'Target', 'Detail'],
        widths: const [1, 3, 2, 2, 2, 2, 3],
        rows: [
          for (final e in events)
            [
              _mono(e.seq.toString()),
              _mono(_fmtDate(e.at)),
              _mono(e.actor),
              e.actAs == null ? _muted() : _mono(e.actAs!),
              _actionCode(e.action),
              e.target == null ? _muted() : _mono(e.target!),
              e.detail == null ? _muted() : Text(e.detail!, style: const TextStyle(color: AppColors.text, fontSize: 12.5)),
            ],
        ],
      ),
    );
  }
}

// ── Shared building blocks ─────────────────────────────────────────────────────────────────

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.child, this.note});

  final String title;
  final String? note;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.only(left: 12),
          decoration: const BoxDecoration(border: Border(left: BorderSide(color: AppColors.accent, width: 3))),
          child: Text(
            title.toUpperCase(),
            style: const TextStyle(color: AppColors.text, fontSize: 13, letterSpacing: 0.6, fontWeight: FontWeight.w700),
          ),
        ),
        if (note != null) ...[
          const SizedBox(height: 6),
          Text(note!, style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
        ],
        const SizedBox(height: 12),
        child,
      ],
    );
  }
}

/// A lightweight table: a header row + body rows over a bordered surface. Each column's flex is
/// given by [widths]. Cells are arbitrary widgets (built via the `_cell*` helpers below).
class _DataTable extends StatelessWidget {
  const _DataTable({required this.headers, required this.widths, required this.rows, this.minWidth});

  final List<String> headers;
  final List<int> widths;
  final List<List<Widget>> rows;

  /// Minimum content width. When the viewport is narrower (a phone), the table keeps this width
  /// inside its own horizontal scroll instead of char-wrapping every mono token (fingerprints,
  /// subs, pod names) into unreadable multi-line cells. Null ⇒ always fit the viewport.
  final double? minWidth;

  @override
  Widget build(BuildContext context) {
    final table = _buildTable();
    if (minWidth == null) return table;
    return LayoutBuilder(
      builder: (context, constraints) {
        // Wide enough: render normally (the scroll never engages). Narrow: pin the table at
        // minWidth and let it scroll sideways — mirrors the audit table's fixed-width wrapper, but
        // only when actually needed.
        final width = constraints.maxWidth >= minWidth! ? constraints.maxWidth : minWidth!;
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(width: width, child: table),
        );
      },
    );
  }

  Widget _buildTable() {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Column(
        children: [
          Container(
            decoration: const BoxDecoration(
              color: AppColors.surfaceAlt,
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                for (var i = 0; i < headers.length; i++)
                  Expanded(
                    flex: widths[i],
                    child: Text(
                      headers[i].toUpperCase(),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11, letterSpacing: 0.5, fontWeight: FontWeight.w600),
                    ),
                  ),
              ],
            ),
          ),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 22),
              child: Text('none', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic)),
            )
          else
            for (var r = 0; r < rows.length; r++)
              Container(
                decoration: BoxDecoration(
                  border: r == rows.length - 1 ? null : const Border(bottom: BorderSide(color: AppColors.borderSoft)),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (var i = 0; i < rows[r].length; i++)
                      Expanded(flex: widths[i], child: rows[r][i]),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

Widget _cellWithId(String label, String id, {bool pillLabel = false}) => Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    pillLabel ? _pill(label) : Text(label, style: const TextStyle(color: AppColors.text, fontSize: 13)),
    const SizedBox(height: 2),
    Text(shortId(id), style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint)),
  ],
);

Widget _mono(String text) => Text(text, style: AppFonts.mono(fontSize: 12, color: AppColors.textMuted));

Widget _muted() => const Text('—', style: TextStyle(color: AppColors.textFaint));

Widget _pill(String label, {Color tone = AppColors.textMuted}) => Align(
  alignment: Alignment.centerLeft,
  child: PillBadge(label, color: tone, background: AppColors.surfaceAlt, borderColor: AppColors.border),
);

Widget _statusPill(String status) {
  final (color, bg, border) = switch (status) {
    'active' => (AppColors.ok, AppColors.okBg, AppColors.okBorder),
    'orphaned' => (AppColors.warn, AppColors.warnBg, AppColors.warnBorder),
    'ended' => (AppColors.textFaint, AppColors.surfaceAlt, AppColors.border),
    _ => (AppColors.accent, AppColors.accentSoft, AppColors.accentBorder),
  };
  return Align(alignment: Alignment.centerLeft, child: PillBadge(status, color: color, background: bg, borderColor: border));
}

Widget _actionCode(String action) => Align(
  alignment: Alignment.centerLeft,
  child: Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(color: AppColors.accentSoft, borderRadius: BorderRadius.circular(4)),
    child: Text(action, style: AppFonts.mono(fontSize: 11.5, color: AppColors.accent)),
  ),
);

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: AppColors.bad, size: 30),
          const SizedBox(height: 12),
          Text(message, style: const TextStyle(color: AppColors.textMuted, fontSize: 14)),
          const SizedBox(height: 16),
          TextButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh, size: 16, color: AppColors.accent),
            label: const Text('Retry', style: TextStyle(color: AppColors.accent)),
          ),
        ],
      ),
    );
  }
}
