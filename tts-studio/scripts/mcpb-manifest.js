// The manifest of the desktop extension that npm run mcp:pack makes. See mcp-pack.js.
// manifest_version 0.3 is the first with user_config, which asks the person for a value when the
// extension is installed and keeps it where the app keeps secrets ("sensitive").

export function buildManifest({ version, url }) {
  return {
    manifest_version: '0.3',
    name: 'narrated-proofs',
    display_name: 'Narrated Proofs',
    version,
    description: 'Make narrated maths video lessons from a conversation, follow them, and fetch the video.',
    author: { name: 'Narrated Proofs' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          NARRATED_PROOFS_URL: url || 'http://127.0.0.1:8787',
          // Empty when left blank, which the connector reads as "no token".
          NARRATED_PROOFS_TOKEN: '${user_config.token}',
        },
      },
    },
    user_config: {
      token: {
        type: 'string',
        title: 'Connector token',
        description: 'Needed when more than one person uses the dashboard: Claude then acts as the profile the token belongs to. Make one in the dashboard under Settings → Connect Claude. Leave empty if only one person uses it and it has no PIN.',
        sensitive: true,
        required: false,
      },
    },
    tools: [
      ['make_lesson', 'Start a lesson from a topic, notes and files'],
      ['revise_lesson', 'Ask for a change to a lesson'],
      ['approve_lesson', 'Continue a lesson waiting on its storyboard, narration or outline'],
      ['redo_outline', "Have a long lesson's outline written again"],
      ['wait_for_lesson', 'Follow a lesson through its stages'],
      ['lesson_status', 'Where a lesson is'],
      ['search_lessons', 'Search the library'],
      ['get_lesson', "A lesson's brief, script and scenes"],
      ['get_video', "A finished lesson's video"],
      ['cancel_lesson', 'Stop a lesson'],
      ['retry_lesson', 'Try a lesson again'],
      ['list_voices', 'The English voices'],
      ['get_settings', 'Who writes lessons, defaults and caps'],
      ['update_settings', 'Change what the person allows'],
      ['test_writer', "Run a provider's Test"],
    ].map(([name, description]) => ({ name, description })),
    compatibility: { platforms: ['darwin'], runtimes: { node: '>=20.0.0' } },
  };
}
