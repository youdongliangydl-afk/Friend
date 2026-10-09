import { createRoot } from 'react-dom/client';
import App from './App.js';
import {ComposerSurface} from './SessionComposer.js';
import './style.css';
import './readability.css';
import './layout.css';
import './client-workspace.css';
import './model-settings.css';
import './session-fullscreen.css';
import './session-trace.css';

const root = document.getElementById('root');
if (!root) throw new Error('Friend-Pi root element missing');
createRoot(root).render(new URLSearchParams(location.search).get('surface')==='composer'?<ComposerSurface/>:<App/>);
