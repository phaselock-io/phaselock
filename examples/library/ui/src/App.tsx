import { ConfigProvider, Flex } from 'antd';

import AdminWindow from './AdminWindow';
import { admin, alice, bob } from './engines';
import Intro from './Intro';
import PatronWindow from './PatronWindow';
import RoomBanner from './RoomBanner';
import { theme } from './theme';
import WriteTiming from './WriteTiming';

function App() {
  return (
    <ConfigProvider theme={theme}>
      <div>
        <div className="brand">
          <img className="logo" src="/logo.svg" alt="PhaseLock logo" width={48} height={48} />
          <h1>PhaseLock Library Demo</h1>
        </div>
        <Intro />
        <Flex wrap gap="small">
          <AdminWindow client={admin} />
          <PatronWindow patronId={alice.user} client={alice} />
          <PatronWindow patronId={bob.user} client={bob} />
        </Flex>
        <WriteTiming />
        <RoomBanner />
      </div>
    </ConfigProvider>
  );
}

export default App;
