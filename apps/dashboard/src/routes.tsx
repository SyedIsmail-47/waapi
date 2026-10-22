import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { LoadingState } from "@/components/feedback/states";
import { useAuth } from "@/hooks/use-auth";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { LoginPage } from "@/pages/LoginPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { PatsPage } from "@/pages/PatsPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { SessionDetailPage } from "@/pages/SessionDetailPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { BillingPage } from "@/pages/BillingPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SignupPage } from "@/pages/SignupPage";
import { VerifyEmailPage } from "@/pages/VerifyEmailPage";

function Protected() {
  const { ready, isAuthenticated } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking session…" />
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function PublicOnly() {
  const { ready, isAuthenticated } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState />
      </div>
    );
  }
  if (isAuthenticated) return <Navigate to="/sessions" replace />;
  return <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Route>
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<Protected />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/sessions" replace />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/billing" element={<BillingPage />} />
          <Route path="/settings/tokens" element={<PatsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
