import { ConfigProvider, Flex, theme } from 'antd';

import { clientA, clientB } from './engines';
import Window from './Window';

function App() {
  const { darkAlgorithm } = theme;

  return (
    <ConfigProvider theme={{ algorithm: darkAlgorithm }}>
      <div>
        <h1>Todo Demo</h1>
        <Flex wrap gap="small">
          <Window name="Client A" eng={clientA} />
          <Window name="Client B" eng={clientB} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
