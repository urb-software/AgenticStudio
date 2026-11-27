import { describe, expect, it } from 'vitest';
import { AgentsReader, MAX_LISTED_AGENTS } from '../agents-reader.js';
import { SkillsReader } from '../skills-reader.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from './fake-definitions-files.js';

const agent = (name: string, provider = 'codex', extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}\nprovider: ${provider}\n${extra}---\nBody.\n`;

function reader(files: Record<string, string>) {
  const definitions = new FakeDefinitionsFiles(files);
  return { definitions, reader: new AgentsReader(definitions, new SkillsReader(definitions)) };
}

describe('AgentsReader.standings', () => {
  it('says whether each named definitions agent is valid, with its Provider; a missing one is absent', async () => {
    const { reader: agents } = reader({
      'agents/good/AGENT.md': agent('good', 'claude_code'),
      'agents/bad/AGENT.md': '---\nname: bad\n---\n',
    });

    const { standings, settled } = await agents.standings(BASE_COMMIT, ['good', 'bad', 'gone']);

    expect(settled).toBe(true);
    expect([...standings]).toEqual([
      ['bad', { valid: false, provider: null }],
      ['good', { valid: true, provider: 'claude_code' }],
    ]);
  });

  it('counts an agent that names a missing skill as invalid', async () => {
    const { reader: agents } = reader({
      'agents/needs/AGENT.md': agent('needs', 'codex', 'skills: [nope]\n'),
    });

    const { standings } = await agents.standings(BASE_COMMIT, ['needs']);

    expect(standings.get('needs')).toEqual({ valid: false, provider: null });
  });

  it('judges an agent beyond the cut list by itself, and keeps a missing name missing', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LISTED_AGENTS + 5; index += 1) {
      const name = `a${String(index).padStart(3, '0')}`;
      files[`agents/${name}/AGENT.md`] = agent(name);
    }
    const { reader: agents, definitions } = reader(files);

    const { standings, settled } = await agents.standings(BASE_COMMIT, ['a204', 'a000', 'zzz']);

    expect(settled).toBe(true);
    expect([...standings.keys()]).toEqual(['a000', 'a204']);
    expect(standings.get('a204')).toEqual({ valid: true, provider: 'codex' });
    expect(definitions.listTreeCalls).toBe(2);
  });

  it('fails closed when the listing was cut: an unlisted name is invalid, never missing', async () => {
    const { reader: agents, definitions } = reader({
      'agents/one/AGENT.md': agent('one'),
      'agents/two/AGENT.md': agent('two'),
    });
    definitions.truncated = true;

    const { standings } = await agents.standings(BASE_COMMIT, ['one', 'two', 'three']);

    expect(standings.get('three')).toEqual({ valid: false, provider: null });
    expect(standings.get('two')).toEqual({ valid: false, provider: null });
  });

  it('counts every name as invalid and unsettled when the Clone cannot be read', async () => {
    const { reader: agents, definitions } = reader({ 'agents/one/AGENT.md': agent('one') });
    definitions.unavailable = 'failed';

    const { standings, settled } = await agents.standings(BASE_COMMIT, ['one', 'two']);

    expect(settled).toBe(false);
    expect([...standings]).toEqual([
      ['one', { valid: false, provider: null }],
      ['two', { valid: false, provider: null }],
    ]);
  });

  it('keeps the judged list per commit: a second call reads no Git', async () => {
    const { reader: agents, definitions } = reader({ 'agents/one/AGENT.md': agent('one') });

    await agents.standings(BASE_COMMIT, ['one']);
    await agents.standings(BASE_COMMIT, ['one', 'two']);

    expect(definitions.listTreeCalls).toBe(1);
  });
});
