import './globals.css';
import { ProjectCard } from '@/modules/projects';

// Colours come from tokens (#fff in a comment is not a literal).
export default function RootLayout() {
  return (
    <main className="bg-background p-4 text-foreground" style={{ width: 240, '--rail': '16rem' }}>
      <a href="#top">Top</a>
      <a href="#feed">Feed</a>
      <ProjectCard />
    </main>
  );
}
