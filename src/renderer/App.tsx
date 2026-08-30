import { Component, ReactNode } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import Layout from './components/Layout';
import Jobs from './pages/Jobs';
import JobEditor from './pages/JobEditor';
import Mappings from './pages/Mappings';
import MappingEditor from './pages/MappingEditor';
import History from './pages/History';
import Settings from './pages/Settings';
import './themes.css';

class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty-state">
          <p>Something went wrong on this page.</p>
          <p className="muted">{this.state.error.message}</p>
          <button className="outline" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ThemeProvider>
      <Router>
        <Layout>
          <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<Jobs />} />
              <Route path="/jobs/new" element={<JobEditor />} />
              <Route path="/jobs/:id" element={<JobEditor />} />
              <Route path="/mappings" element={<Mappings />} />
              <Route path="/editor" element={<MappingEditor />} />
              <Route path="/editor/:id" element={<MappingEditor />} />
              <Route path="/history" element={<History />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteErrorBoundary>
        </Layout>
      </Router>
    </ThemeProvider>
  );
}

export default App;
