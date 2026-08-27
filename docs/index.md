# SecChat docs

SecChat is the SecRouter suite's auditable team + agentic chat: channels and DMs with a
tamper-evident hash chain, classification marking + DLP, governed coding/assistant agents, voice
and video calling, and an admin/audit-review console — packaged as a Docker Compose stack (see the
[README](../README.md) for the quickstart).

- **[configuration.md](configuration.md)** — every `SECCHAT_*` (and related) environment
  variable SecChat's server reads: name, default, and what it does.
- **[usage.md](usage.md)** — a user-facing tour: channels/DMs and markings, coding + assistant
  agents, voice/video calls and memos, the admin console, webhooks, and per-user git SSH keys.
- **[security.md](security.md)** — the auth model (SecSSO OIDC + the session BFF), the two
  tamper-evident hash chains, the marking/DLP model, the governed-LLM path, and step-up
  re-authentication.
- **[compliance/cmmc-control-matrix.md](compliance/cmmc-control-matrix.md)** — the CMMC Level 2 /
  NIST SP 800-171 control mapping, what's enforced in code vs. shared with the environment, and
  how to pull a live evidence bundle.
- **[agent-pool.md](agent-pool.md)** — the optional Kubernetes agent pool: coding agents that run
  in a server-launched pod instead of the user's desktop.
- **[git-ssh-keys.md](git-ssh-keys.md)** — optional per-user git SSH identities injected into
  coding-agent runtimes.
- **[runner-daemon.md](runner-daemon.md)** — the standalone runner daemon that attaches a coding
  agent's execution environment to SecChat from any machine.

Voice/video calling's deploy-side wiring (the `secchat-mediad` relay + SecRecorder) is documented
in [SecDeploy's `docs/voice.md`](https://github.com/secrouter/secdeploy/blob/main/docs/voice.md),
not duplicated here; the calling feature itself is covered in [usage.md](usage.md) and the
[README](../README.md#voice--video-calling). The design rationale for both voice and video lives in
`docs/plans/` (`voice-calls-plan.md`, `voice-contracts.md`) — internal working documents, not part
of this index.
