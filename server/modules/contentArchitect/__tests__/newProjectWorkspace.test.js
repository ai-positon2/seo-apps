// A Content Architect project created from the tool page used to be stored with
// no platform project and no workspace, and access.authorize() lets such a
// record through for anyone signed in. New projects now land in the creator's
// home workspace, and creating one is authorized like creating any project.

const test = require('node:test');
const assert = require('node:assert');
const { workspaceForNewProject } = require('../access');

const req = { user: { userId: 'u1', username: 'a@position2.com' } };

test("a new project goes into the caller's home workspace, authorized for createProject", async () => {
  const calls = [];
  const workspaceId = await workspaceForNewProject(req, {
    resolveIdentity: async () => ({ userId: 'u1', workspaceId: 'ws-home' }),
    requireWorkspace: async (r, id, capability) => { calls.push([id, capability]); return { workspaceId: id }; },
  });
  assert.strictEqual(workspaceId, 'ws-home');
  assert.deepStrictEqual(calls, [['ws-home', 'createProject']]);
});

test('a caller with no workspace cannot create one', async () => {
  await assert.rejects(
    workspaceForNewProject(req, {
      resolveIdentity: async () => ({ userId: 'u1', workspaceId: null }),
      requireWorkspace: async () => ({}),
    }),
    (e) => e.status === 403,
  );
});

test('a refused workspace check stops creation', async () => {
  const denied = Object.assign(new Error('Workspace not found.'), { status: 404 });
  await assert.rejects(
    workspaceForNewProject(req, {
      resolveIdentity: async () => ({ userId: 'u1', workspaceId: 'ws-home' }),
      requireWorkspace: async () => { throw denied; },
    }),
    (e) => e === denied,
  );
});
