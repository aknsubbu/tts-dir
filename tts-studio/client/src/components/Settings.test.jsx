// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Settings from './Settings.jsx';
import { api } from '../api.js';
import { DEFAULT_PLAN } from '../../../shared/providers.js';

vi.mock('../api.js', () => ({
  api: {
    settings: vi.fn(),
    patchSettings: vi.fn(),
    undoSettings: vi.fn(),
    setKey: vi.fn(),
    removeKey: vi.fn(),
    saveProvider: vi.fn(),
    removeProvider: vi.fn(),
    testProvider: vi.fn(),
    connect: vi.fn(),
  },
}));

const CAPS = { structured: 'schema', images: true, pdf: true, effort: true, context: 1000000 };
const step = (label, effort, caps = CAPS) => ({ provider: 'claude-code', kind: 'claude-code', label, model: '', effort, caps });
const RESOLVED = {
  steps: { read: step('Claude Code', 'medium'), write: step('Claude Code', 'high'), fix: step('Claude Code', 'low'), polish: step('Claude Code', 'medium'), outline: step('Claude Code', 'medium') },
  handBack: { after: 2 },
  notesGo: [{ where: 'Anthropic', steps: ['reading your notes', 'writing the lesson', 'fixing and polishing'], local: false }],
};
const DATA = () => ({
  values: {
    'writer.page': DEFAULT_PLAN,
    'writer.claude': { same: true, plan: DEFAULT_PLAN },
    'lesson.defaults': { minutes: 2, quality: 'default', review: 'render', visualReview: false, voiceId: 'af_heart' },
    'claude.defaults': { minutes: 2, quality: 'default', review: 'render' },
    'claude.allow': { writer: true, effort: true, defaults: true, lowerCap: true, pageWriter: false },
    costs: { lessonCapUsd: 15, monthCapUsd: null },
    rates: {},
  },
  locks: { 'effort.write': 'TTS_CLAUDE_EFFORT' },
  providers: [
    { id: 'claude-code', kind: 'claude-code', label: 'Claude Code', company: 'Anthropic', destination: 'Anthropic', configured: true, needsKey: false, models: [], test: null },
    { id: 'openai', kind: 'openai', label: 'OpenAI', company: 'OpenAI', destination: 'OpenAI', configured: false, needsKey: true, key: { set: false, hint: null, from: null, env: 'OPENAI_API_KEY' }, models: [], test: null },
    { id: 'groq', kind: 'groq', label: 'Groq', company: 'Groq', destination: 'Groq', configured: true, needsKey: true, key: { set: true, hint: '…19ab', from: 'keychain', env: 'GROQ_API_KEY' }, models: ['llama-4'], test: { ok: true, at: Date.now(), model: 'llama-4', caps: { 'llama-4': { structured: 'json', images: true, pdf: false, context: 131072, tokensPerSec: 400 } } } },
    { id: 'ollama', kind: 'ollama', label: 'This Mac: Ollama', company: null, destination: 'nobody: it runs on this Mac', baseUrl: 'http://127.0.0.1:11434', configured: false, needsKey: false, models: [], test: { ok: false, at: Date.now(), error: 'Could not reach This Mac: Ollama at http://127.0.0.1:11434. Is it running?' } },
  ],
  resolved: { page: RESOLVED, claude: RESOLVED },
  rates: { date: '2026-10-06', builtIn: { 'anthropic:claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } },
  keysKeptIn: 'the macOS Keychain',
  history: [{ seq: 3, key: 'writer.claude', by: 'claude', at: Date.now() - 120000, undone: false, undoOf: null, summary: "Claude's lesson writer: Fixing and polishing provider: Claude Code → Groq", undoable: true }],
  costThisMonthUsd: 4.2,
  storage: { dataDir: '/x/data', projects: '/x/video/projects', envFile: null, keysKeptIn: 'the macOS Keychain' },
});

let toast, onChanged;
const show = async (section = 'writer') => {
  toast = vi.fn();
  onChanged = vi.fn();
  render(<Settings section={section} voices={[{ voiceId: 'af_heart', name: 'Heart', lang: 'a' }]} onClose={() => {}} onChanged={onChanged} toast={toast} />);
  await screen.findByRole('heading', { name: 'Providers' }).catch(() => screen.findByRole('tablist', { name: 'Settings sections' }));
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.settings.mockResolvedValue(DATA());
  api.patchSettings.mockImplementation(async () => DATA());
  api.setKey.mockResolvedValue(DATA());
  api.undoSettings.mockResolvedValue(DATA());
  api.testProvider.mockResolvedValue({ result: { ok: true, model: 'llama-4' } });
  api.connect.mockResolvedValue({
    http: { url: 'http://localhost:8787/mcp', claudeCode: 'claude mcp add --transport http narrated-proofs http://localhost:8787/mcp' },
    stdio: { command: '/usr/bin/node', args: ['/x/mcp/stdio.js'], claudeCode: 'claude mcp add narrated-proofs -- "/usr/bin/node" "/x/mcp/stdio.js"' },
    desktop: { configFile: '~/Library/Application Support/Claude/claude_desktop_config.json', entry: { mcpServers: { 'narrated-proofs': { command: '/usr/bin/node', args: ['/x/mcp/stdio.js'] } } }, pack: 'npm run mcp:pack' },
  });
});
afterEach(cleanup);

describe('Settings', () => {
  it('lists providers with their keys shown only by their ending, and what each Test found', async () => {
    await show();
    const groq = screen.getByText('Groq', { selector: 'strong' }).closest('li');
    expect(within(groq).getByText(/Key …19ab, kept in the Keychain/)).toBeTruthy();
    expect(within(groq).getByText('JSON mode')).toBeTruthy();
    expect(within(groq).getByText('no PDFs').className).toBe('no');
    const ollama = screen.getByText('This Mac: Ollama', { selector: 'strong' }).closest('li');
    expect(within(ollama).getByText(/Did not pass: Could not reach/)).toBeTruthy();
    expect(within(ollama).getByText('This Mac only')).toBeTruthy();
  });

  it('saves a key once and clears the box', async () => {
    await show();
    const openai = screen.getByText('OpenAI', { selector: 'strong' }).closest('li');
    const box = within(openai).getByLabelText('OpenAI key');
    expect(box.type).toBe('password');
    fireEvent.change(box, { target: { value: 'sk-test-123456789' } });
    fireEvent.click(within(openai).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(api.setKey).toHaveBeenCalledWith('openai', 'sk-test-123456789'));
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('switches to a writer per step and saves each choice as it is made', async () => {
    await show();
    fireEvent.click(screen.getByLabelText('Per step'));
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ 'writer.page': { mode: 'steps' } }));
    expect(screen.getByText(/Where your notes go:/).closest('p').textContent).toMatch(/Anthropic, for reading your notes, writing the lesson, fixing and polishing\. Scenes always run only on this Mac\./);
  });

  it('shows a value fixed by the environment as locked', async () => {
    api.settings.mockResolvedValue({ ...DATA(), values: { ...DATA().values, 'writer.page': { ...DEFAULT_PLAN, mode: 'steps' } } });
    await show();
    const effort = screen.getByLabelText('Writing the lesson: effort');
    expect(effort.disabled).toBe(true);
    expect(screen.getAllByText('Set in .env').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Fixing and polishing: effort').disabled).toBe(false);
  });

  it("shows what Claude changed, with an Undo", async () => {
    await show('claude');
    expect(screen.getByRole('status').textContent).toMatch(/Changed by Claude 2 min ago: .*Groq/);
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undoSettings).toHaveBeenCalledWith(3));
    const allow = screen.getByLabelText("The page's own writer, not only its own");
    expect(allow.checked).toBe(false);
    fireEvent.click(allow);
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ 'claude.allow': { pageWriter: true } }));
  });

  it('gives the commands to connect Claude, with real paths', async () => {
    await show('connect');
    await waitFor(() => expect(screen.getByText('claude mcp add --transport http narrated-proofs http://localhost:8787/mcp')).toBeTruthy());
    expect(screen.getByText('claude mcp add narrated-proofs -- "/usr/bin/node" "/x/mcp/stdio.js"')).toBeTruthy();
  });

  it('sets the spending caps', async () => {
    await show('costs');
    expect(screen.getByText('$4.20')).toBeTruthy();
    const cap = screen.getByLabelText(/Cap per month/);
    fireEvent.change(cap, { target: { value: '30' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ costs: { monthCapUsd: 30 } }));
  });
});
