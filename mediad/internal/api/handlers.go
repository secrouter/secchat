package api

import (
	"encoding/json"
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
	// One leg = a solo self-DM voice memo (record yourself); two legs = a 1:1 call. A session
	// records + mixes N legs (N>=1) — the RTP forwarding between legs is peer-nil-safe, so a
	// single leg simply records with nothing to forward to.
	if req.CallID == "" || len(req.Legs) < 1 || len(req.Legs) > 2 {
		writeError(w, http.StatusBadRequest, "bad_request", "callId and one or two legs are required")

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
