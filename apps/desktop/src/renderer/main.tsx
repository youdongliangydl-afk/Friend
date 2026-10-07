import { createRoot } from 'react-dom/client';
import App from './App.js';
import './style.css';
import './readability.css';
import './layout.css';

const root = document.getElementById('root');
if (!root) throw new Error('Friend-Pi root element missing');
createRoot(root).render(<App />);
