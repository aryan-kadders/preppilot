import React, { useState } from 'react';
import { supabase } from '../supabase';
import { Alert, Field, useAction } from '../components/ui';

const Brand: React.FC = () => (
  <div className="auth-brand"><div className="org-mark">P</div>PrepPilot Manager</div>
);

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const action = useAction();

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(/invalid/i.test(error.message) ? 'Wrong email or password.' : error.message);
    });
  };

  const reset = () => void action.run(async () => {
    if (!email.trim()) throw new Error('Enter your email first, then choose Forgot password.');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    if (error) throw error;
    setSent(true);
  });

  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <form className="card" onSubmit={signIn}>
          <div className="card-body stack" style={{ gap: 14 }}>
            <div>
              <h1 className="page-title" style={{ fontSize: 18 }}>Sign in</h1>
              <p className="page-desc">Manage candidates, practice time and assignments.</p>
            </div>
            <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
            <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {action.error && <Alert kind="error">{action.error}</Alert>}
            {sent && <Alert kind="ok">If that email has an account, a reset link is on its way.</Alert>}
            <button className="btn btn-primary" type="submit" disabled={action.busy} style={{ height: 36 }}>{action.busy ? 'Signing in…' : 'Sign in'}</button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={reset} disabled={action.busy} style={{ alignSelf: 'center' }}>Forgot password?</button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** After an invite or reset link: choose a password, then carry on. */
export const SetPassword: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const action = useAction();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (password.length < 10) throw new Error('Use at least 10 characters.');
      if (password !== confirm) throw new Error('The two passwords do not match.');
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      onDone();
    });
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <form className="card" onSubmit={save}>
          <div className="card-body stack" style={{ gap: 14 }}>
            <div>
              <h1 className="page-title" style={{ fontSize: 18 }}>Choose your password</h1>
              <p className="page-desc">You will sign in with your email and this password.</p>
            </div>
            <Field label="New password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></Field>
            <Field label="Confirm password"><input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
            {action.error && <Alert kind="error">{action.error}</Alert>}
            <button className="btn btn-primary" type="submit" disabled={action.busy} style={{ height: 36 }}>Save and continue</button>
          </div>
        </form>
      </div>
    </div>
  );
};
