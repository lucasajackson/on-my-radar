import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // `packages/phone/.out` is a run's evidence, including a copy of the built
    // SPA the suite serves. Linting it fails on bundled output the moment
    // anybody runs the suite before `pnpm lint`.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/.wrangler/**',
      'charts/**',
      'packages/phone/.out/**',
      // iCloud conflict copies ("file 2.ts") of real sources; see .gitignore.
      '**/* 2.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /*
   * Typed linting: typescript-eslint's strict-type-checked set, on TypeScript
   * only (the .js/.mjs files have no program to consult).
   *
   * Every rule in it is on for the server, the contract, the phone suite and
   * the scripts. Where an option is set below it says why; the SPA keeps its
   * own "not yet" list further down until its review clears it.
   */
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ['packages/**/*.{ts,tsx}'],
  })),
  {
    files: ['packages/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: {
          // Config files that no package tsconfig includes, because each is
          // outside that package's rootDir.
          allowDefaultProject: ['packages/server/vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * Not in the strict set, and the most useful of the lot for this
       * codebase: registries are string unions, and a `switch` over one that
       * forgets a member is how a new template or lane silently renders
       * nothing. A `default:` branch still counts as handling the rest.
       */
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],

      /*
       * Off on purpose, not debt. The phone suite writes `x === false` about
       * values that crossed `page.evaluate`, where the type says boolean and a
       * broken selector yields `undefined`; `!x` would pass vacuously on exactly
       * the defect the suite exists to catch.
       */
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',

      /*
       * Numbers may be interpolated. `${count}` has exactly one meaning — its
       * decimal form — so wrapping ~500 of them in String() would be noise that
       * catches nothing. What the rule is for stays enforced: `undefined`,
       * `null`, booleans, objects (`[object Object]`), `any` and `never` in a
       * template are still errors, because each is either a bug or a sentence
       * that reads "undefined" to a person.
       */
      // Every option spelled out: an options object replaces the strict
      // preset's, and the rule's own defaults allow any, boolean and nullish.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
          allowArray: false,
        },
      ],

      /*
       * `() => doSomething()` is how a callback is written; making every one a
       * block body to discard a `void` is churn. What the rule catches that
       * matters — `return voidCall()` and a void result used as a value — stays
       * an error.
       */
      /*
       * `while (true) { … if (done) break; }` is how a stream is read to its
       * end. Only the literal is allowed; any other constant condition is
       * still an error.
       */
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: 'only-allowed-literals' },
      ],

      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
    },
  },
  {
    /*
     * The Community Edition never imports the Enterprise Edition (ee/): the public export
     * does not contain it, so an import that works here would break the CE build there. The
     * dependency runs one way, ee/ onto packages/. A package.json dependency on an
     * `@onmyradar/ee-*` package is refused for the same reason by the CE-only build.
     */
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@onmyradar/ee-*', 'ee/**', '**/ee/**'],
              message:
                'packages/ is the Community Edition and must not import from ee/. EE code registers itself through the extension registry; see ee/README.md.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * Tests only, and on purpose (38 on 2026-09-26). A stub standing in for an
     * async function — `drainOne: async () => undefined`, an outbox handler, a
     * DNS lookup — is written `async` so that it returns a promise and a throw
     * inside it becomes a rejection, exactly as the real one's would. It has no
     * `await` by nature; removing `async` would change what the stub does.
     */
    files: ['packages/server/**/*.test.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    /*
     * The SPA is clear of the whole "not yet" list: every rule in
     * strict-type-checked is on for packages/ui. Two carry options, each
     * because the default flags idiomatic code rather than a defect:
     *
     * - no-confusing-void-expression, with `ignoreArrowShorthand`. 464 of its
     *   465 hits were `onClick={() => setOpen(true)}`: a JSX handler whose body
     *   is one call. React ignores a handler's return value, so rewriting each
     *   as a block body would be noise. The one real hit, a `return onCancel()`
     *   in a function whose result is read, was fixed.
     * - restrict-template-expressions, with `allowNumber`. All 108 hits were
     *   counts in copy ("3 blips"), where a number's string form is the text we
     *   want. Objects, nullish values and booleans in templates are still errors.
     *
     * no-misused-promises: an `async` handler handed to `onClick` returns a
     * promise nobody awaits, so an uncaught rejection is silent. Handlers are
     * `() => void (async () => { … })()` with their own catch.
     */
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
    },
  },
  {
    /*
     * Tests only: `await act(async () => root.render(…))` is React's own
     * contract. The async callback is what makes act await the effects and
     * microtasks the render queues, and it has nothing of its own to await.
     * All 157 require-await hits in ui tests were that shape; the one in
     * source was fixed.
     */
    files: ['packages/ui/**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['packages/email-worker/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.serviceworker } },
  },
  {
    /*
     * The service worker. It is plain .js served from the origin root — it
     * cannot be bundled, because a worker's scope is the directory it was served
     * from — so it falls outside the packages/**\/*.ts{,x} block above and gets
     * neither its globals nor its parser. `self`, `clients` and the rest live in
     * the service-worker global scope, which is neither node nor browser.
     */
    files: ['packages/ui/public/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
  {
    /*
     * The phone suite. It is a command-line runner whose entire output is a
     * printed verdict, so `console` is the product, not a stray debug line.
     */
    files: ['packages/phone/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    /*
     * One-off operator scripts (the Claude Code agent importer). Same reason as
     * the phone suite: a CLI's printed verdict is its interface. The server's
     * own code stays on the structured logger.
     */
    files: ['packages/server/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['packages/ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name="select"]',
          // "Dropdowns in the UI need to match the UI, not the system": a native
          // <select> opens the operating system's menu. The shared Select has
          // groups and a description line, so nothing needs the native one.
          message:
            'No native <select>: use Select from packages/ui/src/components/select.tsx (option groups via `groups`, a second line via `description`) so the menu matches the app, not the operating system.',
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The boot CLI ships as one plain Node file (docs/AGENT_REPO.md §V2.18);
    // its tests run under `node --test` from scripts/.
    files: ['agent-setup/**/*.mjs', 'scripts/omr-agent.test.mjs'],
    languageOptions: { globals: globals.node },
  },
);
