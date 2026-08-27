package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"secchat-mediad/internal/session"
)

// createSessionRequest/response mirror docs/plans/voice-contracts.md §2.1 exactly.
type createSessionRequest struct {
	CallID string        `json:"callId"`
	Legs   []legSpecJSON `json:"legs"`
}

type legSpecJSON struct {
	LegID string `json:"legId"`
	Sub   string `json:"sub"`
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")

		return
	}
	// One leg = a solo self-DM voice memo (record yourself); two-or-more legs = a relayed group
	// call (SFU: N participants, one outbound track per remote source — see internal/session).
	// The initial-legs cap is the SAME configured per-session participant cap POST
	// /sessions/:id/legs joiners are checked against (session.Manager.MaxLegsPerSession),
	// not a hardcoded "exactly two".
	maxLegs := s.mgr.MaxLegsPerSession()
	if req.CallID == "" || len(req.Legs) < 1 || len(req.Legs) > maxLegs {
		writeError(w, http.StatusBadRequest, "bad_request",
			fmt.Sprintf("callId and 1-%d legs are required", maxLegs))

		return
	}

	legs := make([]session.LegSpec, 0, len(req.Legs))
	for _, l := range req.Legs {
		if l.LegID == "" || l.Sub == "" {
			writeError(w, http.StatusBadRequest, "bad_request", "each leg requires legId and sub")

			return
		}
		legs = append(legs, session.LegSpec{LegID: l.LegID, Sub: l.Sub})
	}

	sess, err := s.mgr.CreateSession(req.CallID, legs)
	if err != nil {
		mapSessionErr(w, err)

		return
	}

	writeJSON(w, http.StatusCreated, createSessionResponse{SessionID: sess.ID()})
}

// offerRequest/response mirror docs/plans/voice-contracts.md §2.2.
type offerRequest struct {
	SDP string `json:"sdp"`
}

type offerResponse struct {
	SDP string `json:"sdp"`
}

func (s *Server) handleOfferLeg(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	legID := r.PathValue("legId")

	var req offerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SDP == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: sdp is required")

		return
	}

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	answer, err := sess.OfferLeg(legID, req.SDP)
	if err != nil {
		mapSessionErr(w, err)

		return
	}

	writeJSON(w, http.StatusOK, offerResponse{SDP: answer})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	writeJSON(w, http.StatusOK, sess.State())
}

func (s *Server) handleEndSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	manifest, err := s.mgr.EndSession(sessionID)
	if err != nil {
		mapSessionErr(w, err)

		return
	}

	writeJSON(w, http.StatusOK, manifest)
}

// addLegRequest/response back POST /sessions/{id}/legs — add a joiner to a live session
// (multi-party SFU). Mirrors createSessionRequest/response's shape (legId/sub in, legId echoed
// back) for one leg instead of the initial batch.
type addLegRequest struct {
	LegID string `json:"legId"`
	Sub   string `json:"sub"`
}

type addLegResponse struct {
	LegID string `json:"legId"`
}

func (s *Server) handleAddLeg(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	var req addLegRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.LegID == "" || req.Sub == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: legId and sub are required")

		return
	}

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	if err := sess.AddLeg(req.LegID, req.Sub); err != nil {
		mapSessionErr(w, err)

		return
	}

	writeJSON(w, http.StatusCreated, addLegResponse{LegID: req.LegID})
}

// renegotiateResponse backs POST /sessions/{id}/legs/{legId}/renegotiate — mediad's fresh
// server-initiated SDP OFFER for legID (same {sdp} shape as offerResponse, but this direction
// carries an offer, not an answer — see Session.RenegotiateLeg).
type renegotiateResponse struct {
	SDP string `json:"sdp"`
}

func (s *Server) handleRenegotiateLeg(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	legID := r.PathValue("legId")

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	offer, err := sess.RenegotiateLeg(legID)
	if err != nil {
		mapSessionErr(w, err)

		return
	}

	writeJSON(w, http.StatusOK, renegotiateResponse{SDP: offer})
}

// answerRequest backs POST /sessions/{id}/legs/{legId}/answer — the client's answer to a
// server-initiated offer from RenegotiateLeg.
type answerRequest struct {
	SDP string `json:"sdp"`
}

func (s *Server) handleAnswerLeg(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	legID := r.PathValue("legId")

	var req answerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SDP == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: sdp is required")

		return
	}

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	if err := sess.AnswerLeg(legID, req.SDP); err != nil {
		mapSessionErr(w, err)

		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRemoveLeg(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	legID := r.PathValue("legId")

	sess, ok := s.mgr.Get(sessionID)
	if !ok {
		mapSessionErr(w, session.ErrSessionNotFound)

		return
	}

	if err := sess.RemoveLeg(legID); err != nil {
		mapSessionErr(w, err)

		return
	}

	w.WriteHeader(http.StatusNoContent)
}
