import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useGuild } from './GuildContext.jsx';

const Ctx = createContext(null);
export const useLive = () => useContext(Ctx);

// Polls the bot's in-progress recordings for the active guild. Live recording
// state lives only in the bot's memory (transcription runs at meeting end), so
// this gives the dashboard a real-time view: who's recording, for how long, and
// a one-click Stop. Polls every 4s normally, 2s while a session is processing
// (so completion feels snappy), and pauses entirely while the tab is hidden
// (refreshing immediately on return) — D5.
export function LiveProvider({ children }) {
  const { guildId } = useGuild();
  const [live, setLive] = useState([]);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    if (!guildId) { setLive([]); return; }
    try {
      const { live } = await api.live(guildId);
      setLive(Array.isArray(live) ? live : []);
      setError(null);
    } catch (e) {
      // A read-only/standalone server (401) or an older server without the live
      // endpoint (404) has no live data — treat as "nothing recording" rather
      // than surfacing an error. Only real failures show a message.
      setLive([]);
      if (e?.status === 401 || e?.status === 404) setError(null);
      else setError(e?.message || null);
    }
  }, [guildId]);

  // Poll faster while anything is actively processing (completion should feel
  // snappy), slower otherwise. The interval is recreated whenever this rate
  // changes.
  const pollMs = live.some((s) => s.phase === 'processing') ? 2000 : 4000;

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    function start() {
      clearInterval(timer.current);
      // Skip polling entirely when there's no guild selected (nothing to poll)
      // or the tab is hidden. Refreshes immediately when either changes.
      if (!document.hidden && guildId) timer.current = setInterval(refresh, pollMs);
    }
    function onVisibilityChange() {
      if (!document.hidden) refresh();
      start();
    }
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, pollMs, guildId]);

  const stop = useCallback(async (channelId) => {
    await api.stopLive(guildId, channelId);
    await refresh();
  }, [guildId, refresh]);

  return (
    <Ctx.Provider value={{ live, error, refresh, stop }}>
      {children}
    </Ctx.Provider>
  );
}
