// The runner's time limits, checked: this suite never finishes on purpose. A DevTools request that is
// never answered must fail at its own limit with a message naming it, and the suite itself must be
// stopped at its deadline (reported as a pass because it says it expects that), its app's process tree
// stopped, and the run carried on. Runs only when named:
//   node tests/e2e/run.mjs selftest-timeout

export const files = {};
export const timeoutMs = 40000;
export const expectTimeout = true;

export async function run(t) {
  const { c, q, check, area } = t;
  area('requests');
  check('the page answers a request', (await q('1 + 1')) === 2);
  const started = Date.now();
  const outcome = await c.evaluate('new Promise(() => {})', { timeoutMs: 2000 }).then(() => 'answered', (err) => err.message);
  const took = Date.now() - started;
  check('a request never answered fails at its limit, named', /^Runtime\.evaluate: new Promise.* timed out after 2 s$/.test(outcome) && took < 4000, `${outcome} (${took} ms)`);

  area('never finishes');
  // Only the runner's deadline ends this: the request's own limit is far longer than the suite's.
  await c.evaluate('new Promise(() => {})', { timeoutMs: 10 * 60000 });
  check('this line is never reached', false);
}
