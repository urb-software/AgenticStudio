import type { CSSProperties } from 'react';

const tone = 'var(--brand)';
// A style object built elsewhere cannot be checked, so it is a violation too.
const panel: CSSProperties = { width: 240 };

export default function Page() {
  return (
    <main style={{ backgroundColor: tone }}>
      <section style={panel}>Agent Studio</section>
    </main>
  );
}
