import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
export const WORDS_PER_MINUTE = 165; // Kokoro at speed 1, pauses included
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').trim();

/** Replace every {{name}} in a template. A name with no value is a bug in the caller, so it throws. */
export function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (values[key] === undefined) throw new Error(`Prompt template wants {{${key}}} and it was not given.`);
    return String(values[key]);
  });
}

// Read fresh each time, so a prompt can be edited without restarting the server.

/** The system prompt: how to write a lesson, with the worked example filled in. */
export function guide() {
  return fill(read('guide.md'), {
    example_script: read('example/script.txt'),
    example_scenes: read('example/scenes.py'),
  });
}

const minutesLabel = (m) => (m === 1 ? 'one minute' : `${m} minutes`);

export function lessonPrompt({ topic, goal, notes, minutes, voice }) {
  const words = minutes * WORDS_PER_MINUTE;
  return fill(read('lesson.md'), {
    topic,
    goal: goal || 'A clear first understanding of the topic.',
    notes: notes || '(none given)',
    minutes: minutesLabel(minutes),
    words_min: Math.round((words * 0.85) / 10) * 10,
    words_max: Math.round((words * 1.1) / 10) * 10,
    blocks_min: Math.max(3, Math.round(words / 40)),
    blocks_max: Math.max(4, Math.round(words / 25)),
    voice,
  });
}

const list = (items) => items.map((p) => `- ${p.where}: ${p.message.includes('\n') ? `\n${p.message}` : p.message}`).join('\n');

/**
 * The follow-up when a check found problems. `errors` stop the video from being built;
 * `warnings` only make it look or sound wrong.
 */
export function repairPrompt({ topic, goal, script, scenes, errors, warnings }) {
  const broken = errors.length > 0;
  return fill(read('repair.md'), {
    topic,
    goal: goal || 'A clear first understanding of the topic.',
    script,
    scenes,
    verdict: broken ? 'It does not build yet.' : 'It builds, but some things look or sound wrong.',
    problems: [
      broken ? `These stop the video from being built:\n${list(errors)}` : '',
      warnings.length ? `These ${broken ? 'also ' : ''}make it look or sound wrong:\n${list(warnings)}` : '',
    ].filter(Boolean).join('\n\n'),
    instructions: broken
      ? 'Fix every problem. A traceback means that line failed when the scene ran: the usual causes are a name that does not exist in ManimGL, wrong arguments, or LaTeX that does not compile.'
      : 'Fix these without restructuring the lesson. For timing: shorten or remove fixed run times before the word, or move the mark later in the sentence. For text off the frame: make it smaller, wrap it, or move it. For overlapping text: fade the old text out first, or move one of them.',
  });
}
