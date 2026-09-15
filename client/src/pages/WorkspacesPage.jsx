import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SectionHeader } from '../ui/SectionHeader';
import { setActiveProjectId } from '../lib/activeProject';
import { switchWorkspace } from '../lib/activeWorkspace';
import { projectsApi } from '../lib/projectsApi';

// ── Workspaces ───────────────────────────────────────────────────────────────
//
// This screen shows one relationship, and it is the one the whole app is
// organised around: a workspace HOLDS PROJECTS, and everyone in it can open all
// of them.
//
// It used to show a workspace's members and nothing else, which made a workspace
// look like a contact list. That is how you end up with a workspace named after a
// client that contains none of that client's work: a project is recorded in
// whichever workspace was ACTIVE when it was created, and no screen said so.
//
// So projects are listed first, above people; every card carries its count, so an
// empty workspace is visible without opening it; and the empty state names where
// the projects actually went rather than leaving a blank space to interpret.

async function req(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const countLabel = (n) => (n === 1 ? '1 project' : `${n} projects`);

// The four roles, in the order the permission matrix widens. What each line says
// is the shortest true summary of server/services/projectAccess.js — a picker
// that only names the roles makes the choice a guess.
const ROLE_OPTIONS = [
  { value: 'contributor', label: 'Contributor', hint: 'View, run audits, propose competitors. Can add projects and edit the ones they added.' },
  { value: 'approver', label: 'Approver', hint: 'Everything a contributor can do, plus approve recommendations, override findings and edit any project.' },
  { value: 'admin', label: 'Admin', hint: 'Everything an approver can do, plus manage members, robots overrides and GSC.' },
  { value: 'owner', label: 'Owner', hint: 'Full control, including transferring ownership. Only an owner can grant this.' },
];

const roleHint = (value) => ROLE_OPTIONS.find((r) => r.value === value)?.hint || '';

// Stored rows still say 'member' from before the four roles existed; it means
// contributor. Shown under its real name so two words never describe one role.
const displayRole = (role) => (role === 'member' ? 'contributor' : role);

const selectStyle = {
  padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 13,
};

// One line of membership history, in the words someone would use to describe it.
// "role_changed contributor → admin" is the row; this is the sentence.
function describeMemberEvent(e) {
  const who = e.subjectEmail || 'someone whose account was deleted';
  const by = e.actorEmail ? ` by ${e.actorEmail}` : '';
  switch (e.action) {
    case 'added':
      return `${who} was added as ${displayRole(e.newRole) || 'a member'}${by}`;
    case 'removed':
      return `${who} was removed${by}`;
    case 'ownership_transferred':
      return `${who} was made an owner${by}`;
    case 'role_changed':
      return `${who} changed from ${displayRole(e.oldRole)} to ${displayRole(e.newRole)}${by}`;
    default:
      return `${who}: ${e.action}${by}`;
  }
}

function eventTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
}

function Label({ children }) {
  return (
    <div style={{
      fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'var(--text-3)', fontWeight: 600, marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

/**
 * Why the workspace you are looking at has nothing in it.
 *
 * The unhelpful version of this is "No projects." The useful version says which
 * workspace the work went to instead, because an empty workspace is almost
 * always a surprise rather than an intention.
 */
function emptyProjectsNote(selected, workspaces, activeId) {
  if (selected.id === activeId) {
    return 'Nothing here yet. This workspace is active, so the next project you '
      + 'create will be recorded here.';
  }

  const active = workspaces.find((w) => w.id === activeId);
  // The active workspace is named by the first sentence, so it must not be
  // listed again by the second — "that is currently X. Your work is in X."
  const others = workspaces.filter(
    (w) => w.id !== selected.id && w.id !== activeId && w.projectCount > 0,
  );

  const activeClause = active
    ? `, and that is currently ${active.name}`
      + `${active.projectCount ? ` (${countLabel(active.projectCount)})` : ''}`
    : '';
  const othersClause = others.length
    ? ` You also have work in ${others.map((w) => `${w.name} (${countLabel(w.projectCount)})`).join(', ')}.`
    : '';

  return 'Nothing here yet. A project is recorded in whichever workspace is active '
    + `when you create it${activeClause}.${othersClause}`;
}

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  // Contributor is the default deliberately — the least-privileged role, so
  // adding someone in a hurry grants the least, not the most.
  const [newMemberRole, setNewMemberRole] = useState('contributor');
  const [memberEvents, setMemberEvents] = useState([]);
  // Says what a switch did to the client selection, because it is a change the
  // user did not explicitly ask for and would otherwise only notice later.
  const [banner, setBanner] = useState('');

  function loadList() {
    return req('/api/workspaces').then((d) => {
      setWorkspaces(d.workspaces || []);
      setActiveId(d.activeWorkspaceId || null);
      return d;
    });
  }

  function openWorkspace(id) {
    setError('');
    req(`/api/workspaces/${id}`).then((d) => setSelected(d.workspace)).catch((e) => setError(e.message));
    // Fetched alongside, not behind a click: the question "who else can see
    // this client's work, and who let them in" is the reason to open a
    // workspace, not a detail to go looking for. A failure here leaves the
    // panel empty rather than failing the whole screen.
    setMemberEvents([]);
    req(`/api/workspaces/${id}/member-events`)
      .then((d) => setMemberEvents(d.events || []))
      .catch(() => setMemberEvents([]));
  }

  // The active workspace is the one every NEW project and tool run is recorded
  // against. It does not gate what you can see — /api/projects returns projects
  // from every workspace you belong to — which is why Open below works without
  // switching first.
  // Goes through switchWorkspace() rather than calling /activate directly, so
  // this screen and the header switcher cannot drift apart. It activates the
  // workspace, refreshes the lists, and moves the client selection into the new
  // workspace if it was pointing outside it — previously this only set the
  // cookie, leaving the header naming a client whose work files elsewhere.
  async function handleActivate(id) {
    setError('');
    try {
      const projects = await projectsApi.list().then((d) => d.projects || []).catch(() => []);
      const result = await switchWorkspace(id, projects);
      setActiveId(id);
      if (result.projectChanged) {
        setBanner(result.activeProjectId
          ? 'Switched. The active client moved to one in this workspace.'
          : 'Switched. This workspace has no projects yet, so no client is selected.');
      }
    } catch (e) { setError(e.message); }
  }

  useEffect(() => {
    // Open the active workspace by default rather than showing an empty pane: the
    // first thing worth knowing is what is in the one you are working in.
    loadList()
      .then((d) => {
        const first = (d.workspaces || []).find((w) => w.id === d.activeWorkspaceId)
          || (d.workspaces || [])[0];
        if (first) openWorkspace(first.id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function openProject(projectId) {
    setActiveProjectId(projectId);
    navigate('/');
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError('');
    try {
      await req('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
      setNewName('');
      await loadList();
    } catch (e) { setError(e.message); }
  }

  async function handleAddMember(e) {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!email) return;
    setError('');
    try {
      await req(`/api/workspaces/${selected.id}/members`, {
        method: 'POST', body: JSON.stringify({ email, role: newMemberRole }),
      });
      e.target.reset();
      setNewMemberRole('contributor');
      openWorkspace(selected.id);
    } catch (e) { setError(e.message); }
  }

  // PATCH, not remove-and-re-add: that path drops the membership row and loses
  // added_at, so changing someone's role would erase how long they have had
  // access.
  async function handleChangeRole(userId, role) {
    setError('');
    try {
      await req(`/api/workspaces/${selected.id}/members/${userId}`, {
        method: 'PATCH', body: JSON.stringify({ role }),
      });
      openWorkspace(selected.id);
    } catch (e) { setError(e.message); }
  }

  async function handleRemoveMember(userId) {
    setError('');
    try {
      await req(`/api/workspaces/${selected.id}/members/${userId}`, { method: 'DELETE' });
      openWorkspace(selected.id);
    } catch (e) { setError(e.message); }
  }

  if (loading) return null;

  // The list row carries projectCount; the detail response carries the projects
  // themselves. The empty-state sentence needs both, so it reads from the list.
  const selectedInList = workspaces.find((w) => w.id === selected?.id);
  const projects = selected?.projects || [];

  // Straight from the server's own permission matrix, not re-derived here. The
  // screen used to gate these controls on `myRole === 'owner'`, which hid them
  // from an admin the matrix says may use them.
  const canManageMembers = selected?.capabilities?.manageWorkspaceMembers === true;
  const canAssignOwner = selected?.canAssignOwner === true;

  return (
    <div style={{ padding: '28px 32px 48px' }}>
      <SectionHeader
        title="Workspaces"
        subtitle="A workspace holds projects and the people who can see them. The active workspace is where new projects and tool runs are recorded."
        actions={
          <button
            onClick={() => navigate('/runs')}
            style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-2)', background: 'none',
              border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer',
            }}
          >
            View run history
          </button>
        }
      />

      {error && (
        <div style={{
          fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.10)',
          border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {banner && (
        <div role="status" style={{
          fontSize: 12, color: 'var(--text-2)', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 16,
        }}>
          {banner}
        </div>
      )}

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ width: 300, flexShrink: 0 }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New workspace name"
              style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
            />
            <button type="submit" style={{ padding: '8px 12px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              Create
            </button>
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {workspaces.map((ws) => {
              const isSelected = selected?.id === ws.id;
              return (
                <div
                  key={ws.id}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                    background: isSelected ? 'var(--surface)' : 'var(--card)',
                  }}
                >
                  <button
                    onClick={() => openWorkspace(ws.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {ws.name}
                      {ws.is_personal && (
                        <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500, marginLeft: 6 }}>personal</span>
                      )}
                    </div>

                    {/* The containment fact, on the line where the name is read.
                        An empty workspace should be obvious from the list without
                        opening it — it is the state most likely to be a mistake. */}
                    <div style={{
                      fontSize: 12,
                      color: ws.projectCount ? 'var(--text-2)' : 'var(--text-3)',
                      marginTop: 2,
                    }}>
                      {ws.projectCount ? countLabel(ws.projectCount) : 'No projects'}
                    </div>

                    {/* Was "owner · owner nikhil.ashok@position2.com" — the role
                        printed twice, once for you and once for the workspace. */}
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                      {ws.myRole === 'owner'
                        ? "You're an owner"
                        : `Member · owned by ${ws.ownerEmail || 'unknown'}`}
                    </div>
                  </button>

                  <div style={{ marginTop: 8 }}>
                    {ws.id === activeId ? (
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: 'var(--success)',
                        background: 'var(--success-soft)', borderRadius: 999, padding: '2px 8px',
                      }}>
                        Active — new work lands here
                      </span>
                    ) : (
                      <button
                        onClick={() => handleActivate(ws.id)}
                        style={{
                          fontSize: 11, color: 'var(--text-2)', background: 'none',
                          border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer',
                        }}
                      >
                        Use this workspace
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {!workspaces.length && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No workspaces yet — create one above.</div>
            )}
          </div>
        </div>

        {selected && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, marginBottom: 4,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
                {selected.name}
              </div>
              {selected.id !== activeId && (
                <button
                  onClick={() => handleActivate(selected.id)}
                  style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--text-2)', background: 'none',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                    cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  Use this workspace
                </button>
              )}
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 20, maxWidth: 620 }}>
              Everything a project records — crawls, module runs, recommendations —
              belongs to the workspace that project sits in. Members of this
              workspace can open all of it.
            </div>

            {/* Projects before people: it is what the workspace contains. */}
            <Label>{`Projects in this workspace · ${projects.length}`}</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
              {projects.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    padding: '10px 12px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--card)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {p.name}
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {/* Not filled in with a plausible-looking domain when the
                          project predates project_domains. */}
                      {p.host || 'domain not recorded'}
                    </div>
                  </div>
                  <button
                    onClick={() => openProject(p.id)}
                    style={{
                      fontSize: 12, fontWeight: 600, color: 'var(--text-2)', background: 'none',
                      border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    Open
                  </button>
                </div>
              ))}

              {!projects.length && (
                <div style={{
                  fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5,
                  padding: '12px 14px', borderRadius: 8,
                  border: '1px dashed var(--border)', background: 'var(--card)', maxWidth: 620,
                }}>
                  {emptyProjectsNote(selectedInList || selected, workspaces, activeId)}
                </div>
              )}
            </div>

            <Label>{`People with access · ${selected.members.length}`}</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {selected.members.map((m) => {
                // Granting or revoking ownership stays with owners even though
                // admins may otherwise manage members, so an admin sees the
                // current role as text rather than a picker they cannot use.
                const ownerRow = displayRole(m.role) === 'owner';
                const editable = canManageMembers && (canAssignOwner || !ownerRow);
                return (
                  <div key={m.userId} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 12, padding: '8px 12px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--card)',
                  }}>
                    <div style={{ fontSize: 13, color: 'var(--text)', minWidth: 0 }}>
                      {m.email}
                      {m.userId === selected.viewerUserId && (
                        <span style={{ color: 'var(--text-3)', fontSize: 11 }}> (you)</span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {editable ? (
                        <select
                          id={`role-${m.userId}`}
                          value={displayRole(m.role)}
                          onChange={(e) => handleChangeRole(m.userId, e.target.value)}
                          title={roleHint(displayRole(m.role))}
                          style={{ ...selectStyle, padding: '4px 8px', fontSize: 12 }}
                        >
                          {ROLE_OPTIONS
                            .filter((r) => r.value !== 'owner' || canAssignOwner)
                            .map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                        </select>
                      ) : (
                        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
                          {displayRole(m.role)}
                        </span>
                      )}

                      {canManageMembers && (
                        <button
                          onClick={() => handleRemoveMember(m.userId)}
                          style={{ fontSize: 11, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {canManageMembers && (
              <>
                <form onSubmit={handleAddMember} style={{ display: 'flex', gap: 8, maxWidth: 620, flexWrap: 'wrap' }}>
                  <input
                    name="email"
                    type="email"
                    placeholder="teammate@company.com"
                    style={{ flex: 1, minWidth: 200, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
                  />
                  <select
                    id="new-member-role"
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value)}
                    style={selectStyle}
                  >
                    {ROLE_OPTIONS
                      .filter((r) => r.value !== 'owner' || canAssignOwner)
                      .map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                  </select>
                  <button type="submit" style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    Add member
                  </button>
                </form>

                {/* What the selected role actually grants. A picker that names
                    four roles without saying what they do makes this a guess. */}
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5, maxWidth: 620 }}>
                  {roleHint(newMemberRole)}
                </div>
              </>
            )}

            {/* Says what the invitation actually grants, in terms of this
                workspace's real contents rather than in the abstract. */}
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5, maxWidth: 620 }}>
              {projects.length
                ? `Adding someone gives them ${projects.length === 1 ? 'the project' : `all ${projects.length} projects`} in this workspace.`
                : 'Adding someone gives them every project created in this workspace.'}
              {' '}They must have signed in to the app at least once first.
            </div>

            {/* Access history.
                workspace_member_events has existed since migration 0011 with no
                writer and no reader — every grant and removal of access to a
                client's data went unrecorded. It is written now, and this is
                where it is read. */}
            <div style={{ marginTop: 28, maxWidth: 620 }}>
              <Label>Access history</Label>
              {memberEvents.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {memberEvents.map((e) => (
                    <div
                      key={e.id}
                      style={{
                        display: 'flex', justifyContent: 'space-between', gap: 12,
                        fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5,
                        padding: '6px 0', borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ minWidth: 0 }}>{describeMemberEvent(e)}</span>
                      <span style={{ color: 'var(--text-3)', fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {eventTime(e.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
                  Nothing recorded yet. Membership changes from here on are logged;
                  anything that happened before this workspace started keeping a
                  history is not shown rather than guessed at.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
