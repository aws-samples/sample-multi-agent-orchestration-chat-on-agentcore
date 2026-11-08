import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import '../../i18n';
import { MockPage } from './MockPage';

// Standalone entry (no Amplify / auth) so the mock runs with `vite` alone.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MockPage />
  </StrictMode>
);
