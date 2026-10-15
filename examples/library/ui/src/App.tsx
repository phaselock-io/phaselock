import { ConfigProvider, Flex, theme } from 'antd';

import AdminWindow from './AdminWindow';
import { admin, alice, bob } from './engines';
import PatronWindow from './PatronWindow';

function App() {
  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{ algorithm: darkAlgorithm }}>
      <div>
        <h1>PhaseLock Demo</h1>
        <Flex wrap gap="small">
          <AdminWindow client={admin} />
          <PatronWindow patronId="patron-1" client={alice} />
          <PatronWindow patronId="patron-2" client={bob} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
