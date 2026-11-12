import { SessionStatus } from '../modules/auth';
import { ApiStatus } from './api-status';

export default function StudioPage() {
  return (
    <main>
      <h1>AI Agent Studio</h1>
      <p>Placeholder Studio page. Features arrive in later slices.</p>
      <SessionStatus />
      <ApiStatus />
    </main>
  );
}
