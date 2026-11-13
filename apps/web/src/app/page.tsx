import { redirect } from 'next/navigation';

/** The Studio has no home screen yet: `/` opens Projects (a server-side redirect). */
export default function RootPage() {
  redirect('/projects');
}
