import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import KYCWorkflow from './pages/KYC/KYCWorkflow';
import HistoryPage from './pages/History';
import VideoAnalysis from './pages/VideoAnalysis';
import AdminDashboard from './pages/Admin/AdminDashboard';
import Navbar from './components/Navbar';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DeepAgent } from './components/DeepAgent';
import { Footer } from './components/Footer';
import { analytics } from './lib/firebase';
import { logEvent } from 'firebase/analytics';
import { Loader2 } from 'lucide-react';

function PageTracker() {
  const location = useLocation();

  useEffect(() => {
    if (analytics) {
      logEvent(analytics, 'page_view', {
        page_path: location.pathname,
        page_location: window.location.href,
        page_title: document.title
      });
    }
  }, [location]);

  return null;
}

function ProtectedRoute({ children, requiredRole }: { children: JSX.Element, requiredRole?: string }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050505]">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (requiredRole && user.role !== requiredRole) {
    return <Navigate to="/" />;
  }

  return children;
}

function AppRoutes() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen font-sans selection:bg-emerald-500/30">
      {user && <Navbar user={user} onLogout={logout} />}
      <Routes>
        <Route path="/login" element={!user ? <Login /> : <Navigate to="/" />} />
        <Route path="/signup" element={!user ? <Signup /> : <Navigate to="/" />} />
        <Route path="/forgot-password" element={!user ? <ForgotPassword /> : <Navigate to="/" />} />
        <Route path="/reset-password" element={!user ? <ResetPassword /> : <Navigate to="/" />} />
        
        <Route path="/" element={
          <ProtectedRoute>
            {user?.role === 'admin' ? <AdminDashboard /> : <Dashboard user={user} />}
          </ProtectedRoute>
        } />
        
        <Route path="/kyc" element={
          <ProtectedRoute requiredRole="user">
            <KYCWorkflow user={user} />
          </ProtectedRoute>
        } />
        <Route path="/history" element={
          <ProtectedRoute requiredRole="user">
            <HistoryPage user={user} />
          </ProtectedRoute>
        } />
        <Route path="/video-lab" element={
          <ProtectedRoute requiredRole="user">
            <VideoAnalysis />
          </ProtectedRoute>
        } />
        
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      <DeepAgent />
      <Footer />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <PageTracker />
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
