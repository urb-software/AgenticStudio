'use client';

import { useEffect, useState } from 'react';
import { pullRequestFilesUrl } from '../../components/github-links';

/** GitHub's anchor of a file on that page: `diff-` and the SHA-256 of its path, in hex. */
async function fileAnchor(path: string): Promise<string | null> {
  // Only in a secure context (https or localhost); elsewhere the link opens the page's top.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(path));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `diff-${hex.join('')}`;
}

/**
 * The link to a file in the Run's pull request on GitHub (Issue #144): the "Files changed" page,
 * at the file once its anchor is computed. `null` when the pull request is not on github.com.
 */
export function usePullRequestFileUrl(pullRequestUrl: string, path: string): string | null {
  const page = pullRequestFilesUrl(pullRequestUrl);
  const [anchor, setAnchor] = useState<{ path: string; value: string } | null>(null);
  useEffect(() => {
    let current = true;
    void fileAnchor(path)
      .then((value) => {
        if (current && value) setAnchor({ path, value });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [path]);
  if (!page) return null;
  return anchor?.path === path ? `${page}#${anchor.value}` : page;
}
