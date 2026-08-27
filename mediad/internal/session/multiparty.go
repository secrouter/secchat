// multiparty.go implements the SFU membership-change control plane added for group calls
// (N participants, relayed-only): adding a joiner mid-call, removing a leaver mid-call, and the
// server-initiated renegotiation those two require. mediad NEVER pushes an offer on its own —
// secchat orchestrates: after AddLeg/RemoveLeg mutates some OTHER live leg's outbound-track set,
// it calls RenegotiateLeg for that leg, relays the resulting offer to its client over the
// existing signaling channel, and posts the client's answer back via AnswerLeg.
package session

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/pion/webrtc/v4"

	"secchat-mediad/internal/recorder"
)

// AddLeg registers a new leg (a joiner) in a live session: opens its recorder and appends it to
// legOrder, then gives every currently-live OTHER leg a fresh outbound track for this leg's
// (future) audio — so their NEXT RenegotiateLeg call offers it. The joiner's own PeerConnection
// (and its outbound tracks toward every existing peer) is created lazily by OfferLeg exactly like
// any other leg's first offer; newPeerConnectionForLeg provisions those by calling peerLegs,
// which already includes this leg by the time the joiner's client offers.
func (s *Session) AddLeg(legID, sub string) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()

		return ErrSessionEnded
	}
	if _, exists := s.legs[legID]; exists {
		s.mu.Unlock()

		return ErrLegAlreadyExists
	}
	active := 0
	existing := make([]*leg, 0, len(s.legs))
	for _, l := range s.legs {
		l.mu.Lock()
		left := l.left
		l.mu.Unlock()
		if !left {
			active++
		}
		existing = append(existing, l)
	}
	// Reserve a slot against MaxLegsPerSession in the SAME lock acquisition as the check (same
	// TOCTOU fix as Manager.CreateSession's `reserved` — see session.go's legsReserved doc): the
	// recorder.NewLeg I/O below happens UNLOCKED, so without this, two concurrent AddLeg calls
	// could both observe room and both proceed, exceeding the cap.
	if active+s.legsReserved >= s.mgr.MaxLegsPerSession() {
		s.mu.Unlock()

		return ErrTooManyLegs
	}
	s.legsReserved++
	s.mu.Unlock()

	release := func() {
		s.mu.Lock()
		s.legsReserved--
		s.mu.Unlock()
	}

	path := filepath.Join(s.dir, legID+".ogg")
	rec, err := recorder.NewLeg(path, s.t0, recorder.Options{
		Now: s.mgr.now,
		OnFirstPacket: func(startOffsetMs int64) {
			s.recordLegOffset(legID, startOffsetMs)
		},
	})
	if err != nil {
		release()

		return fmt.Errorf("session: open leg recorder %s: %w", legID, err)
	}

	l := &leg{
		id: legID, sub: sub, rec: rec, path: path,
		iceState:       webrtc.ICEConnectionStateNew,
		outboundTracks: make(map[outboundTrackKey]*outboundTrack),
		inboundTracks:  make(map[string]*inboundTrackInfo),
	}

	s.mu.Lock()
	if s.ended {
		// finalize() raced us while the recorder I/O above was in flight — don't leave an
		// orphaned leg registered against a session that just ended.
		s.mu.Unlock()
		release()
		_, _ = rec.Close()

		return ErrSessionEnded
	}
	if _, exists := s.legs[legID]; exists {
		// Lost a race against a concurrent AddLeg for the same legID between the check above and
		// here — the loser's recorder never gets used.
		s.mu.Unlock()
		release()
		_, _ = rec.Close()

		return ErrLegAlreadyExists
	}
	s.legs[legID] = l
	s.legOrder = append(s.legOrder, legID)
	s.legsReserved--
	s.mu.Unlock()

	for _, peer := range existing {
		peer.mu.Lock()
		left := peer.left
		peer.mu.Unlock()
		if left {
			continue
		}
		// A peer with no PeerConnection yet (never offered) has nothing to add a track TO right
		// now — ensureOutboundTrack requires a live pc. It gets this leg's outbound track(s)
		// lazily from newPeerConnectionForLeg instead, once it eventually does offer (s.legs
		// already carries this leg by then, so peerLegs picks it up). provisionPeerOutboundTracks
		// provisions audio unconditionally (l has no active tracks of its own yet — it hasn't
		// even offered) plus any of l's already-active video tracks (none, at this point in
		// AddLeg) — kept as a shared helper with newPeerConnectionForLeg's peer loop rather than
		// a bespoke audio-only call here.
		if err := s.provisionPeerOutboundTracks(peer, l); err != nil {
			continue
		}
	}

	return nil
}

// RemoveLeg tears down legID's PeerConnection (stopping it from receiving or sending any further
// audio) and closes its recorder, then drops the outbound track every OTHER live leg was using to
// carry its audio — so those legs' NEXT RenegotiateLeg call produces an offer that no longer
// references it. legID itself is never deleted from s.legs/s.legOrder: finalize's per-leg
// manifest entry and mixLegs need its already-recorded audio up to the point it left; only
// forwarding/negotiation (peerLegs, AddLeg's fan-out) treat it as gone from here on (leg.left).
// Idempotent — removing an already-left leg is a no-op, not an error.
func (s *Session) RemoveLeg(legID string) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()

		return ErrSessionEnded
	}
	l, ok := s.legs[legID]
	others := make([]*leg, 0, len(s.legs))
	for id, other := range s.legs {
		if id != legID {
			others = append(others, other)
		}
	}
	s.mu.Unlock()
	if !ok {
		return ErrLegNotFound
	}

	// Block (not TryLock) rather than fail: a removal must win even if an offer/renegotiate for
	// this SAME leg happens to be in flight — bounded by gatherTimeout at worst, not a deadlock.
	l.negotiating.Lock()
	defer l.negotiating.Unlock()

	l.mu.Lock()
	if l.left {
		l.mu.Unlock()

		return nil
	}
	l.left = true
	pc := l.pc
	l.mu.Unlock()

	if pc != nil {
		// Stops readInboundTrack's ReadRTP loop (returns an error once the PC is closed) and any
		// further RTCP for this leg.
		_ = pc.Close()
	}

	if l.rec != nil {
		durationMs, err := l.rec.Close() // idempotent — safe even if finalize() also closes it later
		l.mu.Lock()
		l.durationMs = durationMs
		l.recErr = err
		l.mu.Unlock()
	}

	for _, other := range others {
		other.mu.Lock()
		// A leaving leg may have had UP TO THREE inbound tracks (audio + up to two video), each
		// with its own outbound track on every other leg's PC — remove ALL of them, not just the
		// single (audio-only, pre-video) one.
		var toRemove []*outboundTrack
		for key, ot := range other.outboundTracks {
			if key.legID != legID {
				continue
			}
			toRemove = append(toRemove, ot)
			delete(other.outboundTracks, key)
		}
		otherPC := other.pc
		other.mu.Unlock()
		if otherPC == nil {
			continue
		}
		for _, ot := range toRemove {
			if err := otherPC.RemoveTrack(ot.sender); err != nil {
				// Non-fatal: the track's underlying sender is torn down along with the whole PC
				// if otherPC itself is closing/closed concurrently — RemoveTrack failing here just
				// means the next renegotiate offer won't clean up an already-moot m-line entry.
				continue
			}
		}
	}

	return nil
}

// RenegotiateLeg builds a fresh server-initiated SDP OFFER for legID reflecting its CURRENT
// outbound-track set — the control-API contract's "mediad never pushes": secchat calls this
// after an AddLeg/RemoveLeg mutated some OTHER leg's track set, relays the returned offer to
// legID's client over the existing signaling channel, and posts the client's answer back via
// AnswerLeg. Non-trickle, same gather-to-completion contract as OfferLeg — in practice this
// resolves immediately, since a renegotiation (no ICE restart) reuses the candidates already
// gathered for the leg's original offer/answer.
func (s *Session) RenegotiateLeg(legID string) (string, error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()

		return "", ErrSessionEnded
	}
	l, ok := s.legs[legID]
	s.mu.Unlock()
	if !ok {
		return "", ErrLegNotFound
	}

	if !l.negotiating.TryLock() {
		return "", ErrLegBusy
	}
	defer l.negotiating.Unlock()

	l.mu.Lock()
	pc := l.pc
	left := l.left
	l.mu.Unlock()
	if pc == nil || left {
		return "", ErrLegNotConnected
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("session: create renegotiation offer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("session: set local description: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), gatherTimeout)
	defer cancel()
	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return "", fmt.Errorf("session: ICE gathering did not complete within %s", gatherTimeout)
	}

	final := pc.LocalDescription()
	if final == nil {
		return "", fmt.Errorf("session: no local description after gathering")
	}

	return final.SDP, nil
}

// AnswerLeg applies the client's answer to legID's most recent server-initiated OFFER
// (RenegotiateLeg) as its PeerConnection's remote description, completing that renegotiation.
func (s *Session) AnswerLeg(legID, answerSDP string) error {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()

		return ErrSessionEnded
	}
	l, ok := s.legs[legID]
	s.mu.Unlock()
	if !ok {
		return ErrLegNotFound
	}

	if !l.negotiating.TryLock() {
		return ErrLegBusy
	}
	defer l.negotiating.Unlock()

	l.mu.Lock()
	pc := l.pc
	left := l.left
	l.mu.Unlock()
	if pc == nil || left {
		return ErrLegNotConnected
	}

	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}
	if err := pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("session: set remote description (answer): %w", err)
	}

	return nil
}
