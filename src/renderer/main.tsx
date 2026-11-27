import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { markWebMode } from './utils/platform';
import { createWebApi } from './webApi';

// No Electron preload means the page was opened in a browser (the phone): talk to the PC over HTTP.
if (typeof window.fileshuttleAPI === 'undefined') {
  window.fileshuttleAPI = createWebApi();
  markWebMode();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
