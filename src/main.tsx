import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

function render() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

if (import.meta.env.VITE_IOS_SHELL === '1') {
  document.documentElement.classList.add('ios-app');
  import('./ios-shell.mjs').then((mod) => mod.installNativeShell()).then(render, render);
} else {
  render();
}
