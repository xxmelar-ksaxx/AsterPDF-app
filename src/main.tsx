import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Workspace from './components/Workspace';
import './styles.css';

const Root = new URLSearchParams(window.location.search).has('workspace') ? Workspace : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
