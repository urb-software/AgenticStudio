import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_ROW_HEIGHT, LogViewer, type LogRow } from '../log-viewer';

// jsdom lays nothing out, so the viewer's height is stubbed (400px: 20 rows) and scroll
// positions are set by hand.
const VIEWPORT = 400;

const rows = (count: number, from = 0): LogRow[] =>
  Array.from({ length: count }, (_, i) => ({
    key: String(from + i),
    text: `line ${from + i + 1}`,
    tone: 'plain',
  }));

function log() {
  return screen.getByRole('log', { name: 'Run log' });
}

/** Puts the viewer's scroll position at `top` of `rows` rows and fires the scroll. */
function scrollTo(top: number, total: number) {
  const element = log();
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: total * LOG_ROW_HEIGHT,
  });
  element.scrollTop = top;
  fireEvent.scroll(element);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LogViewer', () => {
  it('shows rows in mono with line numbers and tones, as a labelled log', async () => {
    const { container } = render(
      <LogViewer
        label="Run log"
        rows={[
          { key: 'a', text: 'Run step 1 started', tone: 'section' },
          { key: 'b', text: '$ pnpm test', tone: 'command' },
          { key: 'c', text: '12 tests passed', tone: 'tool' },
          { key: 'd', text: 'TOKEN=••••••[redacted]', tone: 'warn' },
        ]}
      />,
    );

    expect(log().className).toContain('font-mono');
    expect(screen.getByText('4 lines')).toBeTruthy();
    const command = screen.getByText('$ pnpm test');
    expect(command.className).toContain('font-semibold');
    expect(command.parentElement?.dataset.tone).toBe('command');
    expect(command.parentElement?.className).toContain('h-5');
    expect(command.parentElement?.className).toContain('whitespace-pre');
    expect(command.previousElementSibling?.textContent).toBe('2');
    expect(screen.getByText('TOKEN=••••••[redacted]').parentElement?.dataset.tone).toBe('warn');
    await expect(container).toHaveNoAxeViolations();
  });

  it('renders only the rows in view, so a long log does not freeze the page', () => {
    render(<LogViewer label="Run log" rows={rows(50_000)} />);

    expect(screen.getByText('50000 lines')).toBeTruthy();
    expect(log().querySelectorAll('[data-tone]').length).toBeLessThan(100);
  });

  it('follows the newest row, pauses when scrolled up, and resumes with Jump to latest', () => {
    const { rerender } = render(<LogViewer label="Run log" rows={rows(100)} streaming />);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    expect(screen.getByText('Streaming')).toBeTruthy();

    scrollTo(100, 100);
    const jump = screen.getByRole('button', { name: 'Jump to latest' });

    // Paused: new rows do not move the view.
    rerender(<LogViewer label="Run log" rows={rows(120)} streaming />);
    expect(log().scrollTop).toBe(100);

    Object.defineProperty(log(), 'scrollHeight', { configurable: true, value: 120 * 20 });
    fireEvent.click(jump);
    expect(log().scrollTop).toBe(120 * 20);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('moves to the newest row as rows arrive while following', () => {
    const { rerender } = render(<LogViewer label="Run log" rows={rows(30)} />);
    Object.defineProperty(log(), 'scrollHeight', { configurable: true, value: 60 * 20 });

    rerender(<LogViewer label="Run log" rows={rows(60)} />);

    expect(log().scrollTop).toBe(60 * 20);
  });

  it('keeps keyboard focus on the log after Jump to latest', () => {
    render(<LogViewer label="Run log" rows={rows(100)} />);
    scrollTo(100, 100);

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));

    expect(document.activeElement).toBe(log());
  });

  it('collapses and expands a section, keeping line numbers', async () => {
    const { container } = render(
      <LogViewer
        label="Run log"
        rows={[
          { key: 's1', text: 'Run step 1 started', tone: 'section' },
          { key: 'a', text: 'first', tone: 'plain' },
          { key: 'b', text: 'second', tone: 'plain' },
          { key: 's2', text: 'Result: done', tone: 'section' },
          { key: 'c', text: 'summary', tone: 'plain' },
        ]}
      />,
    );
    const section = screen.getByRole('button', { name: /Run step 1 started/ });
    expect(section.getAttribute('aria-expanded')).toBe('true');
    expect(section.textContent).toContain('· 2');

    fireEvent.click(section);

    expect(section.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText('summary').previousElementSibling?.textContent).toBe('5');
    await expect(container).toHaveNoAxeViolations();
    fireEvent.click(section);
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('adds appended rows to the open section, also while it is collapsed (Issue #115)', () => {
    const start: LogRow[] = [
      { key: 's1', text: 'Run step 1 started', tone: 'section' },
      { key: 'a', text: 'first', tone: 'plain' },
    ];
    const { rerender } = render(<LogViewer label="Run log" rows={start} />);
    const section = screen.getByRole('button', { name: /Run step 1 started/ });
    fireEvent.click(section);

    // A live batch appends rows: the same rows plus new ones, as the Run log passes them.
    const grown: LogRow[] = [
      ...start,
      { key: 'b', text: 'second', tone: 'plain' },
      { key: 's2', text: 'Run step 2 started', tone: 'section' },
      { key: 'c', text: 'third', tone: 'plain' },
    ];
    rerender(<LogViewer label="Run log" rows={grown} />);

    expect(section.textContent).toContain('· 2');
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('third').previousElementSibling?.textContent).toBe('5');
    expect(screen.getByRole('button', { name: /Run step 2 started/ }).textContent).toContain('· 1');

    // Rows that do not extend the previous ones (e.g. a reload) are laid out afresh.
    rerender(<LogViewer label="Run log" rows={[{ key: 'x', text: 'other', tone: 'plain' }]} />);
    expect(screen.getByText('other').previousElementSibling?.textContent).toBe('1');
    expect(screen.queryByText('third')).toBeNull();
  });

  it('keeps following when the operator is at the end', () => {
    render(<LogViewer label="Run log" rows={rows(100)} />);

    scrollTo(100 * LOG_ROW_HEIGHT - VIEWPORT, 100);

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('shows the reconnecting bar without clearing rows', async () => {
    const { container } = render(<LogViewer label="Run log" rows={rows(3)} reconnecting />);

    expect(
      screen.getAllByRole('status').some((status) => status.textContent?.includes('Reconnecting…')),
    ).toBe(true);
    expect(screen.getByText('line 3')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('announces what it is told politely, as the log itself is not a live region', () => {
    const { rerender } = render(<LogViewer label="Run log" rows={rows(1)} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    expect(log().getAttribute('aria-live')).toBe('off');

    rerender(
      <LogViewer label="Run log" rows={rows(1)} announcement="The log is streaming live." />,
    );

    expect(status.textContent).toBe('The log is streaming live.');
  });

  it('says why it is empty', () => {
    render(
      <LogViewer label="Run log" rows={[]} emptyText="Waiting for the agent’s first output…" />,
    );

    expect(screen.getByText('Waiting for the agent’s first output…')).toBeTruthy();
    expect(screen.getByText('0 lines')).toBeTruthy();
  });
});
