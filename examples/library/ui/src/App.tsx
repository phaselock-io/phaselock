import { ConfigProvider, Flex, theme } from 'antd';

import AdminWindow from './AdminWindow';
import PatronWindow from './PatronWindow';

const RELAY_URL = 'ws://localhost:3001/ws';

function App() {
  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{ algorithm: darkAlgorithm }}>
      <div>
        <h1>PhaseLock Demo</h1>
        <Flex wrap gap="small">
          <AdminWindow relayUrl={RELAY_URL} />
          <PatronWindow patronId="patron-1" relayUrl={RELAY_URL} />
          <PatronWindow patronId="patron-2" relayUrl={RELAY_URL} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
