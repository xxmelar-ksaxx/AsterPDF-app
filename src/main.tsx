import { applyLanguage } from './i18n';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Workspace from './components/Workspace';
import './styles.css';

const Root = new URLSearchParams(window.location.search).has('workspace') ? Workspace : App;
const root = createRoot(document.getElementById('root')!);
function render(state: LanguageState) {
  applyLanguage(state);
  root.render(<React.StrictMode><Root /></React.StrictMode>);
}
let received = false;
window.aster.onLanguageChanged?.(state => { received = true; render(state); });
const fallback: LanguageState = { preference: 'system', language: navigator.language.split('-')[0] === 'ar' ? 'ar' : 'en' };
Promise.resolve(window.aster.getLanguage?.()).then(state => {
  if (!received) render(state ?? fallback);
}).catch(() => { if (!received) render(fallback); });
