const base = projectId => `/api/content-writer/projects/${encodeURIComponent(projectId)}/articles`;
// A proxy or gateway can answer with HTML, so never assume the body parses.
async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await readJson(response);
  if (!response.ok) throw Object.assign(new Error(data?.error || `Request failed (${response.status})`), { status: response.status });
  if (!data) throw Object.assign(new Error('The server returned an unreadable response.'), { status: response.status });
  return data;
}
export const contentWriterApi = {
  list: projectId => request(base(projectId)),
  get: (projectId, id) => request(`${base(projectId)}/${id}`),
  create: (projectId, document) => request(base(projectId), { method: 'POST', body: JSON.stringify(document) }),
  save: (projectId, id, revision, document) => request(`${base(projectId)}/${id}`, { method: 'PUT', body: JSON.stringify({ revision, document }) }),
  async generate(projectId, id, revision, stage, onEvent, signal) {
    const response = await fetch(`${base(projectId)}/${id}/${stage}`, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }), signal });
    if (!response.ok) { const data = await readJson(response); throw new Error(data?.error || `Generation failed (${response.status}).`); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', result = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop();
        for (const event of events) {
          const type = event.match(/^event: (.+)$/m)?.[1];
          const raw = event.match(/^data: (.+)$/m)?.[1];
          if (!type || !raw) continue;
          const data = JSON.parse(raw);
          if (type === 'fail') throw new Error(data.message);
          if (type === 'result') result = data;
          onEvent(type, data);
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
    if (!result) throw new Error('Connection ended before completion. Reopen the article to check whether generation was saved.');
    return result;
  },
};
