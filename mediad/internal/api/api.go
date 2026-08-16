// Package api implements secchat-mediad's control API (docs/plans/voice-contracts.md §2):
// token-auth HTTP, compose-internal network only, matched exactly to the wire shapes the
// secchat backend's calls/mediad-client.ts speaks against.
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"secchat-mediad/internal/session"
)

// Server wraps a *session.Manager with the HTTP control API.
type Server struct {
	mgr   *session.Manager
	token string
	mux   *http.ServeMux
}

// New builds the control API's http.Handler. token is the shared bearer
// (SECCHAT_MEDIAD_TOKEN/MEDIAD_TOKEN, docs/plans/voice-contracts.md §2).
func New(mgr *session.Manager, token string) *Server {
	s := &Server{mgr: mgr, token: token, mux: http.NewServeMux()}
	s.routes()

	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// GET /health is explicitly unauthenticated (docs/plans/voice-contracts.md §2.5).
	s.mux.HandleFunc("GET /health", s.handleHealth)

	s.mux.Handle("POST /sessions", s.auth(http.HandlerFunc(s.handleCreateSession)))
	s.mux.Handle("POST /sessions/{id}/legs/{legId}/offer", s.auth(http.HandlerFunc(s.handleOfferLeg)))
	s.mux.Handle("GET /sessions/{id}", s.auth(http.HandlerFunc(s.handleGetSession)))
	s.mux.Handle("DELETE /sessions/{id}", s.auth(http.HandlerFunc(s.handleEndSession)))
}

// auth enforces the single shared bearer token on every request except /health
// (docs/plans/voice-contracts.md §2: "Authorization: Bearer <SECCHAT_MEDIAD_TOKEN>").
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		hdr := r.Header.Get("Authorization")
		if !strings.HasPrefix(hdr, prefix) ||
			subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(hdr, prefix)), []byte(s.token)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "")

			return
		}
		next.ServeHTTP(w, r)
	})
}

type errorBody struct {
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
}

func writeError(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Error: code, Detail: detail})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("mediad: encode response failed", "err", err)
	}
}

// mapSessionErr translates internal/session sentinel errors to the contract's error codes
// (docs/plans/voice-contracts.md §2.6).
func mapSessionErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, session.ErrSessionNotFound):
		writeError(w, http.StatusNotFound, "session_not_found", "")
	case errors.Is(err, session.ErrLegNotFound):
		writeError(w, http.StatusNotFound, "leg_not_found", "")
	case errors.Is(err, session.ErrLegBusy):
		writeError(w, http.StatusConflict, "leg_already_connected", "")
	case errors.Is(err, session.ErrSessionCapReached):
		writeError(w, http.StatusServiceUnavailable, "session_cap_reached", "")
	case errors.Is(err, session.ErrSessionEnded):
		writeError(w, http.StatusGone, "session_ended", "")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error())
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.Health())
}
