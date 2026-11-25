import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { PlainText } from '../../components/plain-text';

const TITLE_ID = 'base-rules-title';

/**
 * The rules every Run gets, read-only here: an agent's instructions come after them. Plain text,
 * as the API sends it; Studio changes it, not a definitions Repository.
 */
export function BaseRules({ version, text }: { version: string; text: string }) {
  return (
    <Card aria-labelledby={TITLE_ID}>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <CardTitle id={TITLE_ID}>Base rules</CardTitle>
          <CardDescription>
            Read-only. Every Run gets these first; an agent&apos;s instructions come after them.
          </CardDescription>
        </div>
        <span className="text-caption text-text-muted">Version {version}</span>
      </CardHeader>
      <CardContent>
        <PlainText text={text} aria-label="Base rules text" role="region" />
      </CardContent>
    </Card>
  );
}
