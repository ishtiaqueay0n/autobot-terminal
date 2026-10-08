import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';

// No StrictMode: each tab owns a live shell process, and double-mounting would spawn and kill shells.
createRoot(document.getElementById('root')!).render(<App />);
