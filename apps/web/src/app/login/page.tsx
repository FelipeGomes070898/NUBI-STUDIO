import { authConfigured } from '@/lib/auth';
import { login } from './actions';

const MSG: Record<string, string> = {
  invalid: 'Senha incorreta.',
  rate: 'Muitas tentativas. Aguarde 15 minutos.',
  config: 'Defina ADMIN_PASSWORD e AUTH_SECRET (mín. 16 caracteres) no .env e reinicie o servidor.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const configured = authConfigured();
  return (
    <main className="loginWrap">
      <form action={login} className="card loginCard">
        <div className="logo">◈ Social Manager <small>2.0</small></div>
        <h1>Entrar</h1>
        {!configured && <div className="flash flashErr">{MSG.config}</div>}
        {configured && error && MSG[error] && <div className="flash flashErr" role="alert">{MSG[error]}</div>}
        <label>
          Senha do administrador
          <input type="password" name="password" autoComplete="current-password" required autoFocus disabled={!configured} />
        </label>
        <button disabled={!configured}>Entrar</button>
      </form>
    </main>
  );
}
