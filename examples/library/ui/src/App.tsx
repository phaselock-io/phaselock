import { ConfigProvider, Flex } from 'antd';

import AdminWindow from './AdminWindow';
import { admin, alice, bob } from './engines';
import PatronWindow from './PatronWindow';
import RoomBanner from './RoomBanner';
import { theme } from './theme';

function App() {
  return (
    <ConfigProvider theme={theme}>
      <div>
        <div className="brand">
          <img className="logo" src="/logo.svg" alt="PhaseLock logo" width={48} height={48} />
          <h1>PhaseLock Library Demo</h1>
        </div>
        <RoomBanner />
        <Flex wrap gap="small">
          <AdminWindow client={admin} />
          <PatronWindow patronId={alice.user} client={alice} />
          <PatronWindow patronId={bob.user} client={bob} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
