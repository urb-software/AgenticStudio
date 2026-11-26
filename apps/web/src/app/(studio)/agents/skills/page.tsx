import type { Metadata } from 'next';
import { SkillList } from '../../../../modules/agents';

export const metadata: Metadata = { title: 'Skills · AI Agent Studio' };

export default function SkillsPage() {
  // The Studio Shell provides the `main` landmark and the breadcrumb.
  return (
    <div className="flex flex-col gap-5">
      <SkillList />
    </div>
  );
}
