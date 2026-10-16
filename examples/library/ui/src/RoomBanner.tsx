// room stuff; for hosting a demo with many rooms

import { type AdminEngineQueryTxn, ROOM_LIFETIME_MS } from '@library/model/ui';
import { useEffect, useState } from 'react';

import { admin, room } from './engines';
import { useLocalQuery } from './useLocalQuery';

// when the room was created, from the room's own record
function createdQuery(qx: AdminEngineQueryTxn) {
  return qx.get.room_created(room);
}

/** what the room is, how to share it, and when it resets */
export default function RoomBanner() {
  const created = useLocalQuery(admin.engine, createdQuery);

  // the countdown ticks on its own, since nothing in the room changes as the minutes pass
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  if (created === undefined) return null;
  const minutes = Math.max(0, Math.ceil((created.getTime() + ROOM_LIFETIME_MS - now) / 60_000));
  return (
    <p className="room">
      This library is a room of your own: share its link to use it together. It resets in {minutes}{' '}
      {minutes === 1 ? 'minute' : 'minutes'}.
    </p>
  );
}
