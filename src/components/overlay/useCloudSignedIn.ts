import { useEffect, useState } from 'react';

/**
 * True while this computer is signed in to PrepPilot Cloud with an invite code.
 * Then every answer goes through the organization's plan (the admin picks the
 * model on the dashboard), so the app must not offer its own model choice.
 */
export function useCloudSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    const api = window.electronAPI;
    let alive = true;
    api?.cloudStatus?.()
      .then((s) => { if (alive) setSignedIn(s?.state === 'signed_in'); })
      .catch(() => { /* stays false: the app's own setup */ });
    const off = api?.onCloudUpdate?.((e) => {
      if (e.type === 'state') setSignedIn(e.state === 'signed_in');
    });
    return () => { alive = false; off?.(); };
  }, []);
  return signedIn;
}
