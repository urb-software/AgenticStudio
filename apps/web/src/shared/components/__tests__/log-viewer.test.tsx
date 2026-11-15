import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_ROW_HEIGHT, LogViewer, type LogRow } from '../log-viewer';

// Issue #99: the LogViewer of the design system. jsdom lays nothing out, so the viewer's
// height is stubbed (400px: 20 rows) and scroll positions are set by hand.
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

  it('keeps following when the operator is at the end', () => {
    render(<LogViewer label="Run log" rows={rows(100)} />);

    scrollTo(100 * LOG_ROW_HEIGHT - VIEWPORT, 100);

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('shows the reconnecting bar without clearing rows', async () => {
    const { container } = render(<LogViewer label="Run log" rows={rows(3)} reconnecting />);

    expect(screen.getByRole('status').textContent).toContain('Reconnecting…');
    expect(screen.getByText('line 3')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says why it is empty', () => {
    render(
      <LogViewer label="Run log" rows={[]} emptyText="Waiting for the agent’s first output…" />,
    );

    expect(screen.getByText('Waiting for the agent’s first output…')).toBeTruthy();
    expect(screen.getByText('0 lines')).toBeTruthy();
  });
});
