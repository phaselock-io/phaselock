// room stuff; for hosting a demo with many rooms

import { type AdminEngineQueryTxn, ROOM_LIFETIME_MS } from '@library/model/ui';
import { message, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { admin, invite, joined, room } from './engines';
import { useLocalQuery } from './useLocalQuery';

// when the room was created, from the room's own record
function createdQuery(qx: AdminEngineQueryTxn) {
  return qx.get.room_created(room);
}

/** what the room is, its invite, and when it expires; and on an invite, which room it joined */
export default function RoomBanner() {
  const created = useLocalQuery(admin.engine, createdQuery);
  const [toast, toastHolder] = message.useMessage();

  // a page that came in on an invite says so once, naming the room by its id's first part
  useEffect(() => {
    if (joined) toast.open({ content: `Joined room ${room.split('-')[0]}` });
  }, [toast]);

  // the countdown ticks on its own, since nothing in the room changes as the minutes pass
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  if (created === undefined) return toastHolder;
  const minutes = Math.max(0, Math.ceil((created.getTime() + ROOM_LIFETIME_MS - now) / 60_000));
  return (
    <>
      {toastHolder}
      <p className="room">
        This private room of the demo expires in {minutes} {minutes === 1 ? 'minute' : 'minutes'}.
        Invite others to collaborate with this link:{' '}
        <Typography.Link href={invite} target="_blank" rel="noopener" copyable>
          {invite}
        </Typography.Link>
      </p>
    </>
  );
}
