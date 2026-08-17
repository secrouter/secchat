package session

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const mixedFileName = "mixed.m4a"

// sessionIDPattern is mediad's own session id shape ("sess_" + uuid.NewString(), manager.go's
// CreateSession) — the ONLY sessionIDs that legitimately exist on disk. DELETE /sessions/:id's
// path value reaches recoverFromDisk unvalidated (Go 1.22's ServeMux PathValue decodes %2F, so a
// control-API caller can send "..%2F.." segments): without this check, filepath.Join(RecordingsDir,
// sessionID) can escape the recordings volume entirely (docs/plans/voice-contracts.md §4: "treat
// [the session id] as untrusted anyway"). Anything that doesn't match this shape is rejected as
// not-found before it ever touches the filesystem.
var sessionIDPattern = regexp.MustCompile(`^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validSessionID(id string) bool {
	return sessionIDPattern.MatchString(id)
}

// EndSession finalizes a session (docs/plans/voice-contracts.md §2.4): closes both writers
// (flushing the last OGG page each), runs the ffmpeg mix step, and returns the manifest.
// Idempotent — a second call on an already-ended session (routed through recoverFromDisk once
// this process has forgotten it) returns the SAME manifest read from disk UNLESS that manifest
// has both legs but no mixed entry, in which case it retries the ffmpeg mix first
// (remixIfMissing) rather than echoing the same legs-only manifest forever; this is what backs
// the backend's crash-recovery reconciliation sweep, v3.1 REQUIRED #5.
func (m *Manager) EndSession(sessionID string) (Manifest, error) {
	if s, ok := m.Get(sessionID); ok {
		manifest, err := s.finalize(false)
		if err == nil {
			m.forget(sessionID)
		}

		return manifest, err
	}

	// Not live in this process — either already finalized earlier (idempotent re-DELETE) or
	// mediad restarted after a crash. Either way, the session directory + manifest.json on disk
	// is the source of truth per docs/plans/voice-contracts.md §4. Validate before recoverFromDisk
	// does anything with the filesystem — an in-memory miss is the common case for a hostile id
	// too (it was never a real session), so this also covers that path with the SAME check.
	if !validSessionID(sessionID) {
		return Manifest{}, ErrSessionNotFound
	}

	return m.recoverFromDisk(sessionID)
}

// finalize runs the real (in-memory) finalize path: stop forwarding, close both legs' PCs and
// recorders, mix, write manifest.json. forced marks a janitor-driven finalize (the session
// exceeded activeDeadline without a clean client DELETE) as truncated.
func (s *Session) finalize(forced bool) (Manifest, error) {
	s.mu.Lock()
	if s.ended {
		manifest := *s.manifest
		s.mu.Unlock()

		return manifest, nil
	}
	s.ended = true
	legs := make([]*leg, 0, len(s.legs))
	for _, legID := range s.legOrder {
		if l, ok := s.legs[legID]; ok {
			legs = append(legs, l)
		}
	}
	s.mu.Unlock()

	close(s.stopRTCP)
	s.closePeerConnections()

	files := make([]ManifestFile, 0, len(legs)+1)
	for _, l := range legs {
		durationMs, err := l.rec.Close()
		l.mu.Lock()
		l.durationMs = durationMs
		l.recErr = err
		l.mu.Unlock()
		files = append(files, ManifestFile{
			LegID:         l.id,
			Path:          filepath.Base(l.path),
			StartOffsetMs: l.rec.StartOffsetMs(),
			DurationMs:    durationMs,
		})
	}

	mixedPath := filepath.Join(s.dir, mixedFileName)
	mixedDurationMs, mixErr := mixLegs(s.mgr.cfg.FfmpegPath, legs, mixedPath)
	if mixErr != nil {
		// v3.1 suggested #3: an ffmpeg hiccup must not discard the (already-written-to-disk)
		// legs-only manifest, return a 500, and strand the session in the live table (it only
		// leaves via forget(), which used to run on success only — counting against SessionCap
		// forever, since the backend never retries DELETE). Log it and fall through: the manifest
		// below simply has no mixed.m4a entry, which is exactly the signal the backend's
		// reconciliation sweep needs to notice and handle (§2.4 REQUIRED #5's on-disk manifest is
		// still authoritative; a missing mixed entry is a valid manifest shape, not corruption).
		slog.Error("mediad: ffmpeg mix failed, finalizing with a legs-only manifest",
			"session", s.id, "err", mixErr)
	} else {
		files = append(files, ManifestFile{Path: mixedFileName, StartOffsetMs: 0, DurationMs: mixedDurationMs})
	}

	manifest := Manifest{SessionID: s.id, Files: files, Truncated: forced}

	if err := writeManifest(s.dir, manifest); err != nil {
		return Manifest{}, fmt.Errorf("session: write manifest: %w", err)
	}

	s.mu.Lock()
	m := manifest
	s.manifest = &m
	s.mu.Unlock()

	return manifest, nil
}

// mixLegs runs ffmpeg's amix over the two legs' Ogg files, delaying whichever leg started later
// (per its StartOffsetMs) so the mixed output has both participants aligned in real time —
// docs/plans/voice-contracts.md §2.4's "mixed file's own startOffsetMs is always 0 (ffmpeg's
// amix output starts at the earliest leg, padding the other)". Returns the mixed file's
// duration in ms (computed analytically from the two legs' offsets/durations rather than
// re-probing the output, since ffmpeg's own timeline arithmetic is exactly what this mirrors).
// Shared by the live finalize path (legs carry a *recorder.Leg) and remixFromDisk's crash-
// recovery path (legs carry only a startOffsetMs field recovered from the offsets.json sidecar,
// v3.1 suggested #6) — leg.legStartOffsetMs() abstracts the difference.
func mixLegs(ffmpegPath string, legs []*leg, outPath string) (int64, error) {
	if len(legs) < 1 || len(legs) > 2 {
		return 0, fmt.Errorf("session: mix requires one or two legs, got %d", len(legs))
	}

	// Solo self-DM voice memo: a single leg has nothing to mix — just transcode it to the playback
	// file (same AAC output shape a 2-leg mix produces, so the manifest's mixed entry + the backend's
	// ingest are identical for both).
	if len(legs) == 1 {
		l := legs[0]
		//nolint:gosec // ffmpegPath is operator-configured; leg path is a server-generated session-dir filename
		cmd := exec.Command(ffmpegPath, "-y", "-i", l.path, "-c:a", "aac", outPath)
		var stderr strings.Builder
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return 0, fmt.Errorf("session: ffmpeg transcode failed: %w: %s", err, stderr.String())
		}
		return l.durationMs, nil
	}

	a, b := legs[0], legs[1]
	startA, startB := a.legStartOffsetMs(), b.legStartOffsetMs()
	minStart := startA
	if startB < minStart {
		minStart = startB
	}
	delayA := startA - minStart
	delayB := startB - minStart

	filter := fmt.Sprintf(
		"[0:a]adelay=%d|%d[a0];[1:a]adelay=%d|%d[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
		delayA, delayA, delayB, delayB,
	)

	//nolint:gosec // ffmpegPath is operator-configured; leg paths are server-generated session-dir filenames
	cmd := exec.Command(ffmpegPath, "-y", "-i", a.path, "-i", b.path, "-filter_complex", filter, "-map", "[aout]", "-c:a", "aac", outPath)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("session: ffmpeg mix failed: %w: %s", err, stderr.String())
	}

	endA := startA + a.durationMs
	endB := startB + b.durationMs
	maxEnd := endA
	if endB > maxEnd {
		maxEnd = endB
	}

	return maxEnd - minStart, nil
}

func writeManifest(dir string, m Manifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o640) //nolint:gosec // recordings dir, not world-readable
}

// recoverFromDisk handles DELETE /sessions/:id for a sessionId this process has no in-memory
// Session for: either a genuinely unknown id (404), an already-finalized session from earlier in
// THIS process's lifetime that was already forgotten (manifest.json present — return it, retrying
// the ffmpeg mix first via remixIfMissing if it never produced a mixed.m4a, v3.1 suggested #3's
// follow-on), or a session that outlived a mediad crash/restart (leg .ogg files present, no
// manifest.json — best-effort re-finalize). sessionID is validated (not just via EndSession's
// check — this method has its own untrusted-input boundary too, docs/plans/voice-contracts.md §4)
// before any path is built from it.
func (m *Manager) recoverFromDisk(sessionID string) (Manifest, error) {
	if !validSessionID(sessionID) {
		return Manifest{}, ErrSessionNotFound
	}

	dir := filepath.Join(m.cfg.RecordingsDir, sessionID)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return Manifest{}, ErrSessionNotFound
	}

	manifestPath := filepath.Join(dir, "manifest.json")
	if data, err := os.ReadFile(manifestPath); err == nil { //nolint:gosec // sessionID validated above
		var manifest Manifest
		if err := json.Unmarshal(data, &manifest); err == nil {
			return m.remixIfMissing(sessionID, dir, manifest)
		}
	}

	return m.remixFromDisk(sessionID, dir)
}

// remixIfMissing re-attempts the ffmpeg mix for a manifest that's already on disk but has no
// mixed.m4a entry — the case where finalize's live ffmpeg mix failed (v3.1 suggested #3 covers
// writing that legs-only manifest instead of a 500; this closes the retry loop it otherwise left
// open). Without this, EVERY subsequent DELETE on a mix-failed session just echoes the SAME
// legs-only manifest back from disk forever: the backend's reconcileOneCall treats a manifest
// with no mixed entry as nothing-to-ingest and returns without transcribing, even though both leg
// files are sitting right there, and the call never leaves the reconciliation candidate set.
// Reuses the leg entries' own persisted Path/StartOffsetMs/DurationMs from the manifest — they're
// already correct from the original finalize, unlike remixFromDisk's from-scratch
// reconstruction (which exists for the no-manifest-at-all crash case and still re-probes/reads
// the offsets sidecar). A manifest that already has a mixed entry, or doesn't have exactly two
// leg entries, is returned unchanged (nothing to retry).
func (m *Manager) remixIfMissing(sessionID, dir string, manifest Manifest) (Manifest, error) {
	var legFiles []ManifestFile
	for _, f := range manifest.Files {
		if f.LegID == "" {
			if f.Path == mixedFileName {
				return manifest, nil // already mixed — nothing to do
			}

			continue
		}
		legFiles = append(legFiles, f)
	}
	if len(legFiles) != 2 {
		return manifest, nil // not the legs-present/mixed-missing shape this retry handles
	}

	legs := make([]*leg, len(legFiles))
	for i, f := range legFiles {
		legs[i] = &leg{id: f.LegID, path: filepath.Join(dir, f.Path), durationMs: f.DurationMs, startOffsetMs: f.StartOffsetMs}
	}

	mixedPath := filepath.Join(dir, mixedFileName)
	mixedDurationMs, err := mixLegs(m.cfg.FfmpegPath, legs, mixedPath)
	if err != nil {
		slog.Error("mediad: retry ffmpeg mix still failing, finalizing with a legs-only manifest",
			"session", sessionID, "err", err)

		return manifest, nil // unchanged on disk; the NEXT DELETE retries again
	}

	updated := manifest
	updated.Files = append(append([]ManifestFile{}, manifest.Files...),
		ManifestFile{Path: mixedFileName, StartOffsetMs: 0, DurationMs: mixedDurationMs})
	if err := writeManifest(dir, updated); err != nil {
		return Manifest{}, fmt.Errorf("session: write remixed manifest: %w", err)
	}

	return updated, nil
}

// remixFromDisk handles the mid-finalize-crash case: leg .ogg files exist but manifest.json (and
// possibly mixed.m4a) does not. Re-runs the ffmpeg mix and writes the manifest, marked
// truncated: true (docs/plans/voice-contracts.md §2.4: "mediad restarted mid-call"). Per-leg
// startOffsetMs comes from the offsets.json sidecar (v3.1 suggested #6) written incrementally as
// each leg's first packet arrived — the in-memory-only value that a crash would otherwise lose
// entirely, silently mis-aligning the merged transcript for exactly the truncated-call case this
// path exists for. A leg missing from the sidecar (e.g. it never received a first packet before
// the sidecar itself failed to write, or the sidecar predates this fix) falls back to 0, same as
// before.
func (m *Manager) remixFromDisk(sessionID, dir string) (Manifest, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Manifest{}, fmt.Errorf("session: read session dir: %w", err)
	}

	var legPaths []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".ogg") {
			legPaths = append(legPaths, filepath.Join(dir, e.Name()))
		}
	}
	if len(legPaths) == 0 {
		return Manifest{}, fmt.Errorf("session: %w: no leg recordings found in %s", ErrSessionNotFound, dir)
	}

	offsets := readOffsetsSidecar(dir)

	files := make([]ManifestFile, 0, len(legPaths)+1)
	recovered := make([]*leg, 0, len(legPaths))
	for _, p := range legPaths {
		durationMs, err := probeDurationMs(m.cfg.FfmpegPath, p)
		if err != nil {
			durationMs = 0
		}
		legID := strings.TrimSuffix(filepath.Base(p), ".ogg")
		startOffsetMs := offsets.Legs[legID]
		files = append(files, ManifestFile{LegID: legID, Path: filepath.Base(p), StartOffsetMs: startOffsetMs, DurationMs: durationMs})
		recovered = append(recovered, &leg{id: legID, path: p, durationMs: durationMs, startOffsetMs: startOffsetMs, rec: nil})
	}

	if len(recovered) == 2 {
		mixedPath := filepath.Join(dir, mixedFileName)
		if mixedDurationMs, err := mixLegs(m.cfg.FfmpegPath, recovered, mixedPath); err != nil {
			slog.Error("mediad: recovery ffmpeg mix failed, finalizing with a legs-only manifest",
				"session", sessionID, "err", err)
		} else {
			files = append(files, ManifestFile{Path: mixedFileName, StartOffsetMs: 0, DurationMs: mixedDurationMs})
		}
	}

	manifest := Manifest{SessionID: sessionID, Files: files, Truncated: true}
	if err := writeManifest(dir, manifest); err != nil {
		return Manifest{}, fmt.Errorf("session: write recovered manifest: %w", err)
	}

	return manifest, nil
}

// probeDurationMs shells out to ffprobe (co-installed with ffmpeg in the mediad image) to read
// an existing Ogg file's duration when no in-memory recorder.Leg survives to report it.
func probeDurationMs(ffmpegPath, path string) (int64, error) {
	ffprobePath := strings.TrimSuffix(ffmpegPath, "ffmpeg") + "ffprobe"

	//nolint:gosec // ffprobePath is derived from operator config; path is a session-dir filename on disk
	cmd := exec.Command(ffprobePath, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path)
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("session: ffprobe: %w", err)
	}

	var seconds float64
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%f", &seconds); err != nil {
		return 0, fmt.Errorf("session: parse ffprobe duration: %w", err)
	}

	return int64(seconds * 1000), nil
}
