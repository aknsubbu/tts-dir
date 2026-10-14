import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { usePeopleRoute } from './utils.js';
import App from './App.jsx';
import { WhoIsWatching } from './components/Profiles.jsx';

/**
 * Who is using the dashboard. A install with one profile and no PIN has no gate: the dashboard opens
 * as it always did. With more people, or a PIN, this shows "Who's watching?" until someone has chosen,
 * and again whenever their session ends (a PIN was reset, the profile was deleted, they signed out).
 */
export default function Root() {
  const [session, setSession] = useState(undefined); // undefined: asking; null: the server did not answer
  const people = usePeopleRoute();
  const refresh = useCallback(() => api.session().then(setSession, () => setSession(null)), []);

  useEffect(() => {
    refresh();
    window.addEventListener('tts:signin', refresh);
    return () => window.removeEventListener('tts:signin', refresh);
  }, [refresh]);

  if (session === undefined) return <main className="who"><p className="hint">Loading…</p></main>;
  const profile = session?.profile || null;

  if (people === 'who' || (session && !profile)) {
    return (
      <WhoIsWatching
        onBack={profile ? () => { window.location.hash = ''; } : null}
        onSignedIn={(_, { manage }) => {
          window.location.hash = manage ? '#profile' : '';
          refresh();
        }}
      />
    );
  }
  // A new key for every profile: nothing of one person's page carries over to the next.
  return <App key={profile?.id || 'none'} profile={profile} onProfileChanged={refresh} />;
}
