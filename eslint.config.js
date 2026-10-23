import neostandard from 'neostandard';

export default [
  ...neostandard({
    semi: true,
    ts: true
  }),
  {
    ignores: [
      'dist/*',
      'node_modules/*',
      // Packaged plugin output and the committed diagnostic evidence.
      'artifacts/*',
      'dogfood/*'
    ]
  }
];
