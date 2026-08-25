import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import './index.css'
import App from './App.jsx'


// Embedded in the Position2 Intelligence Platform iframe.
//
// This only marks the document so the CSS can drop outer chrome. The shared-token
// auto-login that used to run here is gone: a framed visitor now signs in with
// Google like anyone else, and sees the login card until they do.
if (window.self !== window.top) {
  document.documentElement.classList.add('embedded');
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
