import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './components/SettingsWindow';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const isSettingsView = params.get('view') === 'settings';

if (isSettingsView) {
  document.documentElement.classList.add('settings-view');
  document.title = '设置';
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <AppErrorBoundary>
    {isSettingsView ? <SettingsWindow /> : <App />}
  </AppErrorBoundary>,
);
