/*
  Page shell only. Theme, fonts, and the React root. The agent workflow is not
  in this file. App talks to the local server, and the server runs the workflow.
*/

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App.tsx';

const theme = createTheme({
  palette: {
    primary: { main: '#294735' },
    secondary: { main: '#a78343' },
    background: { default: '#f4f2eb', paper: '#fffefa' },
    text: { primary: '#252a25', secondary: '#6e756c' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontFamily: 'Georgia, serif' },
    h2: { fontFamily: 'Georgia, serif' },
    h3: { fontFamily: 'Georgia, serif' },
    button: { textTransform: 'none' },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiLink: { defaultProps: { underline: 'hover' } },
  },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
