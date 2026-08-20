import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../pg-backup/src/ui/styles/global.css';
import GptTool, { STANDALONE_RUNTIME } from './GptTool.jsx';

createRoot(document.getElementById('root')).render(<React.StrictMode><GptTool runtime={STANDALONE_RUNTIME} /></React.StrictMode>);
