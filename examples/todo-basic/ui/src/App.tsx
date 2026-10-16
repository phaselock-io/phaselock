import { ConfigProvider, Flex } from 'antd';

import { clientA, clientB } from './engines';
import { theme } from './theme';
import Window from './Window';

function App() {
  return (
    <ConfigProvider theme={theme}>
      <div>
        <div className="brand">
          <img className="logo" src="/logo.svg" alt="PhaseLock logo" width={48} height={48} />
          <h1>PhaseLock To-Do Demo</h1>
        </div>
        <Flex wrap gap="small">
          <Window name="Client A" eng={clientA} />
          <Window name="Client B" eng={clientB} />
        </Flex>
      </div>
    </ConfigProvider>
  );
}

export default App;
