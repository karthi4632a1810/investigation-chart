export default function LoginScreen({
  hospital,
  username,
  password,
  loading,
  error,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}) {
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-badge">🏥</div>
          <div>
            <h2>{hospital?.nameEn || 'Sign in to continue'}</h2>
            <p>{hospital?.nameEn ? 'Investigation Chart Portal' : 'Access the investigation chart dashboard with your configured credentials.'}</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="login-form">
          <label className="field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Enter username"
              autoComplete="username"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              required
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
