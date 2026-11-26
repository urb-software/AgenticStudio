import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillList } from '../features/skill-list/skill-list';
import type { SkillSummaryOutput } from '../../../platform/api';
import { fakeSkillsApi, SKILLS_COMMIT, skillDetail, skillList } from './fake-skills-api';

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const REVIEW: SkillSummaryOutput = {
  name: 'review',
  description: 'Reviews a change',
  valid: true,
  problems: [],
};
const BROKEN: SkillSummaryOutput = {
  name: 'broken',
  description: null,
  valid: false,
  problems: [
    {
      code: 'forbidden_key',
      path: 'SKILL.md',
      key: 'hooks',
      message: 'The key "hooks" is refused.',
    },
    { code: 'shell_line', path: 'references/x.md', key: null, message: 'An inline shell line.' },
    { code: 'too_many_files', path: '', key: null, message: 'More files than the limit.' },
  ],
};

function renderSkills() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SkillList />
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('region', { name: 'Skills' });

beforeEach(() => {
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  search.value = '';
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
});

describe('Skills page: the list', () => {
  it('lists skills with their validation state and the commit, without axe violations', async () => {
    fakeSkillsApi(skillList({ skills: [BROKEN, REVIEW] }));
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    expect(within(card()).getByText('Read at commit')).toBeTruthy();
    expect(within(card()).getByText(SKILLS_COMMIT.slice(0, 7))).toBeTruthy();
    const broken = within(card()).getByText('broken').closest('li')!;
    const review = within(card()).getByText('review').closest('li')!;
    expect(within(review).getByText('Valid')).toBeTruthy();
    expect(within(review).getByText('Reviews a change')).toBeTruthy();
    expect(within(broken).getByText('Not valid')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows each reason of an invalid skill with its place', async () => {
    fakeSkillsApi(skillList({ skills: [BROKEN] }));
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    const row = within(card()).getByText('broken').closest('li')!;
    expect(within(row).getByText('SKILL.md')).toBeTruthy();
    expect(within(row).getByText('hooks')).toBeTruthy();
    expect(within(row).getByText('references/x.md')).toBeTruthy();
    expect(within(row).getByText(/the skill's folder/)).toBeTruthy();
    expect(within(row).getByText(/More files than the limit/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('links a skill with an entry file to the editor on its SKILL.md', async () => {
    const noEntry: SkillSummaryOutput = {
      name: 'empty',
      description: null,
      valid: false,
      problems: [{ code: 'entry_missing', path: 'SKILL.md', key: null, message: 'No entry.' }],
    };
    fakeSkillsApi(skillList({ skills: [REVIEW, noEntry] }));
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    const links = within(card()).getAllByRole('link', { name: /^Open in editor/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/agents/editor?path=skills%2Freview%2FSKILL.md',
    ]);
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a name that needs escaping as text, with no detail or editor link', async () => {
    const odd: SkillSummaryOutput = {
      name: '<b>a b</b>',
      description: null,
      valid: false,
      problems: [{ code: 'name_invalid', path: '', key: null, message: 'The name is invalid.' }],
    };
    fakeSkillsApi(skillList({ skills: [odd] }));
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    expect(within(card()).getByText('<b>a b</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(within(card()).queryByRole('button')).toBeNull();
    expect(within(card()).queryByRole('link')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says more skill folders exist when the list is cut', async () => {
    fakeSkillsApi(skillList({ skills: [REVIEW], truncated: true }));
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    expect(within(card()).getByText('More skill folders exist than are listed here.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what to do with no definitions Repository connected', async () => {
    fakeSkillsApi(skillList({ commit: null, repository: null }));
    const { container } = renderSkills();

    expect(await screen.findByText('No skills to show yet')).toBeTruthy();
    expect(screen.getByText(/No definitions Repository is connected/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Agents' }).getAttribute('href')).toBe('/agents');
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what to do before anything was fetched', async () => {
    fakeSkillsApi(skillList({ commit: null }));
    const { container } = renderSkills();

    expect(await screen.findByText(/Nothing has been fetched/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what to do when the Repository holds no skill', async () => {
    fakeSkillsApi(skillList());
    const { container } = renderSkills();

    expect(await screen.findByText('No skills in the definitions Repository')).toBeTruthy();
    expect(screen.getByText(/skills\/<name>\/ with a SKILL.md file/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the note of a Repository that is not ready above the last known skills', async () => {
    fakeSkillsApi(
      skillList({
        repository: { state: 'fetching', note: 'A fetch of the Repository is running.' },
        skills: [REVIEW],
      }),
    );
    const { container } = renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    expect(within(card()).getByText('A fetch of the Repository is running.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says the skills cannot be loaded, and Retry reads them again', async () => {
    const api = fakeSkillsApi(skillList({ skills: [REVIEW] }));
    api.failNextList(500, {
      type: 'about:blank',
      title: 'Boom',
      status: 500,
      detail: 'x',
      correlationId: 'c',
    });
    const { container } = renderSkills();

    expect(await screen.findByText("Couldn't load the skills")).toBeTruthy();
    expect(screen.getByText('GET /api/skills · 500 Boom')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('region', { name: 'Skills' })).toBeTruthy();
  });

  it('is reachable by keyboard: Tab reaches the link, then Show, and Enter opens the detail', async () => {
    fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, { instructions: 'Do it.' }),
    });
    renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /^Open in editor/ }));
    await userEvent.tab();
    const show = screen.getByRole('button', { name: 'Show review' });
    expect(document.activeElement).toBe(show);
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByText('Do it.')).toBeTruthy();
    expect(show.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Skills page: the detail', () => {
  it('shows the instructions as plain text and the files with their sizes', async () => {
    const instructions = '# Heading\n<script>alert(1)</script> [a link](https://x.test)';
    fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, {
        instructions,
        files: [
          { path: 'SKILL.md', size: 812 },
          { path: 'references/guide.md', size: 3500 },
        ],
      }),
    });
    const { container } = renderSkills();

    await userEvent.click(await screen.findByRole('button', { name: 'Show review' }));
    const text = await screen.findByRole('region', { name: 'Instructions text' });

    expect(text.textContent).toBe(instructions);
    expect(container.querySelector('script')).toBeNull();
    expect(text.querySelector('a')).toBeNull();
    expect(screen.getByText('references/guide.md')).toBeTruthy();
    expect(screen.getByText('812 B')).toBeTruthy();
    expect(screen.getByText('3.4 KiB')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the problems of an invalid skill and no instructions', async () => {
    fakeSkillsApi(skillList({ skills: [BROKEN] }), {
      broken: skillDetail(BROKEN, { files: [{ path: 'SKILL.md', size: 10 }] }),
    });
    const { container } = renderSkills();

    await userEvent.click(await screen.findByRole('button', { name: 'Show broken' }));

    expect(await screen.findByText(/not valid until its problems are fixed/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Instructions text' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a skill is no longer in the Repository for a 404', async () => {
    fakeSkillsApi(skillList({ skills: [REVIEW] }), {});
    const { container } = renderSkills();

    await userEvent.click(await screen.findByRole('button', { name: 'Show review' }));

    expect(await screen.findByText('This skill is no longer in the Repository')).toBeTruthy();
    expect(screen.getByText('GET /api/skills/review')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('does not read the detail again on window focus, and keeps it when closed and reopened', async () => {
    const api = fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, { instructions: 'Do it.' }),
    });
    renderSkills();

    const show = await screen.findByRole('button', { name: 'Show review' });
    await userEvent.click(show);
    await screen.findByText('Do it.');
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.count('/api/skills')).toBe(2));
    await userEvent.click(screen.getByRole('button', { name: 'Hide review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show review' }));

    expect(await screen.findByText('Do it.')).toBeTruthy();
    expect(api.count('/api/skills/review')).toBe(1);
  });

  it('reads the detail again under a new commit, which the list brings on focus', async () => {
    const api = fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, { instructions: 'First text.' }),
    });
    renderSkills();
    await userEvent.click(await screen.findByRole('button', { name: 'Show review' }));
    await screen.findByText('First text.');
    const next = 'fedcba9876543210fedcba9876543210fedcba98';
    api.serve(skillList({ commit: next, skills: [REVIEW] }), {
      review: { ...skillDetail(REVIEW, { instructions: 'Second text.' }), commit: next },
    });

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(await screen.findByText('Second text.')).toBeTruthy();
    expect(api.count('/api/skills/review')).toBe(2);
  });
});

describe('Skills page: the agents that name a skill', () => {
  const show = async (extras: Parameters<typeof skillDetail>[1]) => {
    fakeSkillsApi(skillList({ skills: [REVIEW] }), { review: skillDetail(REVIEW, extras) });
    const view = renderSkills();
    await userEvent.click(await screen.findByRole('button', { name: 'Show review' }));
    return view;
  };

  it('lists them, each linking to the agent, without axe violations', async () => {
    const { container } = await show({ instructions: 'Do it.', usedBy: ['alpha', 'zed'] });

    const region = await screen.findByRole('region', { name: 'Agents that use this skill' });
    const links = within(region).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['alpha', 'zed']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/agents?open=alpha',
      '/agents?open=zed',
    ]);
    expect(within(region).queryByText(/may be incomplete/)).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says no agent names the skill', async () => {
    const { container } = await show({ instructions: 'Do it.' });

    const region = await screen.findByRole('region', { name: 'Agents that use this skill' });
    expect(within(region).getByText('No agent names this skill.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says the list may be incomplete when agents beyond the listed ones were not checked', async () => {
    const { container } = await show({
      instructions: 'Do it.',
      usedBy: ['alpha'],
      usedByTruncated: true,
    });

    const region = await screen.findByRole('region', { name: 'Agents that use this skill' });
    expect(within(region).getByText(/may be incomplete/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the agents of an invalid skill too', async () => {
    fakeSkillsApi(skillList({ skills: [BROKEN] }), {
      broken: skillDetail(BROKEN, { usedBy: ['alpha'] }),
    });
    const { container } = renderSkills();
    await userEvent.click(await screen.findByRole('button', { name: 'Show broken' }));

    const region = await screen.findByRole('region', { name: 'Agents that use this skill' });
    expect(within(region).getByRole('link', { name: 'alpha' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('opens the skill named in the address', async () => {
    search.value = 'open=review';
    fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, { instructions: 'Do it.', usedBy: ['alpha'] }),
    });
    renderSkills();

    expect(await screen.findByText('Do it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide review' })).toBeTruthy();
  });

  it('brings the opened skill into view once, without moving focus, and not on a later toggle', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    search.value = 'open=review';
    fakeSkillsApi(skillList({ skills: [REVIEW] }), {
      review: skillDetail(REVIEW, { instructions: 'Do it.' }),
    });
    renderSkills();

    await screen.findByText('Do it.');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(document.activeElement).toBe(document.body);
    await userEvent.click(screen.getByRole('button', { name: 'Hide review' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show review' }));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('does not scroll when no skill is named in the address', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fakeSkillsApi(skillList({ skills: [REVIEW] }));
    renderSkills();

    await screen.findByRole('region', { name: 'Skills' });
    expect(scroll).not.toHaveBeenCalled();
  });
});
