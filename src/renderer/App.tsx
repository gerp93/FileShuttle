import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import Layout from './components/Layout';
import Mappings from './pages/Mappings';
import MappingEditor from './pages/MappingEditor';
import History from './pages/History';
import Settings from './pages/Settings';
import './themes.css';

function App() {
  return (
    <ThemeProvider>
      <Router>
        <Layout>
          <Routes>
            <Route path="/" element={<Mappings />} />
            <Route path="/editor" element={<MappingEditor />} />
            <Route path="/editor/:id" element={<MappingEditor />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </Router>
    </ThemeProvider>
  );
}

export default App;
