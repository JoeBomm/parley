import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

// Auth gate with graceful degradation:
//   • authEnabled === false  → the backend genuinely has no /api/auth routes
//     (an older server, signalled by a 404 on /auth/me). Skip the login screen
//     so the dashboard stays usable; real login engages once the backend
//     supports it.
//   • authEnabled === true   → require a session; show Login until one exists.
//   • error !== null         → /auth/me failed for a transient reason (network
//     blip, 5xx, proxy). We must NOT run open here (that would mount the whole
//     dashboard unauthenticated on any hiccup), so surface a retry state instead.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [defaultPasswordActive, setDefaultPasswordActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const { user, authEnabled: enabled, defaultPasswordActive: dpa } = await api.me();
      // `authEnabled` is sent by auth-aware servers; default true when present.
      setAuthEnabled(enabled !== false);
      setDefaultPasswordActive(!!dpa);
      setUser(user || null);
      return user || null;
    } catch (e) {
      if (e?.status === 404) {
        // This server predates auth — run open rather than trapping the user on
        // a login screen it can't satisfy.
        setAuthEnabled(false);
        setUser(null);
      } else if (e?.status === 401) {
        // Auth-aware server, just no session yet → show Login.
        setAuthEnabled(true);
        setUser(null);
      } else {
        // Transient failure: do NOT fail open. Keep auth on and record the error
        // so the gate can offer a retry instead of exposing the dashboard.
        setUser(null);
        setError(e?.message || 'Could not reach the server.');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // A 401 from any API call (expired/revoked session mid-use) clears the user so
  // the gate re-renders to <Login /> instead of stranding the current page.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username, password) => {
    const { user } = await api.login(username, password);
    setUser(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    // Hard reset: drops all in-memory provider state (guilds, live polling,
    // meetings) and guarantees the cleared cookie takes effect everywhere.
    window.location.assign('/');
  }, []);

  return (
    <Ctx.Provider value={{ user, authEnabled, defaultPasswordActive, loading, error, refresh, login, logout, setUser }}>
      {children}
    </Ctx.Provider>
  );
}
