import './project-feed.scss';

// Hashes that are not colours: references, selectors, URL fragments and anchors.
export function ProjectFeed() {
  const focusFeed = () => document.querySelector('#feed')?.scrollIntoView();
  return (
    <section id="feed" className="project-feed" style={{ gridArea: 'main', width: 'var(--rail)' }}>
      <p>PR #1234 and Refs #123 · pick a color(optional)</p>
      <a href={'#feed'}>Feed</a>
      <a href="/docs/#abc">Docs</a>
      <button type="button" onClick={focusFeed}>
        Focus
      </button>
    </section>
  );
}
