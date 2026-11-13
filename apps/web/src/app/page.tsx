import Link from 'next/link';
import { SessionStatus } from '../platform/auth';
import { ApiStatus } from './api-status';

export default function StudioPage() {
  return (
    <main>
      <h1>AI Agent Studio</h1>
      <nav aria-label="Studio">
        <ul>
          <li>
            <Link href="/projects">Projects</Link>
          </li>
        </ul>
      </nav>
      <p>Placeholder Studio page. More features arrive in later slices.</p>
      <SessionStatus />
      <ApiStatus />
    </main>
  );
}
