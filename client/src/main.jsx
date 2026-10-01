import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import FileView from './fileview.jsx';
import './styles.css';

// "#/file?…" is the standalone file preview (opened in its own tab); everything else is the app.
const isFileView = () => window.location.hash.startsWith('#/file?');

function Root() {
  const [fileView, setFileView] = useState(isFileView);
  useEffect(() => {
    const onHash = () => setFileView(isFileView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return fileView ? <FileView key={window.location.hash} /> : <App />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />);
