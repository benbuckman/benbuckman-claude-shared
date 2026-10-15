// Unit tests for scripts/gh-link. Uses Node's built-in test runner (`node:test`)
// with strict assert. Node 22.18 or later runs TypeScript directly:
//
//   node --test tests/gh-link.test.ts
//
// SPDX-License-Identifier: MIT

import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GH_LINK = path.join(HERE, '..', 'scripts', 'gh-link');
// Default working directory for tests that pass -R and an explicit ref, which
// need no git context. tmpdir() is outside any repo, so a test that needs one
// has to say so by running in GIT_SANDBOX.
const REPO_ROOT = tmpdir();

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Temp working directory with a real `git init` — used by tests that exercise
// local-git mode (no -R), where gh-link calls `git rev-parse --show-toplevel`.
// A sandbox makes those tests independent of where this file is checked out,
// including copies with no .git directory, where the script would exit 3
// instead of reaching the path-existence check.
//
// We also create a secondary worktree (WORKTREE_SANDBOX) attached to the same
// repo, so we can exercise the absolute-path normalization against worktrees
// (mimicking a real-world setup such as <repo>/.claude/worktrees/foo-bar/).
let GIT_SANDBOX: string;
let WORKTREE_SANDBOX: string;

before(() => {
  GIT_SANDBOX = mkdtempSync(path.join(tmpdir(), 'gh-link-test-'));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid'
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: GIT_SANDBOX});
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/foo/bar.git'], {cwd: GIT_SANDBOX});
  // A real file inside the sandbox, used by the absolute-path tests.
  mkdirSync(path.join(GIT_SANDBOX, 'bin'), {recursive: true});
  writeFileSync(path.join(GIT_SANDBOX, 'bin', 'real-file.ts'), '// test fixture\n');
  // A commit is required before we can create a worktree.
  execFileSync('git', ['add', '.'], {cwd: GIT_SANDBOX, env: gitEnv});
  execFileSync('git', ['commit', '-q', '-m', 'init'], {cwd: GIT_SANDBOX, env: gitEnv});

  // Secondary worktree on the same repo. `git worktree add` requires the
  // target path to not exist, so derive a sibling path of GIT_SANDBOX.
  WORKTREE_SANDBOX = `${GIT_SANDBOX}-worktree`;
  execFileSync('git', ['worktree', 'add', '-q', '--detach', WORKTREE_SANDBOX, 'HEAD'], {cwd: GIT_SANDBOX, env: gitEnv});
});

after(() => {
  // Remove the worktree first (cleans up git's bookkeeping under .git/worktrees/).
  try {
    execFileSync('git', ['worktree', 'remove', '--force', WORKTREE_SANDBOX], {cwd: GIT_SANDBOX});
  } catch {
    // Fall through to the rmSync below.
  }
  rmSync(WORKTREE_SANDBOX, {recursive: true, force: true});
  rmSync(GIT_SANDBOX, {recursive: true, force: true});
});

// `os.environ` equivalent with git's repo-local variables stripped, so the git
// commands below are hermetic to their `cwd`. This matters more here than in a
// typical test: `GIT_DIR` outranks `cwd`, so without the scrub an inherited
// `GIT_DIR` would send `git config core.bare true` to the developer's own
// checkout — the precise corruption gh-link's diagnostic exists to explain.
// `git rev-parse --local-env-vars` is the authoritative list, so this also
// covers the config-injection variables a hand-written list misses.
function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env = {...process.env};
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {encoding: 'utf8'})
    .split('\n')
    .filter(Boolean);
  for (const name of names) delete env[name];
  return env;
}

function run(args: string[], cwd: string = REPO_ROOT): RunResult {
  const result = spawnSync(GH_LINK, args, {encoding: 'utf8', cwd});
  return {
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? '').trimEnd(),
    status: result.status ?? -1
  };
}

// ---- Blob: line specs --------------------------------------------------

test('blob: bare line', () => {
  const {stdout, status} = run(['file.tsx:6', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6');
});

test('blob: bare line range', () => {
  const {stdout, status} = run(['file.tsx:6-8', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6-L8');
});

test('blob: # separator equivalent to :', () => {
  const {stdout, status} = run(['file.tsx#6', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6');
});

test('blob: explicit L-prefix passes through verbatim', () => {
  const {stdout, status} = run(['file.tsx#L6', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6');
});

test('blob: single column position (no range)', () => {
  const {stdout, status} = run(['file.tsx#L6C5', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6C5');
});

test('blob: column range (undocumented GH fragment) passes through', () => {
  const {stdout, status} = run(['file.tsx#L6C5-L6C20', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6C5-L6C20');
});

test('blob: multi-line column range passes through', () => {
  const {stdout, status} = run(['file.tsx#L6C5-L8C10', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx?plain=1#L6C5-L8C10');
});

test('blob: mixed L-prefix is rejected (falls through to path-not-found)', () => {
  // `L6-8` is half-prefixed — regex rejects, whole input treated as path.
  // -R + --commit means no path-existence check, so verify by using local-git
  // mode (no -R) instead. Use GIT_SANDBOX so this works in the CI container,
  // where REPO_ROOT has no .git directory.
  const {status} = run(['file.tsx#L6-8', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 2); // path-not-found
});

test('blob: no line spec', () => {
  const {stdout, status} = run(['file.tsx', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/file.tsx');
});

// ---- Blob: refs --------------------------------------------------------

test('blob: --branch=X uses X as ref', () => {
  const {stdout, status} = run(['file.tsx:6', '-R', 'foo/bar', '--branch=my-feature']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/my-feature/file.tsx?plain=1#L6');
});

test('blob: --branch= and --branch X both work', () => {
  const a = run(['file.tsx', '-R', 'foo/bar', '--branch=master']);
  const b = run(['file.tsx', '-R', 'foo/bar', '--branch', 'master']);
  assert.equal(a.stdout, b.stdout);
});

test('blob: default ref is HEAD when the clone has no origin/HEAD', () => {
  // GIT_SANDBOX was made with `git init` and `git remote add`, which don't set
  // origin/HEAD. GitHub resolves `HEAD` to the repo's default branch.
  const absPath = path.join(GIT_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run([absPath], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/HEAD/bin/real-file.ts');
});

test('blob: default ref is the branch origin/HEAD names, when it is set', () => {
  // A fresh `git clone` sets origin/HEAD. Simulate that with a ref under
  // refs/remotes, then remove it so other tests still see none.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/trunk', 'HEAD'], {cwd: GIT_SANDBOX});
  execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {cwd: GIT_SANDBOX});
  try {
    const {stdout, status} = run(['bin/real-file.ts'], GIT_SANDBOX);
    assert.equal(status, 0);
    assert.equal(stdout, 'https://github.com/foo/bar/blob/trunk/bin/real-file.ts');
    // origin/HEAD describes this clone's own repo, so -R another repo ignores it.
    const other = run(['bin/real-file.ts', '-R', 'other/repo'], GIT_SANDBOX);
    assert.equal(other.stdout, 'https://github.com/other/repo/blob/HEAD/bin/real-file.ts');
  } finally {
    execFileSync('git', ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], {cwd: GIT_SANDBOX});
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/trunk'], {cwd: GIT_SANDBOX});
  }
});

test('blob: an absolute path through a symlink resolves to the repo-relative path', () => {
  // git reports the toplevel with symlinks resolved. A path given through a
  // symlink, such as macOS's /var -> /private/var or a skills directory linked
  // from a dotfiles repo, must still be found inside it.
  const link = `${GIT_SANDBOX}-symlink`;
  symlinkSync(GIT_SANDBOX, link);
  try {
    const {stdout, status} = run([path.join(link, 'bin', 'real-file.ts') + ':6', '--branch=main'], GIT_SANDBOX);
    assert.equal(status, 0);
    assert.equal(stdout, 'https://github.com/foo/bar/blob/main/bin/real-file.ts?plain=1#L6');
  } finally {
    unlinkSync(link);
  }
});

test('blob: GH_LINK_DEFAULT_REF overrides the default ref', () => {
  const r = spawnSync(GH_LINK, ['bin/real-file.ts'], {
    cwd: GIT_SANDBOX, encoding: 'utf8', env: {...process.env, GH_LINK_DEFAULT_REF: 'develop'}
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'https://github.com/foo/bar/blob/develop/bin/real-file.ts');
});

// ---- Tree mode ---------------------------------------------------------

test('tree: with path', () => {
  const {stdout, status} = run(['--mode=tree', 'packages/app', '-R', 'foo/bar', '--branch=master']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/tree/master/packages/app');
});

test('tree: empty path → repo root', () => {
  const {stdout, status} = run(['--mode=tree', '-R', 'foo/bar', '--branch=master']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/tree/master');
});

test('tree: rejects line specs', () => {
  const {status, stderr} = run(['--mode=tree', 'packages/app:6', '-R', 'foo/bar', '--branch=master']);
  assert.equal(status, 1);
  assert.match(stderr, /line specs don't apply in tree mode/);
});

// ---- Compare mode ------------------------------------------------------

test('compare: triple-dot', () => {
  const {stdout, status} = run(['--mode=compare', 'master...feature', '-R', 'foo/bar']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/compare/master...feature');
});

test('compare: double-dot also accepted', () => {
  const {stdout, status} = run(['--mode=compare', 'master..feature', '-R', 'foo/bar']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/compare/master..feature');
});

test('compare: rejects --commit', () => {
  const {status, stderr} = run(['--mode=compare', 'master...feature', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 1);
  assert.match(stderr, /don't apply in compare mode/);
});

test('compare: requires base..head shape', () => {
  const {status, stderr} = run(['--mode=compare', 'just-a-branch', '-R', 'foo/bar']);
  assert.equal(status, 1);
  assert.match(stderr, /expects <base>\.\.\.<head>/);
});

// ---- PR mode -----------------------------------------------------------

// The anchor format, `diff-<sha256 of the repo-relative path>`, was checked
// by hand-clicking diff anchors on real merged PRs. These cases keep that
// format with neutral paths and PR numbers, and their hashes were recomputed.
test('pr: bin/gh-link in PR #101 (anchor format verified)', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=101', '-R', 'example-org/example-repo', 'bin/gh-link'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/101/files' +
    '#diff-9d3634eaf2133c6d40dc7871ce0b495e4e4a2d98454bd0ca2b1b254ecbb08097');
});

test('pr: nested path in PR #102 (anchor format verified)', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=102', '-R', 'example-org/example-repo',
    'docs/reports/templates/summary.html'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/102/files' +
    '#diff-317aab2f8c10f70388c9807f3f0ee7106d3d1baa33d2cb1e6de138069e742cb4');
});

test('pr: --pr= equals form works', () => {
  const a = run(['--mode=pr', '--pr=42', '-R', 'foo/bar', 'x.ts']);
  const b = run(['--mode=pr', '--pr', '42', '-R', 'foo/bar', 'x.ts']);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, 0);
});

test('error: pr mode requires --pr', () => {
  const {status, stderr} = run(['--mode=pr', '-R', 'foo/bar', 'x.ts']);
  assert.equal(status, 1);
  assert.match(stderr, /pr mode requires --pr/);
});

test('error: --pr must be a positive integer (rejects abc)', () => {
  const {status, stderr} = run(['--mode=pr', '--pr=abc', '-R', 'foo/bar', 'x.ts']);
  assert.equal(status, 1);
  assert.match(stderr, /--pr must be a positive integer/);
});

test('error: --pr rejects 0', () => {
  const {status, stderr} = run(['--mode=pr', '--pr=0', '-R', 'foo/bar', 'x.ts']);
  assert.equal(status, 1);
  assert.match(stderr, /--pr must be a positive integer/);
});

test('error: --pr rejects leading zeros', () => {
  const {status, stderr} = run(['--mode=pr', '--pr=007', '-R', 'foo/bar', 'x.ts']);
  assert.equal(status, 1);
  assert.match(stderr, /no leading zeros/);
});

test('error: pr mode rejects --commit', () => {
  const {status, stderr} = run([
    '--mode=pr', '--pr=42', '--commit=abc', '-R', 'foo/bar', 'x.ts'
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /--commit.*don't apply in pr mode/);
});

test('error: pr mode rejects --branch', () => {
  const {status, stderr} = run([
    '--mode=pr', '--pr=42', '--branch=master', '-R', 'foo/bar', 'x.ts'
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /--commit.*don't apply in pr mode/);
});

test('error: pr mode requires a path', () => {
  const {status, stderr} = run(['--mode=pr', '--pr=42', '-R', 'foo/bar']);
  assert.equal(status, 1);
  assert.match(stderr, /pr mode requires <path>/);
});

// Path normalization in pr mode — regression coverage for the cwd-offset bug
// (a review of the change that added pr mode found that the prefix prepend was wrapped in
// `if [[ -z "$repo" ]]`, so -R + a cwd-relative path from a subdirectory
// silently produced the wrong anchor).

test('pr: cwd-relative path from a subdirectory prepends the cwd offset (even with -R)', () => {
  // Inside GIT_SANDBOX/bin, "real-file.ts" exists locally → should resolve
  // to bin/real-file.ts (the path the diff anchor hashes). Without the fix
  // this hashed "real-file.ts" instead.
  const subDir = path.join(GIT_SANDBOX, 'bin');
  const {stdout, status} = run(
    ['--mode=pr', '--pr=101', '-R', 'foo/bar', 'real-file.ts'],
    subDir
  );
  assert.equal(status, 0);
  // sha256 of "bin/real-file.ts"
  const expectedHash = '4fdcb32ed16de05320340cda4118f520512354b942338d3df62e1ee172aacc8c';
  assert.equal(
    stdout,
    `https://github.com/foo/bar/pull/101/files#diff-${expectedHash}`
  );
});

test('pr: repo-root-relative path from a subdirectory is NOT double-prefixed', () => {
  // Inside GIT_SANDBOX/bin, "bin/real-file.ts" does NOT exist locally but
  // does exist at the toplevel. Helper should treat it as repo-relative,
  // not prepend the cwd prefix (which would make it bin/bin/real-file.ts).
  const subDir = path.join(GIT_SANDBOX, 'bin');
  const {stdout, status} = run(
    ['--mode=pr', '--pr=101', '-R', 'foo/bar', 'bin/real-file.ts'],
    subDir
  );
  assert.equal(status, 0);
  // Same hash as the cwd-relative case above — both resolve to bin/real-file.ts.
  const expectedHash = '4fdcb32ed16de05320340cda4118f520512354b942338d3df62e1ee172aacc8c';
  assert.equal(
    stdout,
    `https://github.com/foo/bar/pull/101/files#diff-${expectedHash}`
  );
});

test('pr: absolute path is normalized to repo-relative', () => {
  const absPath = path.join(GIT_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run(
    ['--mode=pr', '--pr=101', '-R', 'foo/bar', absPath],
    GIT_SANDBOX
  );
  assert.equal(status, 0);
  const expectedHash = '4fdcb32ed16de05320340cda4118f520512354b942338d3df62e1ee172aacc8c';
  assert.equal(
    stdout,
    `https://github.com/foo/bar/pull/101/files#diff-${expectedHash}`
  );
});

// PR line-anchor support: GitHub's PR diff view accepts `R<n>` (right
// side / current state) or `L<n>` (left side / deleted) suffixes on the
// diff anchor. The four verified URLs below are from real merged PRs.

test('pr: line spec — bare digits default to R (right side)', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md:130'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/103/files' +
    '#diff-99bab5dac2c89eda9718984a17589368a6d4e45bf3abcdab3d525af5553bf432R130');
});

test('pr: line range — bare digits default to R-R', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md:130-132'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/103/files' +
    '#diff-99bab5dac2c89eda9718984a17589368a6d4e45bf3abcdab3d525af5553bf432R130-R132');
});

test('pr: explicit L<n> (left side / deleted line)', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'skills/status-update/SKILL.md:L150'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/103/files' +
    '#diff-46a45c024869746a3491a4ce051ecb17970d0ee034ef0dec129acf4d94153575L150');
});

test('pr: explicit L<n>-L<m> range (deleted hunk in a removed file)', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=99', '-R', 'example-org/example-repo',
    '.github/workflows/release.yml:L6-L8'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/99/files' +
    '#diff-87db21a973eed4fef5f32b267aa60fcee5cbdf03c67fafdc2a9b553bb0b15f34L6-L8');
});

test('pr: # separator works the same as : (mirrors blob mode)', () => {
  // Regression test: pr mode previously only
  // accepted `:`, silently consuming `#` into the path and producing the
  // wrong sha256.
  const colon = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md:130'
  ]);
  const hash = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md#130'
  ]);
  assert.equal(colon.status, 0);
  assert.equal(hash.status, 0);
  assert.equal(colon.stdout, hash.stdout);
});

test('pr: # separator preserves explicit L side', () => {
  const {stdout, status} = run([
    '--mode=pr', '--pr=99', '-R', 'example-org/example-repo',
    '.github/workflows/release.yml#L6-L8'
  ]);
  assert.equal(status, 0);
  assert.equal(stdout,
    'https://github.com/example-org/example-repo/pull/99/files' +
    '#diff-87db21a973eed4fef5f32b267aa60fcee5cbdf03c67fafdc2a9b553bb0b15f34L6-L8');
});

test('pr: explicit R<n> is preserved (redundant but allowed)', () => {
  const a = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md:130'
  ]);
  const b = run([
    '--mode=pr', '--pr=103', '-R', 'example-org/example-repo',
    'docs/style/writing-guide.md:R130'
  ]);
  assert.equal(a.stdout, b.stdout);
});

test('error: pr mode rejects cross-side range L-R', () => {
  const {status, stderr} = run([
    '--mode=pr', '--pr=42', '-R', 'foo/bar', 'x.ts:L42-R50'
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /cross-side ranges.*aren't supported/);
});

test('error: pr mode rejects cross-side range R-L', () => {
  const {status, stderr} = run([
    '--mode=pr', '--pr=42', '-R', 'foo/bar', 'x.ts:R42-L50'
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /cross-side ranges.*aren't supported/);
});

test('error: pr mode rejects column specs', () => {
  const {status, stderr} = run([
    '--mode=pr', '--pr=42', '-R', 'foo/bar', 'x.ts:L42C5'
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /doesn't support column specs/);
});

test('pr: lenient mode — path that exists nowhere locally is trusted as repo-relative', () => {
  // Useful for referencing files in someone else's PR not checked out
  // locally. No error; the hash is computed from the input as given.
  const {stdout, status} = run(
    ['--mode=pr', '--pr=101', '-R', 'foo/bar', 'totally/made/up/path.md'],
    GIT_SANDBOX
  );
  assert.equal(status, 0);
  const expectedHash = createHash('sha256').update('totally/made/up/path.md').digest('hex');
  assert.equal(
    stdout,
    `https://github.com/foo/bar/pull/101/files#diff-${expectedHash}`
  );
});

// ---- Repo derivation ---------------------------------------------------

test('-R override skips git context when --commit also given', () => {
  // Path is bogus but -R + --commit means no path-existence check, no git lookup.
  const {stdout, status} = run(['totally/fake/path.ts:42', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/totally/fake/path.ts?plain=1#L42');
});

// ---- Error paths -------------------------------------------------------

test('error: missing path (blob mode)', () => {
  const {status, stderr} = run([]);
  assert.equal(status, 1);
  assert.match(stderr, /missing <path>/);
});

test('error: --commit and --branch mutex', () => {
  const {status, stderr} = run(['file.tsx', '-R', 'foo/bar', '--commit=abc', '--branch=master']);
  assert.equal(status, 1);
  assert.match(stderr, /mutually exclusive/);
});

test('error: bogus mode', () => {
  const {status, stderr} = run(['--mode=garbage', 'file.tsx', '-R', 'foo/bar', '--commit=abc']);
  assert.equal(status, 1);
  assert.match(stderr, /invalid --mode/);
});

test('error: unknown flag', () => {
  const {status, stderr} = run(['--bogus', 'file.tsx']);
  assert.equal(status, 1);
  assert.match(stderr, /unknown flag/);
});

test('error: --commit= with empty value', () => {
  const {status, stderr} = run(['--commit=', 'file.tsx', '-R', 'foo/bar']);
  assert.equal(status, 1);
  assert.match(stderr, /--commit requires a non-empty value/);
});

test('error: --commit alone (no value follows)', () => {
  const {status, stderr} = run(['--commit']);
  assert.equal(status, 1);
  assert.match(stderr, /--commit requires a non-empty value/);
});

test('error: --branch followed by flag-shaped token is rejected', () => {
  // Without validation, `--branch` would silently swallow `--commit=abc` as
  // the branch name, then later use it as the URL ref.
  const {status, stderr} = run(['--branch', '--commit=abc', 'file.tsx', '-R', 'foo/bar']);
  assert.equal(status, 1);
  assert.match(stderr, /--branch expected a value but next token looks like a flag: --commit=abc/);
});

test('error: -R followed by flag-shaped token is rejected', () => {
  const {status, stderr} = run(['-R', '--commit=abc', 'file.tsx']);
  assert.equal(status, 1);
  assert.match(stderr, /-R expected a value but next token looks like a flag: --commit=abc/);
});

test('escape hatch: --branch=-foo accepts dash-prefixed value via equals form', () => {
  // Equals form bypasses the flag-shaped-token check, since `=` makes the
  // value unambiguous. Useful for the rare branch name starting with `-`.
  const {stdout, status} = run(['file.tsx:1', '-R', 'foo/bar', '--branch=-feature-x']);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/-feature-x/file.tsx?plain=1#L1');
});

test('error: path not found (exits 2)', () => {
  // No -R, so local-git mode → path is checked against the working tree.
  // Use GIT_SANDBOX so this works in the CI container.
  const {status} = run(['nope/does/not/exist.ts:42', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 2);
});

// ---- Absolute paths ----------------------------------------------------

test('blob: absolute path inside toplevel is normalized to repo-relative', () => {
  // Without the absolute-path normalization, this would emit
  //   .../blob/master//<sandbox>/bin/real-file.ts#L6      (double slash)
  // because bash collapses `$toplevel/$path` only at the `-e` filesystem
  // test, not in the string itself.
  const absPath = path.join(GIT_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run([`${absPath}:6`, '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/bin/real-file.ts?plain=1#L6');
});

test('blob: absolute path inside toplevel, no line spec', () => {
  const absPath = path.join(GIT_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run([absPath, '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/bin/real-file.ts');
});

test('error: absolute path not under the git toplevel (exits 2)', () => {
  // /etc/hostname exists on Linux but isn't under GIT_SANDBOX.
  const {status, stderr} = run(['/etc/hostname', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 2);
  assert.match(stderr, /not under the git toplevel/);
});

test('blob: cwd-relative path wins over repo-root when both exist', () => {
  // From inside <sandbox>/sub, gh-link should resolve `dup.md` to
  // sub/dup.md rather than the root dup.md, matching how every other
  // Unix tool interprets a bare relative filename.
  const subDir = path.join(GIT_SANDBOX, 'sub');
  mkdirSync(subDir, {recursive: true});
  writeFileSync(path.join(GIT_SANDBOX, 'dup.md'), 'at root\n');
  writeFileSync(path.join(subDir, 'dup.md'), 'in sub\n');
  const {stdout, status} = run(['dup.md', '--branch=master'], subDir);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/sub/dup.md');
});

test('blob: repo-root-relative path still resolves when cwd has no match', () => {
  // From <sandbox>/sub, gh-link bin/real-file.ts should still resolve
  // (./bin/real-file.ts doesn't exist; ./../bin/real-file.ts does, but
  // the lookup is at toplevel via the repo-root fallback).
  const subDir = path.join(GIT_SANDBOX, 'sub');
  mkdirSync(subDir, {recursive: true});
  const {stdout, status} = run(['bin/real-file.ts', '--branch=master'], subDir);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/bin/real-file.ts');
});

// ---- URL encoding -------------------------------------------------------

test('blob: path with space is percent-encoded', () => {
  writeFileSync(path.join(GIT_SANDBOX, 'has space.md'), 'spaced\n');
  const {stdout, status} = run(['has space.md', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/has%20space.md');
});

test('blob: unreserved characters in path are preserved (not encoded)', () => {
  // RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
  // Slashes are also preserved (path separator).
  writeFileSync(path.join(GIT_SANDBOX, 'a-b_c.d~e.md'), 'fine\n');
  const {stdout, status} = run(['a-b_c.d~e.md', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/a-b_c.d~e.md');
});

test('blob: nested subdirectory keeps slashes literal', () => {
  mkdirSync(path.join(GIT_SANDBOX, 'a b', 'c d'), {recursive: true});
  writeFileSync(path.join(GIT_SANDBOX, 'a b', 'c d', 'file.md'), 'nested\n');
  const {stdout, status} = run(['a b/c d/file.md', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  // Spaces encoded, slashes preserved.
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/a%20b/c%20d/file.md');
});

// ---- Origin URL parsing -------------------------------------------------

// Helper: build a one-off git repo with the given origin URL, run gh-link
// against a file in it, and return the result. Each call gets its own
// sandbox so the tests don't interfere with each other.
function runWithOrigin(originUrl: string, args: string[]): RunResult {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'gh-link-origin-'));
  try {
    execFileSync('git', ['init', '-q'], {cwd: sandbox});
    execFileSync('git', ['remote', 'add', 'origin', originUrl], {cwd: sandbox});
    writeFileSync(path.join(sandbox, 'file.ts'), '// origin test\n');
    return run(args, sandbox);
  } finally {
    rmSync(sandbox, {recursive: true, force: true});
  }
}

test('origin parsing: https://github.com/owner/repo.git', () => {
  const {stdout, status} = runWithOrigin(
    'https://github.com/example-org/example-repo.git',
    ['file.ts:1', '--branch=master']
  );
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/example-org/example-repo/blob/master/file.ts?plain=1#L1');
});

test('origin parsing: git@github.com:owner/repo.git (SCP form)', () => {
  const {stdout, status} = runWithOrigin(
    'git@github.com:example-org/example-repo.git',
    ['file.ts:1', '--branch=master']
  );
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/example-org/example-repo/blob/master/file.ts?plain=1#L1');
});

test('origin parsing: ssh://git@github.com/owner/repo.git', () => {
  const {stdout, status} = runWithOrigin(
    'ssh://git@github.com/example-org/example-repo.git',
    ['file.ts:1', '--branch=master']
  );
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/example-org/example-repo/blob/master/file.ts?plain=1#L1');
});

test('origin parsing: trailing .git is optional', () => {
  const {stdout, status} = runWithOrigin(
    'https://github.com/example-org/example-repo',
    ['file.ts:1', '--branch=master']
  );
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/example-org/example-repo/blob/master/file.ts?plain=1#L1');
});

test('blob: absolute path is normalized even on the -R + --commit shortcut path', () => {
  // Without the fix, this combination skipped the abs-path strip and
  // produced a //-prefixed URL (the same symptom the original fix
  // addressed for the no-shortcut path).
  const absPath = path.join(GIT_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run([`${absPath}:6`, '-R', 'foo/bar', '--commit=abc'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/abc/bin/real-file.ts?plain=1#L6');
});

test('error: absolute path with no local git toplevel exits 2', () => {
  // No-git-repo directory: there's no toplevel to strip, so the script
  // can't determine repo-relative form. Errors out clearly.
  const noGitDir = mkdtempSync(path.join(tmpdir(), 'gh-link-no-git-'));
  try {
    const {status, stderr} = run(
      [`${noGitDir}/file.ts:1`, '-R', 'foo/bar', '--commit=abc'],
      noGitDir
    );
    assert.equal(status, 2);
    assert.match(stderr, /absolute path needs a git repo/);
  } finally {
    rmSync(noGitDir, {recursive: true, force: true});
  }
});

test('blob: absolute path inside a secondary worktree normalizes the same way', () => {
  // Mimics running gh-link from a <repo>/.claude/worktrees/foo-bar/ checkout: the
  // toplevel is the worktree path, the origin is shared with the main repo,
  // and the resulting URL should still be repo-relative (not //-prefixed).
  const absPath = path.join(WORKTREE_SANDBOX, 'bin', 'real-file.ts');
  const {stdout, status} = run([`${absPath}:6`, '--branch=master'], WORKTREE_SANDBOX);
  assert.equal(status, 0);
  assert.equal(stdout, 'https://github.com/foo/bar/blob/master/bin/real-file.ts?plain=1#L6');
});

// ---- core.bare diagnostic ----------------------------------------------


test('bare-marked checkout: names core.bare instead of only "not in a git repo"', () => {
  // `core.bare = true` on a working checkout breaks --show-toplevel while
  // `git log` keeps working, so gh-link's plain "not in a git repo" sends the
  // reader looking for a missing repo rather than a one-line config fix.
  const bareMarked = mkdtempSync(path.join(tmpdir(), 'gh-link-bare-'));
  try {
    const env = hermeticGitEnv();
    execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: bareMarked, env});
    execFileSync('git', ['config', 'core.bare', 'true'], {cwd: bareMarked, env});

    const {stderr, status} = run(['file.ts:1'], bareMarked);
    assert.equal(status, 3);
    assert.match(stderr, /core\.bare = true/);
    assert.match(stderr, /git config core\.bare false/);
  } finally {
    rmSync(bareMarked, {recursive: true, force: true});
  }
});

test('healthy checkout: no core.bare diagnostic', () => {
  // The guard must stay silent on a normal repo — a diagnostic that fires on
  // healthy runs is one people learn to scroll past. Pin the exit status too,
  // so this cannot pass by way of some unrelated failure whose stderr simply
  // happens not to mention core.bare.
  const {stderr, status} = run(['bin/real-file.ts:6', '--branch=master'], GIT_SANDBOX);
  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /core\.bare/);
});
