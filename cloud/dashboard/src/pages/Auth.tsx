import React, { useState } from 'react';
import { supabase } from '../supabase';
import { Notice, useAction } from '../components/ui';

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
    if (!email.trim()) throw new Error('Enter your email first.');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    if (error) throw error;
    setSent(true);
  });

  return (
    <div className="center-page">
      <form className="card auth-card stack" onSubmit={signIn}>
        <div>
          <h1>PrepPilot Manager</h1>
          <p className="subtitle" style={{ margin: 0 }}>Sign in to manage candidates, time and assignments.</p>
        </div>
        <label className="field">Email
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">Password
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {action.error && <Notice kind="error">{action.error}</Notice>}
        {sent && <Notice kind="ok">If that email has an account, a reset link is on its way.</Notice>}
        <button className="btn primary" type="submit" disabled={action.busy}>{action.busy ? 'Signing in…' : 'Sign in'}</button>
        <button className="btn" type="button" onClick={reset} disabled={action.busy}>Forgot password</button>
      </form>
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
    <div className="center-page">
      <form className="card auth-card stack" onSubmit={save}>
        <h1>Choose your password</h1>
        <p className="subtitle" style={{ margin: 0 }}>You will use it with your email to sign in next time.</p>
        <label className="field">New password
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">Confirm password
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {action.error && <Notice kind="error">{action.error}</Notice>}
        <button className="btn primary" type="submit" disabled={action.busy}>Save password</button>
      </form>
    </div>
  );
};
