import { ConfigProvider, Flex, theme } from 'antd';

import AdminWindow from './AdminWindow';
import { admin, alice, bob } from './engines';
import PatronWindow from './PatronWindow';
import RoomBanner from './RoomBanner';

function App() {
  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{ algorithm: darkAlgorithm }}>
      <div>
        <h1>PhaseLock Demo</h1>
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
